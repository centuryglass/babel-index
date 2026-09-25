/**
 * The browser smoke test: map rendering, the camera, pointer/touch gestures,
 * and search's rearrangement of the map. This file covers everything the
 * other specs here don't: accessibility is `accessibility.e2e.ts`,
 * `keyboard-cursor.e2e.ts` and `shelf.e2e.ts`, the catalog is
 * `catalog.e2e.ts`.
 *
 * This is the only layer that catches "the canvas renders nothing" - the
 * failure no unit test can see, because every piece can be correct while the
 * thing on screen is a black rectangle. It drives the real demo server, in a
 * real browser, against the sample corpus.
 *
 * None of the files in this directory are part of `npm test`; run them
 * explicitly:
 *
 *   npx playwright install chromium   # once
 *   npm run test:e2e
 *
 * In CI they run from .github/workflows/e2e.yml, which `ci.yml` calls as a
 * reusable workflow, so this suite is a merge gate (see
 * docs/agents/testing.md, "Wait on a condition, never a duration").
 *
 * If Playwright's bundled Chromium is not the one on the machine - a sandbox
 * with its own browsers, a distro package - point BABEL_E2E_CHROMIUM at the
 * binary rather than downloading a second copy.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_TIMEOUT, closeLibrary, fingerprint, hud, landed, openLibrary,
  pinch, recentre, sampleCamera, settled, touchDrag, waitFor,
} from './support.ts';

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
    assert.equal(await page.title(), 'The Index of Babel');
    await assert.doesNotReject(page.locator('.panel h1').waitFor({ timeout: 5000 }));
    assert.equal(await page.locator('.panel h1').textContent(), 'The Index of Babel');

    const { count } = await (await fetch(`${origin}/api/manifest`)).json();
    assert.match(await page.locator('.panel .sub').textContent(), new RegExp(`offline · ${count} rooms`));

    const h = await hud(page);
    assert.ok(h.cells > 0, 'no cells in view');
    assert.ok(h.drawn > 0, 'nothing drew');
    assert.ok(h.edge > 0, 'the content region has no extent');
  });

  test('the canvas is actually painted, not just present', async () => {
    const { page } = session;
    // A blank canvas is two flat fills: the page background and the
    // not-yet-loaded cell colour. Real rooms are photographs, so they bring
    // hundreds of distinct colours with them.
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

  test('zooming in never grows the page past the viewport', async () => {
    const { page, flightMs } = session;
    // The center tile's DOM overlays (`.center-search`, `.center-books`,
    // `.center-book`, `.center-controls`) are positioned over the whole
    // center cell, which at reading zoom is several screens wide. On a
    // desktop the overflow is invisible. A phone reads it as a page wider
    // than the screen: it drops the page scale to fit and grows the layout
    // viewport to match, and `position: fixed` resolves against that, so every
    // dialog's scrim covers several screens and the map paints at a fraction
    // of its size once the dialog closes. A clip (`#root { overflow: clip }`)
    // prevents it and shows no sign of being there until it is gone, so this
    // asserts the document's own size, which reads the same here as on a
    // phone.
    await page.mouse.move(640, 400);
    try {
      for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -600);
      await settled(page);
      const doc = await page.evaluate(() => ({
        w: document.documentElement.scrollWidth,
        h: document.documentElement.scrollHeight,
        vw: window.innerWidth,
        vh: window.innerHeight,
      }));
      assert.ok(doc.w <= doc.vw, `zoomed in, the page is ${doc.w}px wide in a ${doc.vw}px viewport`);
      assert.ok(doc.h <= doc.vh, `zoomed in, the page is ${doc.h}px tall in a ${doc.vh}px viewport`);
    } finally {
      for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 600);
      await settled(page);
      await recentre(page, flightMs);
    }
  });

  test('the pyramid engages: zooming out drops to a coarser level', async () => {
    const { page } = session;
    // The unit tests prove the policy; this proves it is wired to the real
    // canvas against a real corpus with real level directories on disk. Without
    // it the pyramid could be selecting levels nothing ever fetches.
    await page.mouse.move(640, 400);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 600);
    // Poll until `blank === 0`, bounded, so a cell that never arrives fails
    // the assertion below rather than hanging. `settled()` covers the camera
    // but not a tile still decoding, so a settled far-out screen can be a
    // cell or two short for a frame or two.
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

    // Ending on 100% leaves every visible cell holding a room; every remaining
    // test in this file wants a real room under a fixed screen point.
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
    // A flight still easing under the hand drags the world out from under the
    // finger holding it. The zoom is where that is unambiguous: a drag never
    // changes zoom, so any zoom that moves after the grab is the flight
    // refusing to yield.
    await page.locator('button', { hasText: 'center' }).click();
    const centered = await landed(page, flightMs);
    await page.mouse.move(640, 400);
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 600);
    const low = await settled(page);
    assert.ok(low.zoom < centered.zoom, `the wheel should have zoomed out: ${centered.zoom} -> ${low.zoom}`);

    await page.locator('button', { hasText: 'center' }).click();
    // Back onto the canvas first: clicking the button left the pointer over the
    // panel, and a press there never reaches the map at all - which reads as
    // a flight that refused to be interrupted.
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

  test('a search reorders the library around wherever the camera already is [SR-31]', async () => {
    const { page, flightMs } = session;
    // Park at the center and record the view, because a search both zooms the
    // camera out (to give the slide a wall of rooms) and reorders the rooms.
    // Comparing pixels from two different cameras would pass on the camera
    // move alone, which is a test that cannot tell a working search from one
    // whose ranking is discarded.
    //
    // `landed`, not `settled`: the camera flies for `flightMs` after the
    // click, and a camera read mid-flight is a position it only passes through.
    await page.locator('button', { hasText: 'center' }).click();
    await landed(page, flightMs);
    const before = await fingerprint(page);

    // Wander off, so a stray recenter would be observable.
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(400, 250, { steps: 8 });
    await page.mouse.up();
    const wandered = await settled(page);

    // The live field lives on the center tile, not the panel - wandered this
    // far out it is off screen, so reaching it is itself a flight the search
    // trigger starts. Land that one before typing into what it flew to.
    await page.locator('button.search-trigger').click();
    const atField = await landed(page, flightMs);
    assert.notEqual(atField.x, wandered.x, 'the search trigger did not fly to the field');
    await page.locator('input[type=search]').fill('clockwork');
    await page.locator('input[type=search]').press('Enter');

    // Wait for the rearrangement to begin. The fetch can be slow (a cold CLIP
    // text tower load), and until the rearrangement starts the camera already
    // sits at `atField`, so the `waitFor` below would pass without watching
    // one. The late rearrangement would then override the next test's
    // flight.
    await page.waitForFunction(
      () => document.getElementById('hud')?.textContent?.replace(/^\[gl\] /, '').startsWith('rearranging'),
      null,
      { timeout: SEARCH_TIMEOUT }
    );

    // A search does not recenter the camera: it zooms out in place for the
    // rearrangement, then eases back to the reader's zoom, at the same x/y
    // throughout. The camera comes to rest where the search was triggered
    // from, not the center.
    await waitFor(
      async () => {
        const c = await settled(page);
        return c.x === atField.x && c.y === atField.y && c.zoom === atField.zoom;
      },
      SEARCH_TIMEOUT,
      'the search never eased the camera back to where and how zoomed in it was called from'
    );
    const home = await settled(page);
    assert.deepEqual(
      { x: home.x, y: home.y, zoom: home.zoom },
      { x: atField.x, y: atField.y, zoom: atField.zoom },
      'a search must return the camera to exactly where it was called from'
    );

    // Same camera, same slots, so any change in pixels is the rooms moving
    // between those slots.
    await waitFor(
      async () => (await fingerprint(page)) !== before,
      10_000,
      'the search ranking never reached the map: identical view at an identical camera'
    );
  });

  test('right-clicking a room opens its card, and a chip searches for it [SR-07]', async () => {
    const { page, flightMs } = session;
    // The gesture is the part no unit test can reach: `picking.ts` proves what
    // is under a point, but only a browser proves that a right-click reaches it
    // at all, that the card renders, and that the chips are wired to search.
    const card = page.locator('.overlay');

    // The previous test leaves the camera wherever its search was called
    // from (the search-trigger's zoomed-in opening view), not the wider
    // overview zoom. Return to the center button's view so rooms are on
    // screen at the coordinates below, through `recentre` because the
    // previous test's rearrangement can still be settling (see `recentre`).
    await recentre(page, flightMs);
    await page.mouse.move(640, 400);

    // The map is 100% non-generic by the time this runs (the sliders test,
    // earlier in this file, left the ratio maxed) - but the center cell is
    // reserved, so aim off it. At the center button's overview zoom, rooms
    // around the center are on screen. Every gesture test after this one in
    // this file reuses this fixed point.
    await page.mouse.click(880, 300, { button: 'right' });
    await card.waitFor({ timeout: 5000 });
    // Confirm a real room through the dialog's accessible name (`desc.name`,
    // `describeRoom`); `.card-id`'s visible text leads with the room's title
    // when it has one.
    assert.match(await card.getAttribute('aria-label'), /^Room \d+/);

    const chips = card.locator('.chip');
    assert.equal(await chips.count(), 3, 'the sample corpus gives every room three keywords');
    assert.ok(await card.locator('.story').textContent(), 'the card shows a story');

    // Escape closes.
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });

    // A chip is a live search: reopen, click one, and the note must report a
    // keyword-driven ranking for the term the chip carried. Read the term
    // from this opening's chip, right before clicking it: `chips` is a live
    // locator, and the room under this fixed point may differ from the first
    // opening's if a rearrangement lands between the two clicks.
    await page.mouse.click(880, 300, { button: 'right' });
    await card.waitFor({ timeout: 5000 });
    const term = await chips.first().textContent();
    await chips.first().click();
    await card.waitFor({ state: 'detached', timeout: 5000 });

    assert.equal(await page.locator('input[type=search]').inputValue(), term);
    // Two things at once here.
    //
    // Wait for the note that reflects this search, not just any "ranked by":
    // the previous test's note lingers in the live region, and a keyword chip
    // is the one query that always names "keywords" (it searches a keyword the
    // room has), so a looser wait can pass on the stale note first.
    //
    // And read the live region, not `.note`, which keeps only the static
    // hint. There is one region for the whole app, outside both views, so a
    // switch to the catalog does not unmount it.
    await waitFor(
      async () => /keywords/.test(await page.locator('[role=status]').textContent()),
      SEARCH_TIMEOUT,
      'clicking a keyword chip never produced a keyword-driven ranking'
    );
  });

  // --- pointer and touch gestures ---------------------------------------------
  //
  // Everything below reuses the dense map and the fixed screen point (880, 300)
  // the `right-clicking a room opens its card` test established: that test
  // returns the camera to the overview zoom and center, and the "non-generic"
  // slider has been at 100% since the sliders test earlier in this file.

  test('a long press opens the card, and a drag cancels it', async () => {
    const { page } = session;
    // A press that becomes a pan must not also open a card.
    const card = page.locator('.overlay');

    await page.mouse.move(880, 300);
    await page.mouse.down();
    await page.waitForTimeout(700); // past the `longPressMs` threshold
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
    // dispatched through CDP. Pinch cannot be approximated with a mouse, and
    // the multi-pointer bookkeeping it needs is the same code the drag and the
    // long press run on.
    const before = await settled(page);

    await pinch(page, { cx: 640, cy: 400, from: 80, to: 260 });
    const out = await settled(page);
    assert.ok(out.zoom > before.zoom, `spreading must zoom in: ${before.zoom} -> ${out.zoom}`);

    await pinch(page, { cx: 640, cy: 400, from: 260, to: 80 });
    const back = await settled(page);
    assert.ok(back.zoom < out.zoom, `squeezing must zoom out: ${out.zoom} -> ${back.zoom}`);

    // Two fingers held at a fixed distance and slid together are a pan, not a
    // zoom. Pointers are tracked by id; if both fingers fed one drag, the map
    // would judder between them.
    const steady = await settled(page);
    await pinch(page, { cx: 640, cy: 400, from: 160, to: 160, slide: { x: 120, y: 0 } });
    const slid = await settled(page);
    assert.equal(slid.zoom, steady.zoom, 'a parallel two-finger slide must not change zoom');
    assert.ok(slid.x < steady.x, `sliding right must move the camera left: ${steady.x} -> ${slid.x}`);
  });

  test('lifting one finger hands the gesture to the other without a lurch', async () => {
    const { page } = session;
    // The remaining finger's next move is measured from wherever the pinch
    // left off unless the drag is re-anchored to where that finger is. The
    // symptom is the map jumping by the width of the gesture as a pinch ends.
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
    // never exercises that path; this makes the calls throw.
    //
    // An unguarded release aborts the handler before the bookkeeping runs,
    // leaving the finger in the pointer map, after which every gesture is read
    // as a pinch against a finger no longer on the glass. The spec allows the
    // throw (see `capture` in `useMapCamera.ts`).
    await page.evaluate(() => {
      const proto = HTMLCanvasElement.prototype;
      (window as any).__capture = {
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
        // Re-center first, since pan resistance grows with distance from the
        // origin and three drags in a row would otherwise differ for a reason
        // unrelated to pointer bookkeeping. Take the baseline after the flight
        // lands, or the drag is measured partly against the flight.
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
        const { __capture } = window as any;
        HTMLCanvasElement.prototype.setPointerCapture = __capture.set;
        HTMLCanvasElement.prototype.releasePointerCapture = __capture.release;
      });
    }
  });

  test('nothing was logged to the console', () => {
    assert.deepEqual(session.consoleErrors, []);
  });
});
