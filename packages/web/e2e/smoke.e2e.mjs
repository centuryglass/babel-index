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

/**
 * The first search loads the CLIP text tower server-side - and downloads the
 * model on a machine that has never run it - so the reorder can lag well past a
 * normal request. Only the first search pays this; the window is generous
 * because a cold model load is the slow path, not a hang.
 */
const SEARCH_TIMEOUT = 60_000;

/**
 * The flight duration this server actually resolved, read off the manifest in
 * `before`.
 *
 * Not imported from `camera.js`: that is the shipped default, and
 * `camera.flightMs` is configurable, so a machine with a `config.json` would
 * have this file waiting the wrong amount of time for the camera in front of
 * it. Every timing below is a multiple of whatever the app said.
 *
 * One consequence worth knowing: a local config with `flightMs: 0` turns the
 * animation off, and the flight test below will then correctly report that the
 * camera teleported.
 */
let flightMs;

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

    const { config } = await (await fetch(`${origin}/api/manifest`)).json();
    flightMs = config.camera.flightMs;
    assert.equal(typeof flightMs, 'number', 'the manifest must carry the resolved flight duration');

    browser = await chromium.launch({
      executablePath: process.env.BABEL_E2E_CHROMIUM || undefined,
    });
    // `hasTouch` so the pinch test's CDP touch events become real pointer
    // events. It does not take the mouse away, so the drag and wheel tests are
    // unaffected - a desktop with a touchscreen is an ordinary machine.
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true });

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

  test('the camera flies rather than teleports', async () => {
    // Park at the centre, then zoom well away from the default so "centre" has
    // a long way to travel. Zoom is the axis to watch: it is independent of the
    // content boundary, so nothing seen here can be the glide back inside it.
    await page.locator('button', { hasText: 'centre' }).click();
    await landed(page);
    await page.mouse.move(640, 400);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 600);
    const far = await settled(page);

    // Sampling starts before the click, so it spans the whole flight. A
    // teleport shows two cameras - the one before and the one after - and an
    // eased one shows a frame's worth each; the count is what separates them.
    const sampling = sampleCamera(page, flightMs * 3);
    await page.locator('button', { hasText: 'centre' }).click();
    const seen = await sampling;
    assert.ok(seen.length > 4, `only ${seen.length} distinct cameras: the camera teleported`);

    const home = await landed(page);
    assert.ok(home.zoom > far.zoom, `the flight never restored the zoom: ${far.zoom} -> ${home.zoom}`);
    assert.deepEqual({ x: home.x, y: home.y }, { x: 0.5, y: 0.5 }, 'and it must land at the centre');
  });

  test('a hand on the map interrupts a flight instead of fighting it', async () => {
    // The half that decides whether the map feels like yours. A flight still
    // easing under your hand drags the world out from under the finger holding
    // it, and the zoom is where that is unambiguous: a drag never changes zoom,
    // so any zoom that moves after the grab is the flight refusing to yield.
    await page.locator('button', { hasText: 'centre' }).click();
    const centred = await landed(page);
    await page.mouse.move(640, 400);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 600);
    const low = await settled(page);
    assert.ok(low.zoom < centred.zoom, `the wheel should have zoomed out: ${centred.zoom} -> ${low.zoom}`);

    await page.locator('button', { hasText: 'centre' }).click();
    // Back onto the canvas first: clicking the button left the pointer over the
    // panel, and a press there never reaches the map at all - which looks
    // exactly like a flight that refused to be interrupted.
    await page.mouse.move(640, 400);
    await page.waitForTimeout(flightMs / 3);
    // Grab, then wander past the press slop, so this is a drag rather than a
    // long press - which would otherwise fire while we hold and open a card.
    await page.mouse.down();
    await page.mouse.move(600, 400, { steps: 4 });
    const grabbed = await settled(page);
    assert.ok(
      grabbed.zoom > low.zoom && grabbed.zoom < centred.zoom,
      `the grab did not catch the flight in the air (${low.zoom} -> ${grabbed.zoom} -> ${centred.zoom})`
    );

    await page.waitForTimeout(flightMs);
    const held = await settled(page);
    await page.mouse.up();
    assert.equal(held.zoom, grabbed.zoom, `the flight flew on under the hand: ${grabbed.zoom} -> ${held.zoom}`);

    // The wheel yields the same way and for the same reason: a flight easing
    // its own zoom underneath would fight every notch. Separate line of code
    // from the one above, so separate assertion.
    await page.locator('button', { hasText: 'centre' }).click();
    await page.mouse.move(640, 400);
    await page.waitForTimeout(flightMs / 3);
    await page.mouse.wheel(0, 600);
    const wheeled = await settled(page);
    await page.waitForTimeout(flightMs);
    const after = await settled(page);
    assert.ok(wheeled.zoom < centred.zoom, 'the wheel should have caught the flight in the air');
    assert.equal(after.zoom, wheeled.zoom, `the flight flew on under the wheel: ${wheeled.zoom} -> ${after.zoom}`);
  });

  test('a search reorders the library around the centre', async () => {
    // Park at the centre and record the view, because a search both moves the
    // camera home AND reorders the rooms. Comparing pixels from two different
    // camera positions would pass on the camera move alone, which is a test
    // that cannot tell a working search from one whose ranking is discarded.
    //
    // `landed` rather than `settled`: the camera is flying for ~450ms after the
    // click, and a "parked" camera read mid-flight is a position the search's
    // own flight home would only pass through.
    await page.locator('button', { hasText: 'centre' }).click();
    const parked = await landed(page);
    const before = await fingerprint(page);

    // Wander off, so the fly-home is observable too.
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(400, 250, { steps: 8 });
    await page.mouse.up();
    const wandered = await settled(page);
    assert.notEqual(wandered.x, parked.x, 'the drag did not move the camera');

    // The live field lives on the centre tile, not the panel - wandered this
    // far out it is off screen, so reaching it is itself a flight the search
    // trigger starts. Land that one before typing into what it flew to.
    await page.locator('button.search-trigger').click();
    await landed(page);
    await page.locator('input[type=search]').fill('hexagonal galleries');
    await page.locator('input[type=search]').press('Enter');

    // A search flies back to the centre, which is the visible half of "the
    // library rearranges around you" - and it is the completion signal we can
    // observe without knowing whether a real ranking or the stub answered:
    // the camera only returns home once the response has been applied.
    await waitFor(
      async () => {
        const c = await settled(page);
        return c.x === parked.x && c.y === parked.y && c.zoom === parked.zoom;
      },
      SEARCH_TIMEOUT,
      'the search never flew the camera back to the centre it started from'
    );
    const home = await settled(page);
    assert.deepEqual(
      { x: home.x, y: home.y, zoom: home.zoom },
      { x: parked.x, y: parked.y, zoom: parked.zoom },
      'a search must return the camera to the centre'
    );

    // Same camera, same slots - so any change in pixels is the rooms moving
    // between those slots, which is the whole mechanic.
    await waitFor(
      async () => (await fingerprint(page)) !== before,
      10_000,
      'the search ranking never reached the map: identical view at an identical camera'
    );
  });

  test('right-clicking a room opens its card, and a chip searches for it', async () => {
    // The gesture is the part no unit test can reach: `picking.js` proves what
    // is under a point, but only a browser proves that a right-click reaches it
    // at all, that the card renders, and that the chips are wired to search.
    const card = page.locator('.card');
    await page.mouse.move(640, 400);

    // The map is 100% non-generic by the time this runs, so the centre of the
    // screen is a corpus room - but the centre CELL is reserved, so aim off it.
    // (The reader last returned to the centre at `defaultZoom`, not the fully-in
    // page-load zoom, so rooms around the centre are on screen here.)
    await page.mouse.click(880, 300, { button: 'right' });
    await card.waitFor({ timeout: 5000 });
    assert.match(await card.locator('.card-id').textContent(), /^room \d+/);

    const chips = card.locator('.chip');
    assert.equal(await chips.count(), 3, 'the sample corpus gives every room three keywords');
    const term = await chips.first().textContent();
    assert.ok(await card.locator('.story').textContent(), 'the card shows a story');

    // Escape closes.
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });

    // A chip is a live search: reopen, click one, and the note must report a
    // keyword-driven ranking for the term the chip carried.
    await page.mouse.click(880, 300, { button: 'right' });
    await card.waitFor({ timeout: 5000 });
    await chips.first().click();
    await card.waitFor({ state: 'detached', timeout: 5000 });

    assert.equal(await page.locator('input[type=search]').inputValue(), term);
    await waitFor(
      async () => /ranked by/.test(await page.locator('.note').textContent()),
      SEARCH_TIMEOUT,
      'clicking a keyword chip never produced a ranking'
    );
    assert.match(await page.locator('.note').textContent(), /keywords/);
  });

  test('a long press opens the card, and a drag cancels it', async () => {
    // The interaction that decides whether the map is usable on a phone: a
    // press that becomes a pan must NOT also open a card.
    const card = page.locator('.card');

    await page.mouse.move(880, 300);
    await page.mouse.down();
    await page.waitForTimeout(700); // past the 500ms press threshold
    await page.mouse.up();
    await card.waitFor({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });

    // Same hold, but wandering well past the slop radius first.
    await page.mouse.move(880, 300);
    await page.mouse.down();
    await page.mouse.move(700, 380, { steps: 6 });
    await page.waitForTimeout(700);
    await page.mouse.up();
    assert.equal(await card.count(), 0, 'a press that became a drag must not open a card');
  });

  test('pinching zooms, and two fingers do not fight over the pan', async () => {
    // Playwright's touchscreen is single-touch, so a real pinch has to be
    // dispatched through CDP. It is worth the awkwardness: pinch is the one
    // gesture that cannot be approximated with a mouse, and the multi-pointer
    // bookkeeping it needs is the same code the drag and the long press run on.
    const before = await settled(page);

    await pinch(page, { cx: 640, cy: 400, from: 80, to: 260 });
    const out = await settled(page);
    assert.ok(out.zoom > before.zoom, `spreading must zoom in: ${before.zoom} -> ${out.zoom}`);

    await pinch(page, { cx: 640, cy: 400, from: 260, to: 80 });
    const back = await settled(page);
    assert.ok(back.zoom < out.zoom, `squeezing must zoom out: ${out.zoom} -> ${back.zoom}`);

    // Two fingers held at a fixed distance and slid together are a pan, not a
    // zoom. Before pointers were tracked by id, both fingers fed one drag ref
    // and the map juddered between them.
    const steady = await settled(page);
    await pinch(page, { cx: 640, cy: 400, from: 160, to: 160, slide: { x: 120, y: 0 } });
    const slid = await settled(page);
    assert.equal(slid.zoom, steady.zoom, 'a parallel two-finger slide must not change zoom');
    assert.ok(slid.x < steady.x, `sliding right must move the camera left: ${steady.x} -> ${slid.x}`);
  });

  test('lifting one finger hands the gesture to the other without a lurch', async () => {
    // The gotcha of multi-touch. The remaining finger's next move is measured
    // from wherever the pinch left off unless the drag is re-anchored to where
    // that finger actually is - and the symptom is the map jumping by the width
    // of the gesture at the exact moment a pinch ends, which is constant on a
    // phone and invisible on a desktop.
    const survivor = await pinch(page, { cx: 640, cy: 400, from: 200, to: 220, lift: true });
    const lifted = await settled(page);

    await survivor.move(-200);
    const dragged = await settled(page);
    await survivor.end();

    // The survivor moved 200px left, so the camera moves right by 200px worth
    // of cells - damped a little by the pan resistance, never by a whole
    // gesture's width.
    const expected = 200 / dragged.zoom;
    const actual = dragged.x - lifted.x;
    assert.ok(actual > 0, `the surviving finger must still pan: ${lifted.x} -> ${dragged.x}`);
    assert.ok(
      Math.abs(actual - expected) < expected * 0.5,
      `expected roughly ${expected.toFixed(2)} cells of pan, got ${actual.toFixed(2)} - a lurch`
    );
    assert.equal(dragged.zoom, lifted.zoom, 'one finger must not go on zooming');
  });

  test('a pointer survives capture calls that throw', async () => {
    // `set/releasePointerCapture` throw NotFoundError for a pointer the browser
    // does not consider capturable, which is ordinary on touch - capture is
    // implicit there, and the browser drops it itself at the end of a sequence
    // or when it cancels one. CDP injection keeps the capture state tidy and so
    // never exercises that path; this makes the calls throw on purpose instead.
    //
    // What it protects: an unguarded release aborts the handler before the
    // bookkeeping runs, leaving the finger in the pointer map, after which every
    // gesture is read as a pinch against a finger no longer on the glass. That
    // is a hazard the spec allows rather than one observed in the wild - see the
    // note in useMapCamera.js - but it is cheap to hold shut.
    await page.evaluate(() => {
      const proto = HTMLCanvasElement.prototype;
      window.__capture = {
        set: proto.setPointerCapture,
        release: proto.releasePointerCapture,
      };
      const boom = () => {
        throw new DOMException('no such pointer', 'NotFoundError');
      };
      proto.setPointerCapture = boom;
      proto.releasePointerCapture = boom;
    });

    try {
      const moves = [];
      for (let i = 0; i < 3; i++) {
        // Re-centre first. Pan resistance grows with distance from the origin,
        // so three drags in a row from wherever the last one ended would differ
        // for a reason that has nothing to do with pointer bookkeeping - which
        // is exactly what the first version of this test measured. And the
        // re-centre now flies, so the baseline has to be taken after it lands
        // or the drag is measured partly against the flight.
        await page.locator('button', { hasText: 'centre' }).click();
        const before = await landed(page);
        await touchDrag(page, { from: { x: 900, y: 400 }, to: { x: 700, y: 400 } });
        moves.push((await settled(page)).x - before.x);
      }

      // Every repetition must behave identically. A stranded pointer makes the
      // second gesture a phantom pinch, so it is the drift between them - not
      // any single value - that catches this.
      assert.ok(moves[0] > 0, `the first drag did not pan: ${moves[0]}`);
      for (const m of moves.slice(1))
        assert.ok(
          Math.abs(m - moves[0]) < 1e-6,
          `repeat drags differ (${moves.join(', ')}) - a pointer was stranded`
        );
    } finally {
      await page.evaluate(() => {
        HTMLCanvasElement.prototype.setPointerCapture = window.__capture.set;
        HTMLCanvasElement.prototype.releasePointerCapture = window.__capture.release;
      });
    }
  });

  test('nothing was logged to the console', () => {
    assert.deepEqual(consoleErrors, []);
  });
});

/** A one-finger touch drag, as real touch events. */
async function touchDrag(page, { from, to, steps = 6 }) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const at = (t) => [
    { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id: 1 },
  ];

  await send('touchStart', at(0));
  for (let i = 1; i <= steps; i++) await send('touchMove', at(i / steps));
  await send('touchEnd', at(1));
  await cdp.detach();
}

/**
 * A two-finger pinch, dispatched as real touch events through CDP.
 *
 * Playwright's touchscreen is single-touch, so this is the only way to express
 * the gesture. Two details of `Input.dispatchTouchEvent` are worth writing down,
 * because both are easy to get wrong and fail silently rather than loudly:
 *
 *   - `touchPoints` on a `touchEnd` are the points being RELEASED, not the ones
 *     that remain. Sending the survivor releases the wrong finger.
 *   - points carry an explicit `id`. Without one Chromium matches them by
 *     position, so a move after a release is read as a brand new finger rather
 *     than as the surviving one - which quietly turns the gesture under test
 *     into a different gesture.
 *
 * `from`/`to` are the half-distance between the fingers, so the pair starts
 * `2 * from` apart and ends `2 * to` apart; `slide` moves the midpoint while
 * they do it, which is how a pinch-pan is expressed. `lift` leaves the second
 * finger down at the end instead of releasing both, and returns a handle for
 * driving it - which is what exercises the re-anchor on dropping to one finger.
 */
async function pinch(page, { cx, cy, from, to, slide = { x: 0, y: 0 }, steps = 12, lift = false }) {
  const cdp = await page.context().newCDPSession(page);
  const at = (half, dx, dy) => [
    { x: cx - half + dx, y: cy + dy, id: 1 },
    { x: cx + half + dx, y: cy + dy, id: 2 },
  ];
  const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });

  await send('touchStart', at(from, 0, 0));
  let last = at(from, 0, 0);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    last = at(from + (to - from) * t, slide.x * t, slide.y * t);
    await send('touchMove', last);
  }

  if (!lift) {
    await send('touchEnd', last);
    await cdp.detach();
    return null;
  }

  // Release only the first finger; the second stays down.
  await send('touchEnd', [last[0]]);
  const survivor = { ...last[1] };
  return {
    move: async (dx, dy = 0) => {
      survivor.x += dx;
      survivor.y += dy;
      await send('touchMove', [survivor]);
    },
    end: async () => {
      await send('touchEnd', [survivor]);
      await cdp.detach();
    },
  };
}

/** Parse the HUD, which is the app's own account of what it just drew. */
async function hud(page) {
  return parseHud(await page.locator('#hud').textContent());
}

/**
 * The parsing half of `hud`, split out so a caller that already holds a
 * confirmed-non-rearranging read (`settled`, below) can parse that exact
 * string rather than fetching a second, later one. Re-fetching there is a
 * real race, not a hypothetical one: between confirming the text is not
 * "rearranging…" and a fresh read moments later, a slow-resolving search (the
 * first one pays for a cold CLIP model load) can start its own rearrangement
 * in the gap, and the second read lands mid-animation, on text this regex
 * cannot parse at all.
 */
function parseHud(text) {
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
  // A rearrangement takes over the HUD while it runs, and reports its own
  // progress rather than the frame's numbers. Waiting it out is what "settled"
  // has to mean now: reading mid-slide would be reading a frame of an animation
  // rather than the state it lands on.
  //
  // The loop is the point. A search starts its rearrangement only once the
  // response has been ranked, so "not rearranging" can be true when it is
  // checked and false two frames later, and reading between those two is how
  // this intermittently caught the HUD mid-animation. Re-check after settling
  // and go round again if one started underneath us.
  const deadline = Date.now() + 30_000;
  for (;;) {
    await page.waitForFunction(
      () => !document.getElementById('hud')?.textContent?.startsWith('rearranging'),
      null,
      { timeout: Math.max(1000, deadline - Date.now()) }
    );
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    );
    const text = await page.locator('#hud').textContent();
    // Parse THIS text, not a freshly re-fetched one - see `parseHud`'s comment.
    if (!text.startsWith('rearranging')) return parseHud(text);
    assert.ok(Date.now() < deadline, 'a rearrangement never finished');
  }
}

/**
 * The HUD once the camera has stopped moving.
 *
 * Two frames were enough while `flyTo` teleported. It now eases over
 * `camera.flightMs`, so anything reading the camera straight after a "centre" click
 * reads one still in the air - and every assertion here that compares a camera
 * before and after some gesture needs the before to be a camera at rest.
 *
 * The clock decides, not stillness: the last frames of a smoothstep move by
 * less than the HUD prints, so "two identical readings" would call it early.
 * Waiting the flight out and then confirming is both.
 */
async function landed(page, timeoutMs = 5000) {
  await page.waitForTimeout(flightMs);
  const deadline = Date.now() + timeoutMs;
  let prev = await settled(page);
  while (Date.now() < deadline) {
    const now = await settled(page);
    if (now.x === prev.x && now.y === prev.y && now.zoom === prev.zoom) return now;
    prev = now;
  }
  throw new Error('the camera never came to rest');
}

/**
 * Every distinct camera the HUD showed over a window, one sample per frame.
 *
 * Start it BEFORE the gesture under test and await it after, so the frames in
 * between are the ones it catches - which is the only way to observe an
 * animation rather than its endpoints.
 */
function sampleCamera(page, ms) {
  return page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const seen = [];
        const t0 = performance.now();
        const tick = () => {
          const m = /· zoom (\d+) · x (-?[\d.]+) y (-?[\d.]+)/.exec(
            document.getElementById('hud')?.textContent ?? ''
          );
          const at = m && `${m[1]}/${m[2]}/${m[3]}`;
          if (at && at !== seen[seen.length - 1]) seen.push(at);
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve(seen);
        };
        requestAnimationFrame(tick);
      }),
    ms
  );
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
