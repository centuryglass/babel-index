/**
 * Regression harness for native pinch-zoom on mobile (docs/pinch-zoom-
 * native-fix-plan.md). Native pinch-zoom is normally kept off via
 * `touch-action` (`style.css`), a trade for the three bugs below; the CSS
 * scoping is TEMPORARILY removed (see the `TEMPORARY` comments in
 * `style.css`/`index.html`) so these tests can reproduce them for real,
 * against a real Chromium gesture recognizer rather than the app's own
 * pointer-event handlers.
 *
 * Every test in this file is expected to FAIL right now - `test.skip` marks
 * them so `ci.yml` stays green - and to start passing once a future session
 * implements the fix design sketched in the doc above. Un-skip them as part
 * of that work, not before.
 *
 * How the gesture actually reaches the browser's own zoom (not just this
 * app's `useMapCamera`/`useImageZoom` pointer handlers): a spike confirmed
 * that `support.ts`'s existing `pinch()`/`touchDrag()` helpers, UNCHANGED,
 * already move `window.visualViewport.scale` once nothing's `touch-action`
 * blocks it - CDP's `Input.dispatchTouchEvent` drives Chromium's real touch
 * pipeline, not just DOM pointer events. No new automation dependency was
 * needed (`Input.synthesizePinchGesture`, the CDP command built for exactly
 * this, did NOT move `visualViewport.scale` in either headless or headed
 * Chromium during that spike - left here as a note in case a future
 * Chromium version changes that, but the raw touch-dispatch route is what
 * this file actually uses). Panning a natively zoomed page shows up as
 * `window.visualViewport.offsetLeft/offsetTop`, not `window.scrollX/
 * scrollY` (confirmed the same way) - `nativeZoomState()` reads all four.
 *
 * `openLibrary({ mobileViewport: true })` swaps in a narrow, `isMobile`
 * context (see its own doc comment) so this reproduces the actual mobile
 * gesture arbitration the two real-device reports were about, not desktop
 * Chrome's touch emulation over a 1280x800 canvas.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeLibrary, landed, nativeZoomState, openLibrary, pinch, recentre, settled, touchDrag,
} from './support.ts';

const SKIP = 'reproduces a known, not-yet-fixed native-zoom bug - see docs/pinch-zoom-native-fix-plan.md';

/**
 * There is no direct API to set `visualViewport.scale` - the only way to
 * un-zoom is another native gesture. Each test needs a clean scale-1
 * baseline of its own (this file shares one `page` across its tests, same
 * as every other file in this suite), and per this file's own bug reports,
 * nothing in the app currently does this for you - that's the point. A
 * reverse pinch, well past the browser's own zoomed-out floor, is the most
 * reliable way to force it back down between tests without reloading the
 * whole page (and losing the corpus/cache warmth every other test in this
 * suite relies on `before`, not `beforeEach`, to preserve).
 */
async function resetNativeZoom(page) {
  const viewport = page.viewportSize();
  await pinch(page, {
    cx: viewport.width / 2,
    cy: viewport.height / 2,
    from: 150,
    to: 15,
  });
  await page.waitForTimeout(200);
}

describe('the library, in a browser: native pinch-zoom (mobile)', { concurrency: false }, () => {
  let session;

  before(async () => {
    session = await openLibrary({ mobileViewport: true });
  });

  after(async () => {
    await closeLibrary(session, 'library-pinch-zoom-native.png');
  });

  beforeEach(async () => {
    // A failed assertion in a previous test can leave a dialog open (this
    // file deliberately asserts AFTER the dialog opens, since that's the
    // bug under test) - close it defensively before the next test's own
    // `recentre` tries to reach the 'center' button behind it.
    await session.page.keyboard.press('Escape').catch(() => {});
    await resetNativeZoom(session.page);
  });

  test('native zoom on the map does not leak into a dialog opened afterward', { skip: SKIP }, async () => {
    const { page, flightMs } = session;

    // The opening view frames the center room's shelf - exactly what the
    // bug report means by "zooming in extra close on the map" before
    // reaching for the "READ ME" book (`data-book="0"`, `useCenterShelf.ts`).
    await page.locator('button.search-trigger').click();
    await landed(page, flightMs);

    const before = await nativeZoomState(page);
    assert.ok(before.scale < 1.05, `expected no native zoom yet, got scale ${before.scale}`);

    // Pinching over the search badge itself, not bare canvas: `canvas`
    // keeps its own `touch-action: none` (style.css) so the map's existing,
    // separate pinch-to-zoom-the-map feature keeps working - see that
    // rule's own comment. The badge is a sibling DOM element on top of the
    // canvas with no such restriction, and is exactly what the second real
    // device screenshot this file's bugs are drawn from showed ballooning.
    const badge = page.locator('.search-icon-button');
    const box = await badge.boundingBox();
    await pinch(page, {
      cx: box.x + box.width / 2,
      cy: box.y + box.height / 2,
      from: 20,
      to: 150,
    });
    await page.waitForTimeout(300);
    const zoomedIn = await nativeZoomState(page);
    assert.ok(
      zoomedIn.scale > before.scale + 0.3,
      `the pinch itself must move the browser's own zoom - got scale ${zoomedIn.scale} from a baseline of ${before.scale}`
    );

    const readMe = page.locator('.center-books button[data-book="0"]');
    await readMe.waitFor({ state: 'visible', timeout: 5000 });
    // `force`: same debug-panel-overlaps-narrow-viewport quirk `recentre`'s
    // own doc explains - the panel's fixed 268px width overlaps the shelf
    // at this viewport, independent of anything this test does.
    await readMe.click({ force: true });
    await page.locator('[role=dialog][aria-label=help]').waitFor({ timeout: 5000 });

    // Desired end state: opening the dialog is not itself magnified by
    // whatever the map happened to be natively zoomed to a moment before.
    const withDialogOpen = await nativeZoomState(page);
    assert.ok(
      withDialogOpen.scale < 1.05,
      `the help dialog opened while the map's leftover native zoom (scale ${withDialogOpen.scale}) was still applied - it should read legibly at the reader's own baseline, not inherit an unrelated prior zoom`
    );
  });

  test('closing an overlay after a native pan inside it leaves chrome where it was', { skip: SKIP }, async () => {
    const { page, flightMs } = session;
    const viewport = page.viewportSize();
    // Clear of the debug panel's fixed 268x328 footprint at this viewport
    // (measured directly - see this file's own header comment), so the
    // right-click lands on the map, not the panel.
    const px = Math.round(viewport.width * 0.9);
    const py = Math.round(viewport.height * 0.6);

    await recentre(page, flightMs, undefined, true);
    await settled(page);

    const before = await nativeZoomState(page);
    assert.ok(
      before.scale < 1.05 && Math.abs(before.offsetLeft) < 1 && Math.abs(before.offsetTop) < 1,
      `expected a clean baseline before opening anything, got ${JSON.stringify(before)}`
    );

    const card = page.locator('.overlay');
    await page.mouse.click(px, py, { button: 'right' });
    await card.waitFor({ timeout: 5000 });

    // Zoom in on the tile, then pan - a pinch alone would not move the
    // visual viewport's OFFSET (only its scale), and the bug this test
    // targets is specifically about leftover pan, not leftover zoom (see
    // the next test for that).
    await pinch(page, { cx: px, cy: py, from: 15, to: 100 });
    await touchDrag(page, { from: { x: px, y: py }, to: { x: px, y: py - 150 } });
    await page.waitForTimeout(300);
    const panned = await nativeZoomState(page);
    assert.ok(
      Math.abs(panned.offsetTop) > 5,
      `the pan itself must move the browser's own viewport offset - got ${JSON.stringify(panned)}`
    );

    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });

    // Desired end state: nothing from panning around inside the overlay
    // should still be applied to the document once it's closed - the map
    // canvas and the search badge (both fixed-size, absolutely positioned
    // chrome anchored to #root) are what a real device report described as
    // visibly displaced by exactly this leftover offset.
    const after = await nativeZoomState(page);
    assert.ok(
      Math.abs(after.offsetLeft - before.offsetLeft) < 1 && Math.abs(after.offsetTop - before.offsetTop) < 1,
      `closing the overlay left the browser's viewport offset at ${JSON.stringify(after)} instead of back at its pre-overlay baseline ${JSON.stringify(before)}`
    );
  });

  test('closing an overlay after a native zoom inside it leaves the map at its own zoom', { skip: SKIP }, async () => {
    const { page, flightMs } = session;
    const viewport = page.viewportSize();
    // Clear of the debug panel's fixed 268x328 footprint at this viewport
    // (measured directly - see this file's own header comment), so the
    // right-click lands on the map, not the panel.
    const px = Math.round(viewport.width * 0.9);
    const py = Math.round(viewport.height * 0.6);

    await recentre(page, flightMs, undefined, true);
    await settled(page);

    const before = await nativeZoomState(page);
    assert.ok(before.scale < 1.05, `expected no native zoom yet, got scale ${before.scale}`);

    const card = page.locator('.overlay');
    await page.mouse.click(px, py, { button: 'right' });
    await card.waitFor({ timeout: 5000 });

    // The room overlay's own tile is "the one place zooming in was actually
    // wanted" (style.css's own note on why `useImageZoom.ts` exists) - pinch
    // there specifically, matching the original report's "zooming within an
    // overlay" rather than the map behind it.
    const tile = page.locator('.overlay-tile');
    const box = await tile.boundingBox();
    await pinch(page, {
      cx: box.x + box.width / 2,
      cy: box.y + box.height / 2,
      from: 15,
      to: 100,
    });
    await page.waitForTimeout(300);
    const zoomedIn = await nativeZoomState(page);
    assert.ok(
      zoomedIn.scale > before.scale + 0.3,
      `the pinch itself must move the browser's own zoom - got scale ${zoomedIn.scale} from a baseline of ${before.scale}`
    );

    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });

    // Desired end state: the map is left at whatever it was before - not
    // stuck rendering at the tile's leftover native zoom with tiles loaded
    // for a resolution that zoom never asked the pyramid for (see this
    // file's header comment and the fix-plan doc for why that's the real
    // shape of the bug, not merely a cosmetic one).
    const after = await nativeZoomState(page);
    assert.ok(
      after.scale < 1.05,
      `closing the overlay left the browser's own zoom at ${after.scale} instead of back at the pre-overlay baseline of ${before.scale} - the map is now rendering natively-magnified, low-resolution tiles`
    );
  });
});
