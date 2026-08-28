/**
 * Shared harness for the browser smoke suite, split across this directory's
 * `*.e2e.mjs` files (see `docs/implementation-plan.md`'s note on why - one
 * 2440-line file sharing one `page` meant a single stranded piece of state
 * turned one failure into several unrelated ones).
 *
 * Each `*.e2e.mjs` file keeps the original design of ONE shared `page` across
 * ITS OWN tests (real gesture state, camera position and cache warmth are
 * cheaper to carry forward than to rebuild every test), but no longer across
 * the whole suite: every file calls `openLibrary()` in its own `before` and
 * `closeLibrary()` in its own `after`, so a failure in one file cannot strand
 * state for a file it has nothing to do with. That does mean each file pays
 * its own server boot and browser launch - worth it for the isolation, and
 * `node --test` runs files in parallel processes by default anyway.
 *
 * This module is deliberately not itself a test file (no `.e2e.mjs` suffix,
 * no `describe`/`test`), so `node --test`'s glob never picks it up.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const artifacts = resolve(repoRoot, 'packages/web/e2e/artifacts');

/** The server bundles the client on boot, so first response takes a moment. */
export const BOOT_TIMEOUT = 90_000;

/**
 * The first search loads the CLIP text tower server-side - and downloads the
 * model on a machine that has never run it - so the reorder can lag well past a
 * normal request. Only the first search pays this; the window is generous
 * because a cold model load is the slow path, not a hang.
 */
export const SEARCH_TIMEOUT = 60_000;

/** Ask the OS for a port nobody is using, so parallel runs do not collide. */
export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

export async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(typeof message === 'function' ? message() : message);
}

/**
 * Boot the demo server against the sample corpus and open it in a real
 * Chromium tab, `?debug` and all. Returns everything a file's `before` needs:
 * the live `page`/`browser`/`server` handles to close later, `origin` for
 * direct API calls, `flightMs` read off the manifest (see the note on why
 * this is never hard-coded), `roomCount` for the catalog's "every room once"
 * assertion, and a `consoleErrors` array a file's own "nothing was logged to
 * the console" test reads at the end.
 */
export async function openLibrary() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;

  const server = spawn(
    process.execPath,
    [
      '--import',
      './build/register.mjs',
      'packages/server/index.ts',
      '--port',
      String(port),
      '--images',
      'assets/corpus-sample',
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  server.on('exit', (code) => {
    if (code) console.error(`demo server exited with ${code}:\n${log}`);
  });

  // Everything past here can throw - a launch failure, a page that never
  // draws - and each split file pays for its own server, so a setup failure
  // is five times as likely to happen somewhere in the suite as it was when
  // this was one file. Without the catch, a thrown error here leaves the
  // server running with nothing left holding a reference to kill it; a
  // spawned child keeps the worker process's event loop alive even after
  // node:test has given up on the file, so the whole run hangs until an
  // external timeout kills it instead of failing this file fast.
  let browser;
  try {
    await waitFor(
      async () => (await fetch(`${origin}/api/manifest`).catch(() => null))?.ok,
      BOOT_TIMEOUT,
      () => `the demo server never came up:\n${log}`
    );

    const { config, count } = await (await fetch(`${origin}/api/manifest`)).json();
    const flightMs = config.camera.flightMs;
    // Read off the manifest rather than pinned, so the catalog's "every room
    // once" assertion survives someone adding an image to the sample corpus.
    const roomCount = count;
    assert.equal(typeof flightMs, 'number', 'the manifest must carry the resolved flight duration');

    browser = await chromium.launch({
      executablePath: process.env.BABEL_E2E_CHROMIUM || undefined,
    });
    // `hasTouch` so the pinch test's CDP touch events become real pointer
    // events. It does not take the mouse away, so the drag and wheel tests are
    // unaffected - a desktop with a touchscreen is an ordinary machine.
    //
    // An explicit context rather than `browser.newPage()`, which makes one
    // implicitly: axe refuses to run against a page whose context it did not
    // see created, and the accessibility sweeps in this suite are the whole
    // reason it can claim anything about the parts of the app nobody looks at.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      hasTouch: true,
    });
    const page = await context.newPage();

    // Anything the page complains about is a failure; the map is not supposed
    // to be noisy.
    const consoleErrors = [];
    page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    // `?debug` mounts the dev panel and the cache/rearrangement HUD - both now
    // gated off by default (see `debug.js`), and this suite leans on them
    // throughout as its settling signal and its window into cache/level state.
    await page.goto(`${origin}?debug`, { waitUntil: 'domcontentloaded' });
    // Rooms have to be decoded and drawn before any of this means anything.
    await page.waitForFunction(
      () => /[1-9]\d* drawn/.test(document.getElementById('hud')?.textContent ?? ''),
      null,
      { timeout: 30_000 }
    );

    return { server, browser, page, origin, flightMs, roomCount, consoleErrors };
  } catch (err) {
    await browser?.close().catch(() => {});
    server.kill();
    throw err;
  }
}

/**
 * Tear down a session `openLibrary()` returned. `screenshotName` should be
 * unique per file (e.g. `library-catalog.png`) - files can run as parallel
 * processes, and two of them writing `library.png` at once is a race.
 */
export async function closeLibrary(session, screenshotName) {
  // `session` is undefined when `openLibrary()` itself threw - it already
  // cleaned up after itself in that case (see the try/catch there), so
  // there is nothing left to close here.
  if (!session) return;
  const { page, browser, server } = session;
  // Whatever state the run ended in, keep a picture of it - it is the
  // fastest way to read a failure that happened on a machine you are not at.
  if (page && !page.isClosed()) {
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: resolve(artifacts, screenshotName) }).catch(() => {});
  }
  await browser?.close();
  server?.kill();
}

/** Parse the HUD, which is the app's own account of what it just drew. */
export async function hud(page) {
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
export function parseHud(text) {
  // `over` is only printed when a screen needs more than the level's cache
  // budget, and `clustered` only when a search's density gradient actually
  // lifted some ranks above the baseline (`layout.gradedCount > 0` - main.jsx)
  // - both optional here, but parsed rather than skipped, because both are
  // numbers a test might need.
  const m = text.match(
    /^(\d+) cells · (\d+) drawn · level (\d+) \((\d+)px\) · (\d+) substituted · (\d+) blank · (\d+) cached(?: \(\+(\d+) over budget\))? · zoom (\d+) · x (-?[\d.]+) y (-?[\d.]+) · edge at r=([\d.]+)(?: · (\d+) clustered)?$/
  );
  assert.ok(m, `could not read the hud: ${JSON.stringify(text)}`);
  const [, cells, drawn, level, tilePx, substituted, blank, cached, over, zoom, x, y, edge, clustered] = m;
  return {
    cells: +cells, drawn: +drawn, level: +level, tilePx: +tilePx,
    substituted: +substituted, blank: +blank, cached: +cached,
    over: over === undefined ? 0 : +over,
    zoom: +zoom, x: +x, y: +y, edge: +edge,
    clustered: clustered === undefined ? 0 : +clustered,
  };
}

/**
 * A cheap hash of what is on the canvas, for "did this repaint".
 * Sampled on the same grid as the blank-canvas check, and hashed in the page
 * so a multi-megabyte data URL never crosses the wire.
 */
export function fingerprint(page) {
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
export async function settled(page) {
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
 * `camera.flightMs`, so anything reading the camera straight after a "center" click
 * reads one still in the air - and every assertion here that compares a camera
 * before and after some gesture needs the before to be a camera at rest.
 *
 * The clock decides, not stillness: the last frames of a smoothstep move by
 * less than the HUD prints, so "two identical readings" would call it early.
 * Waiting the flight out and then confirming is both. Takes `flightMs`
 * explicitly rather than importing a default, because it is a fact of the
 * server this file's `before` just booted, not of the client.
 */
export async function landed(page, flightMs, timeoutMs = 5000) {
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
export function sampleCamera(page, ms) {
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

/**
 * The accessibility tree as the browser actually computed it.
 *
 * Not `page.accessibility` - that API is gone as of Playwright 1.51 - and not
 * the attributes themselves, which would only restate the source. An accessible
 * name is computed from labels, roles, `aria-labelledby` and content together,
 * so the only way to know it landed is to read it back out of the tree the
 * screen reader would be handed. CDP is the one route that exposes the computed
 * properties alongside the name; `locator.ariaSnapshot()` reports a slider's
 * raw value and not the text that replaces it.
 *
 * Chromium-only, which is what this suite runs.
 */
export async function axNodes(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  await cdp.detach();
  return nodes.map((n) => ({
    role: n.role?.value,
    name: n.name?.value ?? '',
    // Carried for the failure dumps rather than for any assertion: a control's
    // value reaches CDP through both the node's own `value` and a `valuetext`
    // property, and knowing which one held what is how the Chrome 151
    // `aria-valuetext` difference got diagnosed.
    value: n.value?.value,
    props: Object.fromEntries((n.properties ?? []).map((x) => [x.name, x.value?.value])),
  }));
}

/** The one node with this role whose accessible name matches, or undefined. */
export const axFind = (nodes, role, name) =>
  nodes.find((n) => n.role === role && name.test(n.name));

/** A one-finger touch drag, as real touch events. */
export async function touchDrag(page, { from, to, steps = 6 }) {
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
export async function pinch(page, { cx, cy, from, to, slide = { x: 0, y: 0 }, steps = 12, lift = false }) {
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
