/**
 * The browser smoke test.
 *
 * This is the only layer that catches "the canvas renders nothing" - the
 * failure no unit test can see, because every piece can be correct while the
 * thing on screen is a black rectangle. It drives the real demo server, in a
 * real browser, against the sample corpus: load, pan, zoom, both sliders, a
 * search, and no console errors.
 *
 * It is deliberately NOT part of `npm test`. The filename is outside the
 * patterns `node --test` discovers, so the fast suite stays fast and stays
 * dependency-free; run this one on purpose:
 *
 *   npx playwright install chromium   # once
 *   npm run test:e2e
 *
 * In CI it runs from .github/workflows/e2e.yml, which is manual-dispatch only.
 *
 * If Playwright's bundled Chromium is not the one on the machine - a sandbox
 * with its own browsers, a distro package - point BABEL_E2E_CHROMIUM at the
 * binary rather than downloading a second copy.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const artifacts = resolve(repoRoot, 'packages/web/e2e/artifacts');

/** The server bundles the client on boot, so first response takes a moment. */
const BOOT_TIMEOUT = 90_000;

describe('the library, in a browser', { concurrency: false }, () => {
  let server;
  let browser;
  let page;
  let origin;
  const consoleErrors = [];

  before(async () => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;

    server = spawn(
      process.execPath,
      ['packages/server/index.mjs', '--port', String(port), '--images', 'assets/corpus-sample'],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let log = '';
    server.stdout.on('data', (d) => (log += d));
    server.stderr.on('data', (d) => (log += d));
    server.on('exit', (code) => {
      if (code) console.error(`demo server exited with ${code}:\n${log}`);
    });

    await waitFor(
      async () => (await fetch(`${origin}/api/manifest`).catch(() => null))?.ok,
      BOOT_TIMEOUT,
      () => `the demo server never came up:\n${log}`
    );

    browser = await chromium.launch({
      executablePath: process.env.BABEL_E2E_CHROMIUM || undefined,
    });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    // Anything the page complains about is a failure; the map is not supposed
    // to be noisy.
    page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    // Rooms have to be decoded and drawn before any of this means anything.
    await page.waitForFunction(
      () => /[1-9]\d* drawn/.test(document.getElementById('hud')?.textContent ?? ''),
      null,
      { timeout: 30_000 }
    );
  });

  after(async () => {
    // Whatever state the run ended in, keep a picture of it - it is the
    // fastest way to read a failure that happened on a machine you are not at.
    if (page && !page.isClosed()) {
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: resolve(artifacts, 'library.png') }).catch(() => {});
    }
    await browser?.close();
    server?.kill();
  });

  test('the library opens', async () => {
    assert.equal(await page.title(), 'The Indexing of Babel');
    await assert.doesNotReject(page.locator('.panel h1').waitFor({ timeout: 5000 }));
    assert.equal(await page.locator('.panel h1').textContent(), 'The Indexing of Babel');

    const { count } = await (await fetch(`${origin}/api/manifest`)).json();
    assert.match(await page.locator('.panel .sub').textContent(), new RegExp(`offline · ${count} rooms`));

    const h = await hud(page);
    assert.ok(h.cells > 0, 'no cells in view');
    assert.ok(h.drawn > 0, 'nothing drew');
    assert.ok(h.edge > 0, 'the content region has no extent');
  });

  test('the canvas is actually painted, not just present', async () => {
    // The whole reason this test exists. A blank canvas is two flat fills:
    // the page background and the not-yet-loaded cell colour. Real rooms are
    // photographs, so they bring hundreds of distinct colours with them.
    const seen = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const colours = new Set();
      let flat = 0;
      let total = 0;
      // Sample a grid rather than every pixel; a full 2560x1600 readback is
      // 16 MB of string-keyed Set churn for no extra signal.
      for (let y = 0; y < height; y += 8) {
        for (let x = 0; x < width; x += 8) {
          const i = (y * width + x) * 4;
          const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
          colours.add((r << 16) | (g << 8) | b);
          // #0a0908 background and #15120f pending-cell fill.
          if ((r === 0x0a && g === 0x09 && b === 0x08) || (r === 0x15 && g === 0x12 && b === 0x0f)) flat++;
          total++;
        }
      }
      return { colours: colours.size, flatFraction: flat / total, total };
    });

    assert.ok(seen.total > 0, 'the canvas has no backing pixels at all');
    assert.ok(seen.colours > 50, `the canvas looks blank: only ${seen.colours} distinct colours`);
    assert.ok(seen.flatFraction < 0.5, `${Math.round(seen.flatFraction * 100)}% of the view is flat fill`);
  });

  test('dragging pans the map', async () => {
    const before = await hud(page);
    await page.mouse.move(700, 420);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(700 - i * 25, 420 - i * 15);
    await page.mouse.up();

    const after = await hud(page);
    // Dragging left and up moves the camera right and down, and the map is
    // well inside the content region here so it should track roughly 1:1.
    assert.ok(after.x > before.x, `camera x did not move: ${before.x} -> ${after.x}`);
    assert.ok(after.y > before.y, `camera y did not move: ${before.y} -> ${after.y}`);
    assert.equal(after.zoom, before.zoom, 'a drag must not change zoom');
  });

  test('the wheel zooms, and the far-out view holds more cells', async () => {
    const before = await hud(page);

    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 600);
    const out = await settled(page);
    assert.ok(out.zoom < before.zoom, `zoom out did nothing: ${before.zoom} -> ${out.zoom}`);
    assert.ok(out.cells > before.cells, 'zooming out must bring more cells into view');

    await page.mouse.wheel(0, -600);
    const back = await settled(page);
    assert.ok(back.zoom > out.zoom, `zoom in did nothing: ${out.zoom} -> ${back.zoom}`);
    assert.ok(back.cells < out.cells, 'zooming in must leave fewer cells in view');
  });

  test('the pyramid engages: zooming out drops to a coarser level', async () => {
    // The unit tests prove the policy; this proves it is wired to the real
    // canvas against a real corpus with real level directories on disk. Without
    // it the whole pyramid could be selecting levels nothing ever fetches.
    await page.mouse.move(640, 400);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 600);
    const out = await settled(page);

    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -600);
    const inClose = await settled(page);

    assert.ok(
      out.level > inClose.level,
      `far out drew level ${out.level}, close in drew ${inClose.level} - the level never moved`
    );
    assert.ok(
      out.tilePx < inClose.tilePx,
      `the far-out tile (${out.tilePx}px) must be smaller than the close one (${inClose.tilePx}px)`
    );
    // And the cheap level is what a far-out screen is made of, not a fallback
    // to whatever happened to be resident.
    assert.equal(out.blank, 0, 'no cell may be blank at the far-out view');
  });

  test('both sliders re-derive the layout live', async () => {
    // Driven by the keyboard, which is what a range input is for, and avoids
    // reaching into React's value setter from the test.
    const rooms = page.locator('.row', { hasText: 'rooms on the map' }).locator('input[type=range]');
    const ratio = page.locator('.row', { hasText: 'non-generic' }).locator('input[type=range]');

    const start = await hud(page);

    await rooms.focus();
    await rooms.press('Home'); // one room on the map
    const fewest = await settled(page);
    assert.ok(fewest.edge < start.edge, `fewer rooms must pull the edge in: ${start.edge} -> ${fewest.edge}`);

    await rooms.press('End'); // every room back
    const most = await settled(page);
    assert.ok(most.edge > fewest.edge, `more rooms must push the edge out: ${fewest.edge} -> ${most.edge}`);
    assert.ok(Math.abs(most.edge - start.edge) < 1e-9, 'the same corpus size must give the same edge');

    await ratio.focus();
    await ratio.press('Home'); // 2% non-generic
    const sparse = await settled(page);
    assert.ok(sparse.edge > most.edge, `a sparser map must spread out: ${most.edge} -> ${sparse.edge}`);

    // Ending on 100% leaves every visible cell holding a room, which is the
    // state the search test needs to see the library rearrange.
    await ratio.press('End');
    const dense = await settled(page);
    assert.ok(dense.edge < sparse.edge, `a denser map must pack tighter: ${sparse.edge} -> ${dense.edge}`);
    assert.ok(dense.edge < most.edge, 'the whole point of the slider is that it moves the edge');
  });

  test('a search reorders the library and says it is a stub', async () => {
    // Park at the centre and record the view, because a search both moves the
    // camera home AND reorders the rooms. Comparing pixels from two different
    // camera positions would pass on the camera move alone, which is a test
    // that cannot tell a working search from one whose ranking is discarded.
    await page.locator('button', { hasText: 'centre' }).click();
    const parked = await settled(page);
    const before = await fingerprint(page);

    // Wander off, so the fly-home is observable too.
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(400, 250, { steps: 8 });
    await page.mouse.up();
    const wandered = await settled(page);
    assert.notEqual(wandered.x, parked.x, 'the drag did not move the camera');

    await page.locator('input[type=search]').fill('hexagonal galleries');
    await page.locator('input[type=search]').press('Enter');

    // The UI must not imply the ranking means anything.
    await page.waitForFunction(
      () => /stub ranking/.test(document.querySelector('.note')?.textContent ?? ''),
      null,
      { timeout: 10_000 }
    );
    assert.match(await page.locator('.note').textContent(), /no CLIP in offline mode/);

    // A search flies back to the centre, which is the visible half of "the
    // library rearranges around you".
    const home = await settled(page);
    assert.deepEqual(
      { x: home.x, y: home.y, zoom: home.zoom },
      { x: parked.x, y: parked.y, zoom: parked.zoom },
      'a search must return the camera to the centre it started from'
    );

    // Same camera, same slots - so any change in pixels is the rooms moving
    // between those slots, which is the whole mechanic.
    await waitFor(
      async () => (await fingerprint(page)) !== before,
      10_000,
      'the search ranking never reached the map: identical view at an identical camera'
    );
  });

  test('nothing was logged to the console', () => {
    assert.deepEqual(consoleErrors, []);
  });
});

/** Parse the HUD, which is the app's own account of what it just drew. */
async function hud(page) {
  const text = await page.locator('#hud').textContent();
  // `over` is only printed when a screen needs more than the level's cache
  // budget, so it is optional here - but it is parsed rather than skipped,
  // because it is the number that says the view is over its memory budget.
  const m = text.match(
    /^(\d+) cells · (\d+) drawn · level (\d+) \((\d+)px\) · (\d+) substituted · (\d+) blank · (\d+) cached(?: \(\+(\d+) over budget\))? · zoom (\d+) · x (-?[\d.]+) y (-?[\d.]+) · edge at r=([\d.]+)$/
  );
  assert.ok(m, `could not read the hud: ${JSON.stringify(text)}`);
  const [, cells, drawn, level, tilePx, substituted, blank, cached, over, zoom, x, y, edge] = m;
  return {
    cells: +cells, drawn: +drawn, level: +level, tilePx: +tilePx,
    substituted: +substituted, blank: +blank, cached: +cached,
    over: over === undefined ? 0 : +over,
    zoom: +zoom, x: +x, y: +y, edge: +edge,
  };
}

/**
 * A cheap hash of what is on the canvas, for "did this repaint".
 * Sampled on the same grid as the blank-canvas check, and hashed in the page
 * so a multi-megabyte data URL never crosses the wire.
 */
function fingerprint(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let h = 2166136261;
    for (let y = 0; y < height; y += 8)
      for (let x = 0; x < width; x += 8) {
        const i = (y * width + x) * 4;
        h = Math.imul(h ^ ((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]), 16777619);
      }
    return h >>> 0;
  });
}

/** The HUD after the next frame, so a just-issued change is reflected. */
async function settled(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return hud(page);
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(typeof message === 'function' ? message() : message);
}

/** Ask the OS for a port nobody is using, so parallel runs do not collide. */
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}
