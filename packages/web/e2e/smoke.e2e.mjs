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
 * In CI it runs from .github/workflows/e2e.yml, which `ci.yml` now calls as a
 * reusable workflow - so this suite is a MERGE GATE, and a test in here that is
 * timing-dependent rather than state-dependent blocks everyone. Wait on a
 * condition, never on a duration.
 *
 * The accessibility block asserts what only a browser can compute: an
 * accessible name comes from labels, roles and content together, so checking
 * the JSX would only restate the source. Those tests read the real tree back
 * out - `axNodes` for Chromium's computed properties, axe for the broad sweep.
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
import AxeBuilder from '@axe-core/playwright';

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
let roomCount = 0;

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

    const { config, count } = await (await fetch(`${origin}/api/manifest`)).json();
    flightMs = config.camera.flightMs;
    // Read off the manifest rather than pinned, so the catalog's "every room
    // once" assertion survives someone adding an image to the sample corpus.
    roomCount = count;
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
    // see created, and the accessibility sweep below is the whole reason this
    // suite can claim anything about the parts of the app nobody looks at.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      hasTouch: true,
    });
    page = await context.newPage();

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
    // `settled()` waits out a rearrangement and two frames, which covers the
    // camera but NOT a tile that has not finished decoding - so a far-out
    // screen can be settled and still be a cell or two short for a frame or
    // two. `blank === 0` is a condition, and waiting a fixed number of frames
    // for it is what made this flake (~1 run in 5 on a slow machine). Poll it
    // instead, bounded, so a cell that never arrives still fails the assertion
    // below rather than hanging.
    let out = await settled(page);
    for (const until = Date.now() + 5000; out.blank > 0 && Date.now() < until; )
      out = await settled(page);

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
    // The live region, not `.note`. There is now one region for the whole app
    // and it lives outside both views - the panel is part of the MAP, and a
    // region inside it would be unmounted on every switch to the catalog, which
    // is how a screen reader loses one. `.note` keeps only the static hint.
    await waitFor(
      async () => /ranked by/.test(await page.locator('[role=status]').textContent()),
      SEARCH_TIMEOUT,
      'clicking a keyword chip never produced a ranking'
    );
    assert.match(await page.locator('[role=status]').textContent(), /keywords/);
  });

  // --- accessibility (docs/accessibility-plan.md phase A/B) --------------------
  //
  // These are exactly the assertions no unit test can make: an accessible name
  // is what the BROWSER computes from labels, roles and attributes together, so
  // asserting on the JSX would only restate the source. Reading them back out
  // of the real accessibility tree is the only way to know they landed.

  test('axe finds no WCAG violations on the opening view', async () => {
    // The broad net under the specific assertions below. Those say what this
    // app in particular must do; this one catches the whole class of ordinary
    // mistake - an unlabelled control, a bad contrast ratio, a role with a
    // required attribute missing - in the parts of the page nobody is looking
    // at, which is exactly where accessibility work rots.
    //
    // It is not a substitute for the named tests: axe cannot know that the
    // rooms slider ought to say what its number counts, only that it has a
    // name at all.
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const summary = violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.help}`);
    assert.deepEqual(summary, [], `axe reported violations:\n  ${summary.join('\n  ')}`);
  });

  test('the ranked listbox is honestly counted, reachable with no arrow keys, and axe-clean', async () => {
    // The "non-generic" slider was driven to 100% by an earlier test (so a
    // right-click reliably lands on a room) and is still there. At 100% the
    // density gradient CANNOT show a cluster - `gradedCount` counts ranks the
    // gradient lifts ABOVE the baseline, and there is no "above" left when the
    // baseline already is the maximum. That is not a bug in the listbox; it is
    // what a maxed ratio means, and this test would otherwise time out waiting
    // for a listbox a correct app is right not to show. Pull it back down so a
    // cluster can exist at all.
    const ratio = page.locator('.row', { hasText: 'non-generic' }).locator('input[type=range]');
    await ratio.focus();
    await ratio.press('Home');

    // try/finally, not just a trailing restore at the end of the test: several
    // tests after this one - long-press, pinch, capture-throw - rely on the
    // map being dense, so an assertion failing partway through must not ALSO
    // strand the ratio slider sparse for everything that runs afterward. That
    // turns one failure into an unrelated-looking cascade, which is exactly
    // what made a flake here harder to diagnose than it needed to be.
    try {
      // "brass" is a confirmed hit in the sample corpus's own metadata - see
      // the keyword chips test above, which reads real keywords off a real
      // card. Anything that finds zero matches would test the empty state
      // instead of this one, so a query known to match is not a convenience,
      // it is the point.
      await page.locator('button.search-trigger').click();
      await landed(page);
      await page.locator('input[type=search]').fill('brass');
      await page.locator('input[type=search]').press('Enter');

      const results = page.locator('.results-list');
      await results.waitFor({ timeout: SEARCH_TIMEOUT });

      // The first search's ranking can change again shortly after it first
      // appears - CLIP embeddings load asynchronously and can re-rank a
      // keyword/story-only result (see SEARCH_TIMEOUT's own comment on why
      // the first search is slow) - so `.results-list` existing is not the
      // same claim as "the search is done." Poll for the mounted count to
      // hold steady across two reads before trusting it; found by this test
      // failing intermittently, once on a run that also happened to send the
      // search-trigger flight to the far-zoomed opening view rather than
      // simply focusing the field, which is circumstantial evidence for
      // "still settling," not proof, but the poll costs nothing either way.
      const options = results.locator('.result');
      let previousCount = null;
      let count;
      // `previousCount` starts at `null`, which cannot equal a real count, so
      // this always waits out at least one real 200ms gap (`waitFor`'s own
      // poll interval) between two AGREEING reads before trusting one - not
      // just two reads taken back to back with nothing between them, which
      // would prove nothing about whether it had actually settled.
      await waitFor(
        async () => {
          count = await options.count();
          const stable = count === previousCount;
          previousCount = count;
          return stable;
        },
        SEARCH_TIMEOUT,
        'the results list never stopped changing count'
      );
      assert.ok(count > 0, 'a query with a known match must produce at least one result');

      const label = await page.locator('#results-label').textContent();
      const first = results.locator('li').first();
      const posinset = await first.getAttribute('aria-posinset');
      const setsize = await first.getAttribute('aria-setsize');

      // The label reports the TRUE match count, not just what got mounted -
      // that is the whole point of windowing rather than silently truncating.
      assert.match(label, /results\s+\d+/, `the results label must report a count, got ${JSON.stringify(label)}`);

      // `aria-setsize`/`aria-posinset` go on the `<li>` rather than the button
      // because only `listitem` supports them - a bare `button` does not, and
      // axe's `aria-allowed-attr` rule would catch that placement mistake. But
      // Chrome's CDP `Accessibility.getFullAXTree` does not surface either
      // property for a native `<li>` at all - confirmed by dumping a node in
      // full rather than guessing from an empty read - so this can only check
      // that the DOM carries the values, not that a real screen reader's
      // platform API receives them the way it receives the button's name
      // checked below. Left as an open question in accessibility-plan.md
      // rather than a claim this test does not back up.
      assert.equal(posinset, '1');
      assert.ok(Number(setsize) >= count, `setsize ${setsize} must be at least the ${count} mounted`);

      // The BUTTON is what carries the name a reader hears - `listitem` has
      // no "name from contents" in the accessible-name algorithm, so the
      // `<li>` wrapping it is correctly nameless in the tree; only its child
      // speaks. Checked last, since it is the slow CDP round trip and nothing
      // after it depends on the count/setsize/label read above staying in
      // sync with it.
      const nodes = await axNodes(page);
      assert.ok(axFind(nodes, 'button', /^Room \d+/), 'a result button must be named by its room');

      // No arrow keys anywhere in this flow - Tab is the whole story, which
      // is the reason this phase ships before the map's keyboard interface (§5).
      await options.first().focus();
      await page.keyboard.press('Enter');

      const card = page.locator('.card');
      await card.waitFor({ timeout: 5000 });
      const cardText = await card.locator('.card-id').textContent();
      const firstResultText = await options.first().textContent();
      assert.ok(
        firstResultText.startsWith(cardText.split(' · ')[0].replace(/^room/i, 'Room')),
        `the opened card must be the room the result named: ${JSON.stringify({ firstResultText, cardText })}`
      );

      // And the whole thing - search active, listbox populated, card open -
      // is still clean. The opening-view sweep above cannot see any of this;
      // it ran before a search existed.
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const summary = violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.help}`);
      assert.deepEqual(summary, [], `axe reported violations with a search active:\n  ${summary.join('\n  ')}`);

      await page.keyboard.press('Escape');
      await card.waitFor({ state: 'detached', timeout: 5000 });
    } finally {
      // Restores the RATIO and the CAMERA, not just the ratio. A search that
      // finds the field off screen flies to the far-zoomed `opening` view
      // (fitted tight on the centre tile) rather than simply focusing it; an
      // assertion failing before this test flies anywhere else left the
      // camera there once, and a right-click at a fixed screen point in a
      // LATER test landed on the centre tile's own controls instead of a room
      // - one test's failure taking down an unrelated one's precondition,
      // which is worse than the original failure. Clicking "centre" is cheap
      // and makes every subsequent test's assumption ("a dense map, framed
      // normally") true regardless of how far this one got.
      await ratio.press('End');
      await page.getByRole('button', { name: 'centre' }).click();
      await landed(page);
    }
  });

  test('the panel controls carry accessible names, and the sliders say what they count', async () => {
    const nodes = await axNodes(page);

    // Both labels used to be SIBLINGS of their input with no `htmlFor`, so both
    // sliders reached the reader as a bare number with no indication of what it
    // measured.
    const rooms = axFind(nodes, 'slider', /rooms on the map/i);
    const ratio = axFind(nodes, 'slider', /non-generic/i);
    assert.ok(rooms, 'the rooms slider must have an accessible name');
    assert.ok(ratio, 'the ratio slider must have an accessible name');

    // Having a name is only half of it: a range announces its raw number, which
    // is the one thing about it nobody was wondering about. The units have to
    // reach the reader THROUGH THE NAME, which is why this asserts on `name`
    // and not on `aria-valuetext`: that attribute is honoured by chromium 1194
    // and ignored by Chrome 151 on a native `input[type=range]`, so a test that
    // reads it back is testing the browser. This still catches the bug the test
    // was written for - a label with no `htmlFor` leaves no name to match at
    // all - and now also catches a label that says only a bare number.
    //
    // Both sliders are checked before either is asserted, and the failure
    // carries the whole node: "expected /%/, got 26" cost a CI round trip once
    // because it could not distinguish a missing attribute from an ignored one.
    const said = [
      ['rooms', rooms, /\d+ of \d+/],
      ['ratio', ratio, /\d+%/],
    ];
    const mute = said.filter(([, node, want]) => !want.test(node.name));
    assert.equal(
      mute.length, 0,
      `${mute.map(([which]) => which).join(' and ')} must say what they count, not just a number:\n`
        + JSON.stringify({ rooms, ratio }, null, 2)
    );

    assert.ok(axFind(nodes, 'button', /search the library/i), 'the search trigger must be named');
  });

  test('the page may be zoomed', async () => {
    // Blocking page zoom is a WCAG 1.4.4 failure, and the attributes that did
    // it here are easy to reintroduce by reflex the next time a touch gesture
    // misbehaves on iOS. Asserted so that reflex fails loudly.
    const viewport = await page.locator('meta[name=viewport]').getAttribute('content');
    assert.doesNotMatch(viewport, /user-scalable\s*=\s*no/, 'page zoom must not be disabled');
    assert.doesNotMatch(viewport, /maximum-scale/, 'page zoom must not be capped');
  });

  test('the canvas is a named application region, not an anonymous graphic', async () => {
    // Superseded by phase C: the canvas WAS `role="img"` with a static label,
    // a placeholder for the picture nobody could yet navigate. Now it is the
    // cursor's own `role="application"` region, named by whatever cell is
    // currently under the camera centre.
    //
    // Named by WHICHEVER cell that is, and this test deliberately does not
    // move the camera to make it a known one. The rearrangement announcement
    // (§8 item 4) means a search moves the cursor as well as the map, so a
    // listbox jump earlier in this suite can leave it on a room rather than
    // the centre - and flying home to pin the name down would wipe the live
    // region the announcement test after this one reads. What must hold here
    // is the role and that the name is a real cell's, which is exactly what
    // an unlabelled graphic or a static placeholder would fail.
    const named = page.getByRole('application', {
      name: /the centre of the library|Room \d+, rank \d+ of \d+|a blank wall|the far field/i,
    });
    await named.waitFor({ timeout: 5000 });
    assert.equal(await named.count(), 1, 'exactly one application region, and it is the map');
  });

  test('the card takes focus, is named by its room, and Escape gives focus back', async () => {
    const card = page.locator('.card');

    await page.mouse.click(880, 300, { button: 'right' });
    await card.waitFor({ timeout: 5000 });

    // Focus moves in - otherwise a keyboard user is told a dialog opened and
    // has no way to reach a word of it.
    assert.ok(
      await page.evaluate(() => document.activeElement?.classList.contains('card')),
      'the card must take focus when it opens'
    );

    // And it is named by the room it describes. "room" - what it used to
    // announce - is the one fact the reader already had.
    //
    // Matched case-insensitively on purpose: `.card-id` is styled
    // `text-transform: uppercase`, and Chrome folds that INTO the computed
    // accessible name, so the reader is handed "ROOM 21 · 022.JPG" rather than
    // the DOM's own "room 21 · 022.jpg". Harmless for a word that is still
    // pronounceable, worth knowing before naming anything after an acronym, and
    // it goes away when the card takes its label from `describeCell` (phase B)
    // rather than from a visually-transformed node.
    const dialog = axFind(await axNodes(page), 'dialog', /^room \d+/i);
    assert.ok(dialog, 'the card must be named by the room it describes');

    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });

    // And focus is not stranded on the node that just left the document, which
    // is the way this breaks: focus on a detached element belongs to nothing,
    // Tab restarts from the top, and a screen reader is left describing a card
    // that is no longer there.
    //
    // What is NOT asserted here, because it is not yet true: returning focus to
    // whatever opened the card. Right-clicking the canvas blurs the focused
    // control to the body before the card ever mounts, so a pointer-opened card
    // has no opener to go back to. `RoomCard` restores when there is one, and
    // the path that gives it one is Enter on the map cursor (phase C). Assert
    // it there, where it can actually fail.
    assert.ok(
      await page.evaluate(() => document.activeElement?.isConnected ?? false),
      'focus must not be left on a detached node'
    );
  });

  test('what the map just did is announced politely', async () => {
    // The status text already existed and already said the right thing; it
    // simply updated a div nothing was listening to. The hint must stay OUT of
    // the live region - a node that falls back to the instructions would read
    // them aloud again every time a status cleared.
    const live = page.locator('[role=status]');
    await live.waitFor({ timeout: 5000 });
    await waitFor(
      async () => /ranked by/.test((await live.textContent()) ?? ''),
      SEARCH_TIMEOUT,
      'the live region never carried the result of the search'
    );
    assert.doesNotMatch(await live.textContent(), /drag to pan/, 'the hint must not be announced');
  });

  test('reduced motion rebuilds the library instead of sliding it', async () => {
    // Asserted through the CAMERA rather than by watching for the absence of an
    // animation, which would be a race dressed up as a test. A normal
    // rearrangement parks the camera on the centre first, because the slide is
    // planned against exactly the cells on screen. Reduced motion bails out
    // before that flight - there is no animation to set up, and moving someone's
    // camera unasked is the very thing they turned off - so the giveaway is a
    // camera that did not move at all.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    try {
      // Somewhere clearly not the centre, so "did not move" is unambiguous.
      await page.mouse.move(700, 420);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(700 - i * 25, 420 - i * 15);
      await page.mouse.up();
      const before = await settled(page);
      assert.ok(
        Math.abs(before.x) > 0.2 || Math.abs(before.y) > 0.2,
        `the drag must leave the centre, got (${before.x}, ${before.y})`
      );

      // "rescatter", not "reorder", and the difference is load-bearing: a
      // search is still active by the time this runs, and `order` is then
      // `result.order` - the same array by reference no matter how often
      // `orderSeed` is bumped - so the render effect's deps never change and
      // "reorder" rearranges nothing at all. Rescatter bumps the layout seed,
      // which rebuilds `layout` and always triggers a rearrangement. Written
      // down because this test passed against a deliberately broken app until
      // the button was swapped.
      await page.getByRole('button', { name: 'rescatter' }).click();
      const after = await settled(page);

      assert.ok(
        Math.abs(after.x - before.x) < 1e-6 && Math.abs(after.y - before.y) < 1e-6,
        `reduced motion must not fly the camera home: (${before.x}, ${before.y}) -> (${after.x}, ${after.y})`
      );
      assert.ok(
        Math.abs(after.zoom - before.zoom) < 1e-6,
        `reduced motion must not change the zoom: ${before.zoom} -> ${after.zoom}`
      );
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }

    // Put the reader back on the centre for whatever runs next.
    await page.getByRole('button', { name: 'centre' }).click();
    await landed(page);
  });

  test('keyboard focus is visible', async () => {
    // The search fields used to say `outline: none` and lean on a border-colour
    // shift. Reading the computed outline back is the only way to catch that
    // returning, since it looks perfectly reasonable in the stylesheet.
    // Focus has to arrive by KEYBOARD. `:focus-visible` follows the most recent
    // input modality, so an `el.focus()` from the test inherits the mouse click
    // that came before it and correctly shows no ring - which would fail this
    // test for a reason that has nothing to do with the stylesheet. Click
    // something unfocusable to park focus on the body, then Tab.
    await page.locator('.panel h1').click();
    await page.keyboard.press('Tab');

    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      const { outlineStyle, outlineWidth } = getComputedStyle(el);
      return { tag: el.tagName, cls: el.className, outlineStyle, outlineWidth };
    });
    assert.notEqual(ring.tag, 'BODY', 'Tab must reach a control');
    assert.notEqual(ring.outlineStyle, 'none', `a keyboard-focused ${ring.tag} must show an outline`);
    assert.ok(parseFloat(ring.outlineWidth) >= 2, `the focus ring must be visible, got ${ring.outlineWidth}`);
  });

  // --- the keyboard cursor (docs/accessibility-plan.md phase C) --------------
  //
  // The map's own keyboard interface: `role="application"` on the canvas turns
  // off a screen reader's browse-mode reading for exactly this element, which
  // is what lets arrow keys reach the page at all rather than being consumed
  // by the reader's own navigation. None of that can be asserted from JSX -
  // only a real browser resolves whether a role actually changes what a key
  // press does.

  test('the map is reachable, and the sample corpus is small enough to have a real edge', async () => {
    // The 26-room sample corpus gives a `boundaryRadius` of only a few cells
    // even fully dense - discovered while driving this by hand, not designed
    // in - which is what makes the boundary-crossing test below reachable in
    // a handful of presses rather than needing a huge synthetic corpus.
    const ratio = page.locator('.row', { hasText: 'non-generic' }).locator('input[type=range]');
    await ratio.focus();
    await ratio.press('End');

    await page.locator('canvas').focus();
    // Home for the same reason as the application-region test above: the
    // cursor follows a rearrangement now, not only a keypress, so where the
    // previous tests left it is not a precondition to lean on.
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);
    await assert.doesNotReject(
      page.getByRole('application', { name: /centre of the library/i }).waitFor({ timeout: 2000 })
    );
  });

  test('arrows pan the cursor and announce it; ctrl+arrow always lands on a room', async () => {
    const canvas = page.locator('canvas');
    const live = page.locator('[role=status]');

    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);
    const home = await hud(page);

    await page.keyboard.press('ArrowRight');
    await waitFor(
      async () => (await hud(page)).x !== home.x,
      2000,
      'an arrow press must move the camera by exactly one cell'
    );
    const afterOneStep = await hud(page);
    assert.ok(
      Math.abs(afterOneStep.x - home.x - 1) < 1e-6,
      `one arrow press must move exactly one cell: ${home.x} -> ${afterOneStep.x}`
    );
    await waitFor(
      async () => /Room \d+|blank wall/.test((await live.textContent()) ?? ''),
      2000,
      'an arrow press must announce something about the new cursor cell'
    );

    // Ctrl+arrow's whole point: whatever it lands on, if it finds anything at
    // all, is a real room - never the wallpaper a plain arrow could have just
    // as easily landed on. That is the one thing worth asserting without
    // hard-coding a room id or a step count from the sample corpus, both of
    // which would be pinning an art/layout fact this test does not own.
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);
    await page.keyboard.press('Control+ArrowRight');
    await waitFor(
      async () => /^Room \d+|^nothing further/.test((await live.textContent()) ?? ''),
      2000,
      'ctrl+arrow must announce a room or say it found nothing'
    );
    const ctrlArrowText = await live.textContent();
    if (!/^nothing further/.test(ctrlArrowText)) {
      assert.match(ctrlArrowText, /^Room \d+/, 'ctrl+arrow must never land announcing a blank wall');
      // And it must actually have MOVED the camera - a room announcement
      // without a matching jump would mean the text and the map disagree.
      await waitFor(async () => (await hud(page)).x !== home.x, 2000, 'ctrl+arrow never moved the camera');
    }
  });

  test('the boundary is announced once on crossing, not on every step past it', async () => {
    const canvas = page.locator('canvas');
    const live = page.locator('[role=status]');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);

    // Walk outward until the crossing message appears, or give up - the exact
    // step count depends on which direction the corpus's slots happen to
    // extend, so this does not hard-code one.
    let crossedAt = -1;
    for (let i = 1; i <= 30; i++) {
      await page.keyboard.press('ArrowRight');
      const text = (await live.textContent()) ?? '';
      if (/edge of the library/.test(text)) {
        crossedAt = i;
        break;
      }
    }
    assert.ok(crossedAt > 0, 'walking outward must eventually cross the boundary and say so');

    // One more step past it must NOT repeat the boundary sentence - only the
    // crossing itself is announced, or the room name would be drowned every
    // single press through the far field.
    await page.keyboard.press('ArrowRight');
    const next = (await live.textContent()) ?? '';
    assert.doesNotMatch(next, /edge of the library/, 'the boundary sentence must not repeat on every step');
  });

  test('Home and ctrl+Home fly the cursor, and Enter opens what it lands on', async () => {
    const canvas = page.locator('canvas');
    const live = page.locator('[role=status]');
    await canvas.focus();

    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(flightMs + 200);
    await waitFor(
      async () => /^Room \d+, rank 1 of/.test((await live.textContent()) ?? ''),
      2000,
      'ctrl+Home must land on the best-ranked room (rank 1)'
    );

    // Standing on a real room, Enter opens its card - the keyboard path into
    // a room's content that right-click and long-press never gave a keyboard
    // user.
    await page.keyboard.press('Enter');
    const card = page.locator('.card');
    await card.waitFor({ timeout: 5000 });
    assert.match(await card.locator('.card-id').textContent(), /^room \d+/);

    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(
      await page.evaluate(() => document.activeElement?.tagName),
      'CANVAS',
      'closing a card opened by the map keyboard must return focus to the map'
    );

    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);
    await waitFor(
      async () => (await live.textContent()) === 'the centre of the library',
      2000,
      'Home must return to the centre and announce it'
    );
  });

  test('PageUp/PageDown zoom without moving the cursor cell', async () => {
    // A keyboard zoom eases over `camera.keyboardMoveMs`, so the HUD is not
    // final the moment `page.keyboard.press` returns - poll for the change
    // rather than reading once. This needed polling even back when the move
    // was instant, because "instant" still meant "on the next animation
    // frame"; it raced about one run in four then, and the easing only widens
    // the window. Same discipline `settled()` uses for its own asynchrony.
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);
    const before = await hud(page);

    await page.keyboard.press('PageUp');
    await waitFor(async () => (await hud(page)).zoom !== before.zoom, 2000, 'PageUp never changed the zoom');
    const zoomedIn = await hud(page);
    assert.ok(zoomedIn.zoom > before.zoom, `PageUp must zoom in: ${before.zoom} -> ${zoomedIn.zoom}`);
    assert.ok(Math.abs(zoomedIn.x - before.x) < 1e-6, 'PageUp must not pan the cursor');
    assert.ok(Math.abs(zoomedIn.y - before.y) < 1e-6, 'PageUp must not pan the cursor');

    await page.keyboard.press('PageDown');
    await page.keyboard.press('PageDown');
    await waitFor(
      async () => (await hud(page)).zoom < before.zoom,
      2000,
      'PageDown never brought the zoom back below where it started'
    );
    const zoomedOut = await hud(page);
    assert.ok(zoomedOut.zoom < before.zoom, `PageDown must zoom out: ${before.zoom} -> ${zoomedOut.zoom}`);
  });

  test('a keyboard nudge eases under normal motion and arrives at once under reduced motion', async () => {
    // The keyboard used to write the camera directly - instant, no animation
    // at all, which read as jarring against a search or a click that always
    // eases. `keyboardMoveMs` (config) gives a short flight instead; this is
    // the only layer that can see whether one is actually happening, since
    // `flyTo`'s timing lives in a rAF loop no unit test drives.
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);
    const before = await hud(page);

    await page.keyboard.press('ArrowRight');
    const samples = [];
    for (let i = 0; i < 8; i++) {
      samples.push((await hud(page)).x);
      await page.waitForTimeout(20);
    }
    // Three, not merely more-than-one: an "instant" arrival still spans two
    // distinct values in a sampling window this wide, because the flight
    // machinery takes exactly one rAF tick even at 0ms duration to notice it
    // is already done - `before.x` on the sample that lands before that tick,
    // `before.x + 1` on every one after. That two-value pattern is what a
    // broken "always instant" sabotage produces and this test failed to catch
    // the first time it was written; three or more values is only reachable
    // by genuinely easing across several frames of `keyboardMoveMs`.
    const distinctValues = new Set(samples.map((x) => x.toFixed(3))).size;
    assert.ok(
      distinctValues >= 3,
      `an arrow press under normal motion must ease across several frames, saw ${JSON.stringify(samples)}`
    );
    await waitFor(async () => (await hud(page)).x === before.x + 1, 1000, 'the arrow press never finished arriving');

    await page.getByRole('button', { name: 'centre' }).click();
    await landed(page);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    try {
      await canvas.focus();
      await page.keyboard.press('Home');
      await page.waitForTimeout(50);
      const rmBefore = await hud(page);
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(30); // well under keyboardMoveMs - nothing to ease if this is instant
      const rmAfter = await hud(page);
      assert.equal(
        rmAfter.x, rmBefore.x + 1,
        `reduced motion must arrive at once, not ease: ${rmBefore.x} -> ${rmAfter.x} after 30ms`
      );
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }

    await page.getByRole('button', { name: 'centre' }).click();
    await landed(page);
  });

  test('rapid keyboard presses compound instead of collapsing into one', async () => {
    // A real regression, found driving this by hand: two PageDown presses back
    // to back both read the camera's pre-flight zoom (nothing had eased yet,
    // even one frame in) and computed the SAME target, so the second press
    // silently cancelled the first instead of zooming out twice. Fixed by
    // chaining off the in-flight target rather than the interpolated one;
    // this is the test that would have caught it.
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);
    const before = await hud(page);

    await page.keyboard.press('PageUp');
    await waitFor(async () => (await hud(page)).zoom !== before.zoom, 1000, 'PageUp never took effect');
    const zoomedIn = await hud(page);

    await page.keyboard.press('PageDown');
    await page.keyboard.press('PageDown');
    await waitFor(
      async () => (await hud(page)).zoom < before.zoom,
      2000,
      'two PageDown presses must bring the zoom back below the starting point, not just to it'
    );
    const zoomedOut = await hud(page);
    assert.ok(
      zoomedOut.zoom < before.zoom * 0.9,
      `two PageDown presses must compound: started ${before.zoom}, zoomed in to ${zoomedIn.zoom}, ` +
        `two steps back landed at ${zoomedOut.zoom} - a single collapsed step would land back near ${before.zoom}`
    );

    // Same check the other direction, cheaply: two rapid arrow presses must
    // move two cells, not one.
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);
    const beforeArrows = await hud(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await waitFor(
      async () => (await hud(page)).x === beforeArrows.x + 2,
      1000,
      'two rapid arrow presses must move two cells, not collapse into one'
    );

    await page.getByRole('button', { name: 'centre' }).click();
    await landed(page);
  });

  test('arrows re-centre the map after a trip outside the boundary', async () => {
    // Reported from real use: after pushing past the border the camera settles
    // off-centre from the cursor's own cell - part of it hanging off the screen
    // edge - and arrowing around in bounds never fixes it, while a zoom or a
    // ctrl+arrow does. The cause is that a trip outside leaves the camera off
    // the grid (damped steps out there are fractional by design, and the glide
    // stops wherever it happens to cross back in), and a raw per-press delta
    // carries that offset forever.
    //
    // Only a browser reaches this: it needs the real damping, the real glide,
    // and the real settling between them.
    const canvas = page.locator('canvas');
    await page.getByRole('button', { name: 'centre' }).click();
    await landed(page);
    await canvas.focus();

    // Push out past the edge, then let the glide carry the camera back in.
    await page.keyboard.down('ArrowRight');
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(33);
      await page.keyboard.down('ArrowRight');
    }
    await page.keyboard.up('ArrowRight');

    const settled = await hud(page);
    assert.ok(settled.x > settled.edge, `the hold must end outside: x=${settled.x}, edge=${settled.edge}`);

    // Walk back in. Once inside, a press must land the camera cell-centred on
    // BOTH axes - the offset a trip outward leaves is rarely axis-aligned, so
    // an implementation that only fixed the axis being moved along would leave
    // the other one crooked forever.
    const offCentre = (v) => Math.abs(v - Math.floor(v) - 0.5);
    await waitFor(
      async () => {
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(250);
        const c = await hud(page);
        // The HUD rounds to one decimal, so "centred" is .5 within that.
        return c.x < c.edge && offCentre(c.x) < 0.05 && offCentre(c.y) < 0.05;
      },
      15000,
      'arrowing back in bounds never re-centred the camera on its cell'
    );

    // And it stays centred, one clean cell per press, rather than re-acquiring
    // an offset as it goes.
    for (let i = 0; i < 3; i++) {
      const before = await hud(page);
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(300);
      const after = await hud(page);
      assert.ok(
        offCentre(after.x) < 0.05 && offCentre(after.y) < 0.05,
        `press ${i + 1} left the camera off-centre: x=${after.x}, y=${after.y}`
      );
      assert.ok(
        Math.abs(after.x - before.x + 1) < 0.05,
        `press ${i + 1} must move exactly one cell: ${before.x} -> ${after.x}`
      );
    }

    await page.getByRole('button', { name: 'centre' }).click();
    await landed(page);
  });

  test('a held arrow key cannot outrun what a hand can drag to', async () => {
    // Parity, and the only place it can be observed: holding a key is a real
    // browser behaviour (the OS repeats `keydown` ~30x a second for as long as
    // it is down, each flagged `repeat: true`) that no unit test produces and
    // no single `press()` reproduces.
    //
    // The bug this pins: damping the keyboard with the POINTER's curve looks
    // right and is not. `panByPixels` floors its scale at 0.12 so a drag never
    // feels frozen, which costs nothing because a hand runs out of screen -
    // but for a key that repeats indefinitely, any non-zero floor is a
    // constant outward velocity. Measured with the shared curve, a six-second
    // hold reached 31 cells past a boundary eight full-width drags could only
    // push 15 past, and it was still climbing linearly.
    const canvas = page.locator('canvas');
    const recentre = async () => {
      await page.getByRole('button', { name: 'centre' }).click();
      await landed(page);
    };

    /** Hold ArrowRight for real: `down()` again while held sends repeat keydowns. */
    const hold = async (repeats) => {
      await canvas.focus();
      await page.keyboard.down('ArrowRight');
      for (let i = 0; i < repeats; i++) {
        await page.waitForTimeout(33);
        await page.keyboard.down('ArrowRight');
      }
      await page.keyboard.up('ArrowRight');
      return (await hud(page)).x;
    };

    await recentre();
    const brief = await hold(30);

    await recentre();
    const long = await hold(180);

    // Six times the input must not buy anything like six times the distance -
    // the step has to approach zero as the resistance does. A floored curve
    // grows linearly and would sail past this.
    assert.ok(
      long < brief * 2,
      `a six-times-longer hold must not travel proportionally further: ` +
        `30 repeats reached ${brief}, 180 reached ${long}`
    );

    // And the absolute reach stays in the same neighbourhood a determined
    // drag gets to, which is what "parity" actually means here. Generous
    // bound: this is asserting an order of magnitude, not a tuned constant.
    const { edge } = await hud(page);
    assert.ok(
      long < edge + 40,
      `a held key must not sail off into the far field: reached ${long}, edge at ${edge}`
    );

    await recentre();
  });

  test('the edge pushes back on a keyboard cursor too, and respects reduced motion', async () => {
    // The boundary's pan resistance is a REAL affordance, not an obstacle for
    // the keyboard to be exempted from: walking out past the last ranked room
    // and feeling the library pull you home is the same thing a pointer drag
    // gets on release (accessibility-plan.md §3.1's "the edge speaks").
    //
    // Written after shipping the opposite. An earlier fix exempted every
    // landed flight from the glide, on the theory that correcting a
    // keyboard-placed camera would fight the cursor's announced position -
    // which got the causality backwards (the cursor is DERIVED from the
    // camera, so it simply moves with it) and, because the exemption was set
    // on every landing and only cleared by a pointerdown, silently disabled
    // the pushback for the entire keyboard session. This is the test that
    // would have caught that.
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);

    let crossedX = null;
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(200);
      const text = (await page.locator('[role=status]').textContent()) ?? '';
      if (/edge of the library/.test(text)) {
        crossedX = (await hud(page)).x;
        break;
      }
    }
    assert.ok(crossedX !== null, 'walking outward must cross the boundary within a bounded number of presses');

    // Walk a few cells clear of the boundary so the pull is unambiguous, then
    // stop touching anything. The drift back must happen on its own - no
    // pointer, no further keys. A mouse pan producing a sudden correction that
    // idling does not is precisely the "snaps back when I try to pan" symptom.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(200);
    }
    const far = await hud(page);
    assert.ok(far.x > far.edge, `the walk must end outside the content region: x=${far.x}, edge=${far.edge}`);

    await waitFor(
      async () => (await hud(page)).x < far.x - 0.5,
      5000,
      'the edge must pull a keyboard-placed camera back on its own, with no pointer involved'
    );

    // And it keeps pulling toward the region rather than stalling partway.
    const settling = await hud(page);
    await waitFor(
      async () => (await hud(page)).x < settling.x,
      5000,
      'the pull must continue, not stop after one frame'
    );

    // Reduced motion gets the same correction without the frames it takes to
    // ease there - the glide had never checked the setting at all, an ambient
    // gap older than any of the keyboard work.
    await page.getByRole('button', { name: 'centre' }).click();
    await landed(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    try {
      await page.mouse.move(900, 400);
      await page.mouse.down();
      await page.mouse.move(0, 400, { steps: 5 });
      await page.mouse.up();
      const justReleased = (await hud(page)).x;
      await page.waitForTimeout(80);
      const afterOneFrame = (await hud(page)).x;
      await page.waitForTimeout(1200);
      const later = (await hud(page)).x;
      assert.notEqual(justReleased, afterOneFrame, 'a release outside the region must still correct SOMETHING');
      assert.equal(
        afterOneFrame, later,
        `reduced motion must settle the glide near-instantly, not ease it over seconds: ${afterOneFrame} -> ${later}`
      );
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }

    await page.getByRole('button', { name: 'centre' }).click();
    await landed(page);
  });

  test('/ reaches the search field from the map keyboard', async () => {
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);

    await page.keyboard.press('/');
    await waitFor(
      async () => (await page.evaluate(() => document.activeElement?.tagName)) === 'INPUT',
      2000,
      '/ must move focus to the search field'
    );
  });

  test('? announces the surroundings, on request rather than on every move', async () => {
    const canvas = page.locator('canvas');
    const live = page.locator('[role=status]');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);

    await page.keyboard.press('?');
    await waitFor(
      async () => /edge of the library is about/.test((await live.textContent()) ?? ''),
      2000,
      '? must report the distance to the edge'
    );
  });

  test("the cursor's own story and chips are real, touch-reachable elements - not gated on Enter", async () => {
    // `role="application"` plus a keyboard IS the desktop story, but VoiceOver
    // and TalkBack have nothing that corresponds to "press Enter" - accessibility-
    // plan.md §4.2b/§4.4 requires the cursor's content to be reachable without
    // it. Canvas fallback content is never PAINTED (that is the whole point -
    // it does not duplicate what is already on screen for sighted users), so a
    // real pointer click cannot reach it; `dispatchEvent` is the stand-in here
    // for how an assistive technology's own activation lands on an element
    // regardless of visibility.
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(flightMs + 200);

    const chips = canvas.locator('button');
    await waitFor(async () => (await chips.count()) > 0, 2000, 'the best-ranked room must have keyword chips');
    const term = await chips.first().textContent();

    await chips.first().dispatchEvent('click');
    await waitFor(
      async () => (await page.locator('input[type=search]').inputValue()) === term,
      SEARCH_TIMEOUT,
      'activating a cursor chip must run the same search a card chip does'
    );
  });

  test('axe finds no WCAG violations with the keyboard cursor active', async () => {
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(flightMs + 200);

    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const summary = violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.help}`);
    assert.deepEqual(summary, [], `axe reported violations with the cursor active:\n  ${summary.join('\n  ')}`);

    // Restore the centre for whatever runs next, and the ratio slider this
    // block's first test set - the long-press and pinch tests after this rely
    // on a dense map to reliably land on a room at a fixed screen point.
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);
    const ratio = page.locator('.row', { hasText: 'non-generic' }).locator('input[type=range]');
    await ratio.focus();
    await ratio.press('End');
  });

  // --- the centre room's shelf (accessibility-plan.md phase D) ---------------

  test('the shelf is a real control surface: one tab stop in, arrows within, a book searches', async () => {
    // The centre room's forty spines were painted pixels behind a hit-test -
    // the application's PRIMARY interface reachable only by mouse or finger.
    // Everything here is what a keyboard can now do with them.
    //
    // Fly to the opening view first: the buttons exist exactly while the
    // titles are legible, so this is also the state a sighted reader would be
    // looking at when they reached for the shelf.
    await page.locator('button.search-trigger').click();
    await landed(page);

    try {
      const shelf = page.locator('.centre-books');
      await shelf.waitFor({ state: 'visible', timeout: 5000 });
      const books = shelf.locator('button');
      await waitFor(async () => (await books.count()) > 0, 5000, 'the shelf mounted no books');

      // ONE tab stop for forty controls. Forty would put forty presses between
      // the map and the panel for every keyboard user, on a wall that is
      // mostly a browsable index of keywords.
      assert.equal(
        await shelf.locator('button[tabindex="0"]').count(),
        1,
        'the shelf must be one tab stop, not one per book'
      );

      // Reached from the search field, which is the element before it.
      await page.locator('input[type=search]').focus();
      await page.keyboard.press('Tab');
      const inShelf = () =>
        page.evaluate(() => {
          const el = document.activeElement;
          return el?.closest('.centre-books') ? el.dataset.book : null;
        });
      const first = await inShelf();
      assert.ok(first !== null, 'Tab from the search field must reach the shelf');

      // Arrows move WITHIN the shelf: right along the wall's flat queue, down
      // by a shelf. Both are `bookNeighbour`, which is asserted exactly in
      // centre.test.mjs - what only a browser can say is that the key actually
      // reaches it and focus actually follows.
      await page.keyboard.press('ArrowRight');
      const right = await inShelf();
      assert.equal(Number(right), Number(first) + 1, 'right must be the next book');

      await page.keyboard.press('ArrowDown');
      const down = await inShelf();
      assert.ok(Number(down) > Number(right), 'down must reach a lower shelf');
      await page.keyboard.press('ArrowUp');
      assert.equal(await inShelf(), right, 'up must come back to the book down left');

      // And Tab leaves in one press, from the middle of the wall.
      await page.keyboard.press('Tab');
      assert.equal(await inShelf(), null, 'Tab must leave the shelf, not walk it');

      // The names carry what the button DOES, not just what the spine says -
      // forty buttons called `brass` and `art nouveau` would say nothing about
      // what pressing one is for.
      const nodes = await axNodes(page);
      const toolbar = axFind(nodes, 'toolbar', /shelf/);
      assert.ok(toolbar, `no named toolbar for the shelf; roles seen: ${
        [...new Set(nodes.map((n) => n.role))].join(', ')}`);
      const book = nodes.find((n) => n.role === 'button' && / - (search|repeat)/.test(n.name));
      assert.ok(
        book,
        `no book button naming its action; buttons seen: ${
          nodes.filter((n) => n.role === 'button').map((n) => JSON.stringify(n.name)).join(', ')}`
      );

      // Activating one runs its search - the same `onBook` a sighted click
      // reaches through the canvas, which is the point of there being one.
      const term = book.name.split(' - ')[0];
      await page.evaluate((want) => {
        const el = [...document.querySelectorAll('.centre-books button')].find(
          (b) => b.getAttribute('aria-label')?.startsWith(want)
        );
        el.focus();
      }, term);
      await page.keyboard.press('Enter');
      await waitFor(
        async () => (await page.locator('input[type=search]').inputValue()) === term,
        SEARCH_TIMEOUT,
        `pressing a book must run its own title as a search (wanted "${term}")`
      );
    } finally {
      // Back to the centre at the ordinary zoom, which is where the block
      // above leaves things and what the pointer tests after this expect - a
      // viewport filled by the centre room would put every one of their fixed
      // screen points on the same tile.
      await page.locator('canvas').focus();
      await page.keyboard.press('Home');
      await page.waitForTimeout(flightMs + 200);
      await settled(page);
    }
  });

  test('axe finds no WCAG violations with the shelf on screen', async () => {
    await page.locator('button.search-trigger').click();
    await landed(page);
    try {
      await page.locator('.centre-books').waitFor({ state: 'visible', timeout: 5000 });
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const summary = violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.help}`);
      assert.deepEqual(summary, [], `axe reported violations with the shelf up:\n  ${summary.join('\n  ')}`);
    } finally {
      await page.locator('canvas').focus();
      await page.keyboard.press('Home');
      await page.waitForTimeout(flightMs + 200);
      await settled(page);
    }
  });

  test('a rearrangement says what it did and what is now under the cursor', async () => {
    // accessibility-plan.md §4.3 has said since it was written that "the new
    // occupant is announced"; §8 item 4 recorded that phase C never wired it
    // up. Standing still while the library reorders around you and hearing
    // nothing is not an accessible rearrangement, whatever the animation does.
    const live = page.locator('[role=status]');
    await page.locator('button.search-trigger').click();
    await landed(page);
    await page.locator('input[type=search]').fill('brass');
    await page.locator('input[type=search]').press('Enter');

    await waitFor(
      async () => /rearranged/.test((await live.textContent()) ?? ''),
      SEARCH_TIMEOUT,
      'a search must announce the arrangement it produced'
    );
    const said = (await live.textContent()) ?? '';
    assert.match(said, /\d+ rooms on the map/, `no size in the announcement: ${said}`);
    // And where the reader now stands - the clause §4.3 asks for. An animated
    // rearrangement parks the camera on the centre, so that is the honest
    // answer here rather than the cell the search was typed from.
    assert.match(
      said,
      /the centre of the library|Room \d+|a blank wall|the far field/,
      `the announcement never names a cell: ${said}`
    );

    await page.locator('canvas').focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(flightMs + 200);
    await settled(page);
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

  // --- the sidecar's optional alt (accessibility-plan.md phase E) ------------

  test("a room's picture caption is shown when the corpus carries one, and nothing is invented when it does not", async () => {
    // Phase E is a format change plus a fallback, and producing the field is
    // the corpus generator's job upstream of this repo - so no corpus here
    // ships one, and the placeholder sidecar in `assets/corpus-sample/`
    // deliberately never will: a caption that describes nothing about the
    // image it is attached to is exactly the padded, confident sentence §3.5
    // says to write no caption instead of. Handing the PAGE a corpus that does
    // carry one is the only honest way to see the whole path - fetch, join,
    // describeCell, card - actually reach the screen.
    //
    // Last in the file because it reloads: everything above shares one page.
    //
    // Sets its own camera and density rather than inheriting them: a reload
    // resets both, and at the opening view the centre room fills the screen so
    // a fixed screen point would land on the one cell that is never a corpus
    // room.
    const openCard = async () => {
      const ratio = page.locator('.row', { hasText: 'non-generic' }).locator('input[type=range]');
      await ratio.focus();
      await ratio.press('End');
      await page.locator('canvas').focus();
      await page.keyboard.press('Home');
      await page.waitForTimeout(flightMs + 200);
      const card = page.locator('.card');
      await page.mouse.click(880, 300, { button: 'right' });
      await card.waitFor({ timeout: 5000 });
      return card;
    };

    // Nothing invented, with the corpus exactly as it ships.
    let card = await openCard();
    assert.equal(await card.locator('.picture').count(), 0, 'no sidecar alt, no caption');
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });

    const caption = 'A shelved wall in green shadow, one brass rail catching the lamp.';
    await page.route('**/metadata.json', async (route) => {
      const sidecar = await (await route.fetch()).json();
      for (const key of Object.keys(sidecar)) sidecar[key] = { ...sidecar[key], alt: caption };
      await route.fulfill({ json: sidecar });
    });
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => /[1-9]\d* drawn/.test(document.getElementById('hud')?.textContent ?? ''),
        null,
        { timeout: 30_000 }
      );

      card = await openCard();
      await card.locator('.picture').waitFor({ timeout: 5000 });
      assert.equal(await card.locator('.picture').textContent(), caption);
      // And it stays a different thing from the story. The story is fiction
      // about the room and the caption is a report of the image; a reader has
      // to be able to tell which they are being told, so they are two nodes.
      const story = await card.locator('.story').textContent();
      assert.notEqual(story, caption, 'the caption must not have replaced the story');
      await page.keyboard.press('Escape');
      await card.waitFor({ state: 'detached', timeout: 5000 });
    } finally {
      await page.unroute('**/metadata.json');
    }
  });

  // --- the catalog (docs/catalog-plan.md) -------------------------------------

  /** Into the catalog from the panel, and settled. */
  async function openCatalog() {
    await page.locator('.panel .mode-toggle').click();
    await page.locator('.catalog').waitFor({ timeout: 5000 });
    await page.locator('.catalog-row').first().waitFor({ timeout: 5000 });
    return page.locator('.catalog');
  }

  async function closeCatalog() {
    await page.locator('.catalog .mode-toggle').click();
    await page.locator('.catalog').waitFor({ state: 'detached', timeout: 5000 });
    await settled(page);
  }

  test('the catalog lists every room once, starting with the centre', async () => {
    await openCatalog();
    try {
      const rows = page.locator('.catalog-row');
      // One row per room, plus the centre's - "always 100% unique tiles", so
      // nothing here is wallpaper and nothing repeats.
      assert.equal(await rows.count(), roomCount + 1);
      assert.equal(await rows.first().getAttribute('class'), 'catalog-row catalog-centre');

      // The centre's row carries the shelf as real links rather than as paint,
      // and the first of them is the override that got us here.
      assert.ok((await page.locator('.shelf-link').count()) > 0, 'the shelf is not in the centre row');
      assert.equal(await page.locator('.shelf-link').first().textContent(), 'the catalog');

      // Every room row names its rank and points at a real tile.
      const first = rows.nth(1);
      assert.match(await first.locator('.catalog-rank').textContent(), /^1$/);
      assert.match(await first.locator('.catalog-tile').getAttribute('src'), /^\/images\//);
    } finally {
      await closeCatalog();
    }
  });

  test('a search from the catalog ranks it, explains it, and marks what matched', async () => {
    await openCatalog();
    try {
      const term = await page.locator('.catalog-row:not(.catalog-centre) .chip').first().textContent();

      await page.locator('.catalog-search input').fill(term);
      await page.locator('.catalog-search input').press('Enter');
      await waitFor(
        async () => /ranked for/.test((await page.locator('.catalog-count').textContent()) ?? ''),
        SEARCH_TIMEOUT,
        'a search from the catalog never re-ranked it'
      );

      const top = page.locator('.catalog-row:not(.catalog-centre)').first();

      // The match is MARKED where it matched. Not a decoration: it is the only
      // thing on the row that says WHY these words put this room first.
      const marks = await top.locator('mark').allTextContents();
      assert.ok(marks.length > 0, `nothing was marked for ${JSON.stringify(term)}`);
      for (const m of marks)
        assert.match(m.toLowerCase(), new RegExp(term.toLowerCase().slice(0, 4)), 'a mark that is not the match');

      // And the score is broken out, including certainty - which is measured
      // against absolute bounds rather than against this query's corpus, and is
      // the number that keeps a min-maxed 1.00 from reading as confidence.
      const strip = await top.locator('.score-strip').textContent();
      assert.match(strip, /total/);
      assert.match(strip, /certainty/);
    } finally {
      await page.locator('.catalog-search input').fill('');
      await page.locator('.catalog-search input').press('Enter');
      await closeCatalog();
    }
  });

  test('pagination and scrolling are the same list, and the choice is remembered', async () => {
    await openCatalog();
    try {
      await page.locator('.paging button', { hasText: 'pages' }).click();
      await page.locator('.pager').waitFor({ timeout: 5000 });

      const namesOn = async () =>
        page.locator('.catalog-row:not(.catalog-centre) .catalog-name').allTextContents();

      const firstPage = await namesOn();
      assert.ok(firstPage.length > 0, 'pagination mounted nothing');

      await page.locator('.pager button', { hasText: 'next' }).click();
      await waitFor(
        async () => (await namesOn())[0] !== firstPage[0],
        5000,
        'paging forward did not change the rows'
      );
      const secondPage = await namesOn();
      // Disjoint: a room may not appear on two pages.
      for (const name of secondPage)
        assert.ok(!firstPage.includes(name), `${name} is on two pages at once`);

      // The choice outlives the session - one of the two things that do.
      assert.equal(
        await page.evaluate(() => localStorage.getItem('babel:paging')),
        '"pages"'
      );
    } finally {
      await page.locator('.paging button', { hasText: 'scroll' }).click();
      await closeCatalog();
    }
  });

  test('the catalog folds out of the centre tile rather than appearing', async () => {
    // The FLIP, which is the whole transition: the first row's thumbnail starts
    // ON the map's centre tile and eases to its resting place. Worth an
    // assertion of its own because the bug this had was silent - a DOMRect says
    // `width` where the rest of the app says `w`, so the scale fell through a
    // zero-size guard to 1 and the tile translated into place without ever
    // growing. It looked like a working transition.
    //
    // A CONDITION, not a duration: this waits for the scale to have been
    // meaningfully above 1 at some point, which is true for the whole 380ms and
    // never true at all when the scale is being dropped.
    //
    // The camera has to be established first. How big the tile starts depends
    // entirely on how large the centre cell is on screen, and this suite shares
    // one page - at the return-to-centre zoom (220) the cell is SMALLER than
    // the thumbnail and the tile would legitimately shrink into place, while
    // from far enough out the centre is off screen and there is deliberately no
    // flip at all. The search trigger flies to the opening view, which frames
    // the centre tile near its native width.
    await page.locator('button.search-trigger').click();
    await landed(page);

    try {
      await page.locator('.panel .mode-toggle').click();
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.catalog-tile');
          if (!el) return false;
          return new DOMMatrixReadOnly(getComputedStyle(el).transform).a > 1.5;
        },
        null,
        { timeout: 5000 }
      );
      // And it lands: the transform is released rather than left pinned.
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector('.catalog-tile')).transform === 'none',
        null,
        { timeout: 5000 }
      );
    } finally {
      // In `finally`, not after the assertions: this suite shares one page, and
      // a failure here that left the catalog open would fail every test after
      // it for a reason none of them are about.
      if (await page.locator('.catalog').count()) await closeCatalog();
    }
  });

  test('a room opens in full from the catalog, by its tile and by its story', async () => {
    // The rows are a fixed height and their thumbnails are thumbnails - that is
    // what lets the spacers be arithmetic. Neither is a reason to send a reader
    // back to the map to find out what a room says, so both the tile and a
    // clipped story open the same overlay.
    await openCatalog();
    try {
      await page.locator('.catalog-tile-button').nth(1).click();
      const overlay = page.locator('.overlay');
      await overlay.waitFor({ timeout: 5000 });

      // Nothing clipped in here: this is the whole point of it.
      assert.equal(
        await overlay.locator('.story').evaluate((el) => el.scrollHeight > el.clientHeight + 1),
        false,
        'the overlay clipped the story it exists to show in full'
      );
      // And the tile is the full-resolution one, not the row's thumbnail.
      assert.match(await overlay.locator('.overlay-tile').getAttribute('src'), /^\/images\/[^/]+$/);

      await page.keyboard.press('Escape');
      await overlay.waitFor({ state: 'detached', timeout: 5000 });

      // A story the clamp cut ends in a way out. Which rows have one depends on
      // the display, so this drives whichever row actually reports being cut
      // rather than assuming one does.
      const more = page.locator('.catalog-more').first();
      if (await more.count()) {
        await more.click();
        await overlay.waitFor({ timeout: 5000 });
        assert.equal(
          await overlay.locator('.story').evaluate((el) => el.scrollHeight > el.clientHeight + 1),
          false
        );
        await page.keyboard.press('Escape');
        await overlay.waitFor({ state: 'detached', timeout: 5000 });
      }
    } finally {
      if (await page.locator('.overlay').count()) {
        await page.keyboard.press('Escape');
        await page.locator('.overlay').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      }
      await closeCatalog();
    }
  });

  test('paginated, the pager sits under the rows rather than a screenful of nothing', async () => {
    // Spacers stand in for pages a reader can SCROLL to. Paginated there are
    // none - the other pages are behind a button - and standing in for them put
    // a page-sized hole between the last row and the pager.
    await openCatalog();
    try {
      await page.locator('.paging button', { hasText: 'pages' }).click();
      await page.locator('.pager').waitFor({ timeout: 5000 });

      assert.equal(await page.locator('.catalog-spacer').count(), 0, 'a spacer in paginated mode');

      const gap = await page.evaluate(() => {
        const rows = document.querySelectorAll('.catalog-row');
        const last = rows[rows.length - 1].getBoundingClientRect().bottom;
        return Math.round(document.querySelector('.pager').getBoundingClientRect().top - last);
      });
      assert.ok(gap >= 0 && gap < 80, `the pager is ${gap}px below the last row`);
    } finally {
      await page.locator('.paging button', { hasText: 'scroll' }).click();
      await closeCatalog();
    }
  });

  test('an over-long query is cut to the cap instead of taking the page down', async () => {
    // Scoring is O(tokens x keywords) per room. A pasted tag list is tens of
    // millions of substring tests on the main thread, which does not degrade -
    // it stops. The cap is enforced in `search()`, because a chip, a book and a
    // restored history entry all reach it without passing through the box.
    const { config } = await (await fetch(`${origin}/api/manifest`)).json();
    const cap = config.search.maxQueryLength;
    assert.equal(typeof cap, 'number', 'the manifest must carry the resolved query cap');

    await openCatalog();
    try {
      const box = page.locator('.catalog-search input');
      await box.fill('oak '.repeat(2000));
      assert.equal((await box.inputValue()).length, cap, 'the box took more than the cap');

      await box.press('Enter');
      // Still alive: the count updates, which means a frame ran after the sort.
      await waitFor(
        async () => /ranked for/.test((await page.locator('.catalog-count').textContent()) ?? ''),
        SEARCH_TIMEOUT,
        'the page stopped responding after a very long query'
      );
    } finally {
      await page.locator('.catalog-search input').fill('');
      await page.locator('.catalog-search input').press('Enter');
      await closeCatalog();
    }
  });

  test('the map is where it was left when the catalog closes', async () => {
    // THE assertion the whole design rests on. The map is hidden rather than
    // unmounted, so a trip through the catalog carries no state and rebuilds
    // nothing - if this fails, the mode has become the thing design-history
    // rejected ("modes carry state, and state desyncs").
    await page.locator('canvas').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(flightMs + 200);
    await settled(page);

    const before = await hud(page);

    await openCatalog();
    await closeCatalog();

    const after = await hud(page);
    assert.deepEqual(
      { x: after.x, y: after.y, zoom: after.zoom },
      { x: before.x, y: before.y, zoom: before.zoom },
      'the camera moved across a mode switch'
    );
    // And the tiles are still resident. A cache rebuilt on the way back would
    // be near-empty here, which is the other half of "nothing was torn down".
    assert.ok(after.cached > 1, `the tile cache was rebuilt: ${after.cached} cached`);

    // The canvas is still LIVE, which is a different claim from the state
    // having survived and the one a remount actually breaks. `useMapCamera`
    // binds its pointer listeners once, in an effect that depends on the ref
    // OBJECT rather than on the element - so a canvas that unmounted and came
    // back would look perfectly correct here, hold the right camera, and
    // silently never pan again. A drag is the only thing that can tell.
    await page.mouse.move(700, 400);
    await page.mouse.down();
    await page.mouse.move(560, 400, { steps: 8 });
    await page.mouse.up();
    await settled(page);

    const dragged = await hud(page);
    assert.notEqual(
      dragged.x,
      after.x,
      'the map stopped responding to a drag after a mode switch - the canvas was remounted'
    );
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
  // budget, and `clustered` only when a search's density gradient actually
  // lifted some ranks above the baseline (`layout.gradedCount > 0` - main.jsx)
  // - both optional here, but parsed rather than skipped, because both are
  // numbers a test might need. `clustered` went unexercised until a test ran a
  // search at a non-maxed "non-generic" ratio: every earlier test in this file
  // left that slider at 100%, where a cluster is structurally impossible (see
  // the ranked-listbox test), so the suffix never appeared and this regex
  // never had to parse it.
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
async function axNodes(page) {
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
const axFind = (nodes, role, name) =>
  nodes.find((n) => n.role === role && name.test(n.name));

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
