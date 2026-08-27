/**
 * The browser smoke test: map rendering, the camera, pointer/touch gestures,
 * and search's rearrangement of the map. One of five files split out of the
 * original `smoke.e2e.mjs` (see `docs/implementation-plan.md`) along the
 * seams that file's own section comments already marked - this one covers
 * everything that isn't accessibility-plan work (that's `accessibility.e2e.mjs`,
 * `keyboard-cursor.e2e.mjs`, `shelf.e2e.mjs`) or the catalog (`catalog.e2e.mjs`).
 *
 * This is the only layer that catches "the canvas renders nothing" - the
 * failure no unit test can see, because every piece can be correct while the
 * thing on screen is a black rectangle. It drives the real demo server, in a
 * real browser, against the sample corpus.
 *
 * None of the files in this directory are part of `npm test`; run them on
 * purpose:
 *
 *   npx playwright install chromium   # once
 *   npm run test:e2e
 *
 * In CI they run from .github/workflows/e2e.yml, which `ci.yml` calls as a
 * reusable workflow - so this suite is a MERGE GATE, and a test in here that is
 * timing-dependent rather than state-dependent blocks everyone. Wait on a
 * condition, never on a duration.
 *
 * If Playwright's bundled Chromium is not the one on the machine - a sandbox
 * with its own browsers, a distro package - point BABEL_E2E_CHROMIUM at the
 * binary rather than downloading a second copy.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_TIMEOUT, closeLibrary, fingerprint, hud, landed, openLibrary,
  pinch, sampleCamera, settled, touchDrag, waitFor,
} from './support.mjs';

describe('the library, in a browser: map and gestures', { concurrency: false }, () => {
  let session;

  before(async () => {
    session = await openLibrary();
  });

  after(async () => {
    await closeLibrary(session, 'library-map-gestures.png');
  });

  test('the library opens', async () => {
    const { page, origin } = session;
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
    const { page } = session;
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
    const { page } = session;
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
    const { page } = session;
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
    const { page } = session;
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
    const { page } = session;
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

    // Ending on 100% leaves every visible cell holding a room, which the rest
    // of this file relies on: every remaining test in it wants a real room
    // under a fixed screen point.
    await ratio.press('End');
    const dense = await settled(page);
    assert.ok(dense.edge < sparse.edge, `a denser map must pack tighter: ${sparse.edge} -> ${dense.edge}`);
    assert.ok(dense.edge < most.edge, 'the whole point of the slider is that it moves the edge');
  });

  test('the camera flies rather than teleports', async () => {
    const { page, flightMs } = session;
    // Park at the center, then zoom well away from the default so "center" has
    // a long way to travel. Zoom is the axis to watch: it is independent of the
    // content boundary, so nothing seen here can be the glide back inside it.
    await page.locator('button', { hasText: 'center' }).click();
    await landed(page, flightMs);
    await page.mouse.move(640, 400);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 600);
    const far = await settled(page);

    // Sampling starts before the click, so it spans the whole flight. A
    // teleport shows two cameras - the one before and the one after - and an
    // eased one shows a frame's worth each; the count is what separates them.
    const sampling = sampleCamera(page, flightMs * 3);
    await page.locator('button', { hasText: 'center' }).click();
    const seen = await sampling;
    assert.ok(seen.length > 4, `only ${seen.length} distinct cameras: the camera teleported`);

    const home = await landed(page, flightMs);
    assert.ok(home.zoom > far.zoom, `the flight never restored the zoom: ${far.zoom} -> ${home.zoom}`);
    assert.deepEqual({ x: home.x, y: home.y }, { x: 0.5, y: 0.5 }, 'and it must land at the center');
  });

  test('a hand on the map interrupts a flight instead of fighting it', async () => {
    const { page, flightMs } = session;
    // The half that decides whether the map feels like yours. A flight still
    // easing under your hand drags the world out from under the finger holding
    // it, and the zoom is where that is unambiguous: a drag never changes zoom,
    // so any zoom that moves after the grab is the flight refusing to yield.
    await page.locator('button', { hasText: 'center' }).click();
    const centered = await landed(page, flightMs);
    await page.mouse.move(640, 400);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 600);
    const low = await settled(page);
    assert.ok(low.zoom < centered.zoom, `the wheel should have zoomed out: ${centered.zoom} -> ${low.zoom}`);

    await page.locator('button', { hasText: 'center' }).click();
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
      grabbed.zoom > low.zoom && grabbed.zoom < centered.zoom,
      `the grab did not catch the flight in the air (${low.zoom} -> ${grabbed.zoom} -> ${centered.zoom})`
    );

    await page.waitForTimeout(flightMs);
    const held = await settled(page);
    await page.mouse.up();
    assert.equal(held.zoom, grabbed.zoom, `the flight flew on under the hand: ${grabbed.zoom} -> ${held.zoom}`);

    // The wheel yields the same way and for the same reason: a flight easing
    // its own zoom underneath would fight every notch. Separate line of code
    // from the one above, so separate assertion.
    await page.locator('button', { hasText: 'center' }).click();
    await page.mouse.move(640, 400);
    await page.waitForTimeout(flightMs / 3);
    await page.mouse.wheel(0, 600);
    const wheeled = await settled(page);
    await page.waitForTimeout(flightMs);
    const after = await settled(page);
    assert.ok(wheeled.zoom < centered.zoom, 'the wheel should have caught the flight in the air');
    assert.equal(after.zoom, wheeled.zoom, `the flight flew on under the wheel: ${wheeled.zoom} -> ${after.zoom}`);
  });

  test('a search reorders the library around the center', async () => {
    const { page, flightMs } = session;
    // Park at the center and record the view, because a search both moves the
    // camera home AND reorders the rooms. Comparing pixels from two different
    // camera positions would pass on the camera move alone, which is a test
    // that cannot tell a working search from one whose ranking is discarded.
    //
    // `landed` rather than `settled`: the camera is flying for ~450ms after the
    // click, and a "parked" camera read mid-flight is a position the search's
    // own flight home would only pass through.
    await page.locator('button', { hasText: 'center' }).click();
    const parked = await landed(page, flightMs);
    const before = await fingerprint(page);

    // Wander off, so the fly-home is observable too.
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(400, 250, { steps: 8 });
    await page.mouse.up();
    const wandered = await settled(page);
    assert.notEqual(wandered.x, parked.x, 'the drag did not move the camera');

    // The live field lives on the center tile, not the panel - wandered this
    // far out it is off screen, so reaching it is itself a flight the search
    // trigger starts. Land that one before typing into what it flew to.
    await page.locator('button.search-trigger').click();
    const atField = await landed(page, flightMs);
    await page.locator('input[type=search]').fill('hexagonal galleries');
    await page.locator('input[type=search]').press('Enter');

    // A search flies home to show off the rearrangement, then flies back to
    // whatever zoom the reader was actually at (here, the search-trigger's
    // opening view) so the field stays reachable rather than stranding them
    // at the rearrangement's parked-out zoom. So the final resting point is
    // the field's zoom, not the center-button's - only x/y return to center.
    await waitFor(
      async () => {
        const c = await settled(page);
        return c.x === parked.x && c.y === parked.y && c.zoom === atField.zoom;
      },
      SEARCH_TIMEOUT,
      'the search never flew the camera back to the zoom it started the search from'
    );
    const home = await settled(page);
    assert.deepEqual(
      { x: home.x, y: home.y, zoom: home.zoom },
      { x: parked.x, y: parked.y, zoom: atField.zoom },
      'a search must return the camera to the center, at the zoom it was called from'
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
    const { page, flightMs } = session;
    // The gesture is the part no unit test can reach: `picking.js` proves what
    // is under a point, but only a browser proves that a right-click reaches it
    // at all, that the card renders, and that the chips are wired to search.
    const card = page.locator('.card');

    // The previous test leaves the camera wherever its search was called
    // from (the search-trigger's zoomed-in opening view), not `defaultZoom` -
    // return to the center button's view explicitly rather than relying on
    // leftover state, so rooms are on screen at the coordinates below.
    await page.locator('button', { hasText: 'center' }).click();
    await landed(page, flightMs);
    await page.mouse.move(640, 400);

    // The map is 100% non-generic by the time this runs (the sliders test,
    // earlier in this file, left the ratio maxed) - but the center CELL is
    // reserved, so aim off it. (We just returned to the center at
    // `defaultZoom`, not the fully-in page-load zoom, so rooms around the
    // center are on screen here.) Every gesture test after this one in this
    // file reuses this same fixed point for the same reason.
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
    // Two things at once here.
    //
    // Wait for the note that reflects THIS search, not just any "ranked by":
    // the previous test's note lingers in the live region, and a keyword chip
    // is the one query guaranteed to name "keywords" (it searches a keyword the
    // room actually has), so a looser wait can pass on the stale note first.
    //
    // And read the LIVE REGION rather than `.note`. There is now one region for
    // the whole app and it lives outside both views - the panel is part of the
    // MAP, and a region inside it would be unmounted on every switch to the
    // catalog, which is how a screen reader loses one. `.note` keeps only the
    // static hint, so the text this waits on is no longer in it.
    await waitFor(
      async () => /keywords/.test(await page.locator('[role=status]').textContent()),
      SEARCH_TIMEOUT,
      'clicking a keyword chip never produced a keyword-driven ranking'
    );
  });

  // --- pointer and touch gestures ---------------------------------------------
  //
  // Everything below reuses the dense map and the fixed screen point (880, 300)
  // the right-click test above established, rather than re-deriving either -
  // by the time this runs the camera is back at `defaultZoom` and centered
  // (that test explicitly returns it there), and the "non-generic" slider has
  // been at 100% since the sliders test near the top of this file.

  test('a long press opens the card, and a drag cancels it', async () => {
    const { page } = session;
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
    const { page } = session;
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
    const { page } = session;
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
    const { page } = session;
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
        // Re-center first. Pan resistance grows with distance from the origin,
        // so three drags in a row from wherever the last one ended would differ
        // for a reason that has nothing to do with pointer bookkeeping - which
        // is exactly what the first version of this test measured. And the
        // re-center now flies, so the baseline has to be taken after it lands
        // or the drag is measured partly against the flight.
        await page.locator('button', { hasText: 'center' }).click();
        const before = await landed(page, session.flightMs);
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
    assert.deepEqual(session.consoleErrors, []);
  });
});
