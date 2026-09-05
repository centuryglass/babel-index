/**
 * The browser smoke test: favorites - the star toggle, the global count, and
 * the sliding-tile resort that follows one while sorted by favorites.
 *
 * `openLibrary({ favorites: true })` is what makes this file different from
 * the rest of the suite: every other file boots the server with no store at
 * all, so `manifest.favorites` is null there and no favorite control renders.
 * This is the one place that flag is on.
 *
 * None of the files in this directory are part of `npm test`; run them on
 * purpose:
 *
 *   npx playwright install chromium   # once
 *   npm run test:e2e
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeLibrary, fingerprint, landed, openLibrary, settled, waitFor } from './support.ts';

describe('the library, in a browser: favorites', { concurrency: false }, () => {
  let session;

  before(async () => {
    session = await openLibrary({ favorites: true });
  });

  after(async () => {
    await closeLibrary(session, 'library-favorites.png');
  });

  test(
    'toggling a favorite while sorted by favorites resorts the map in place, without flying the camera home',
    async () => {
      const { page, flightMs } = session;

      // Guarantee a real room sits under the fixed screen point used below -
      // the default ratio leaves most cells generic (see `map-gestures.e2e.ts`,
      // which relies on the same trick for the same reason).
      const ratio = page.locator('.row', { hasText: 'non-generic' }).locator('input[type=range]');
      await ratio.focus();
      await ratio.press('End');
      await settled(page);

      // Sorting BY favorites is a rearrangement like any other, so it gets the
      // same zoom-out-in-place `startRearrangement` gives every rearrangement
      // (`useRearrangement.ts`) - the page is still centered on the shelf at
      // this point, so widening to the default zoom is a camera move here. Let
      // it land before panning away, otherwise a flaky "did the camera move"
      // assertion below could be catching THIS flight rather than the one
      // under test. It eases back to whatever zoom it was called from (here,
      // the page-load opening view - see `useRearrangement.ts`'s
      // `returnZoom`), so explicitly return to the "center" button's wider
      // view afterwards: the opening view is zoomed into just the center
      // shelf, too tight for a real room to be under the fixed point used
      // below (`map-gestures.e2e.ts` relies on the same "center" button for
      // the same reason).
      // The "sort by my favorites" switch is diegetic now, painted onto the
      // center tile with `pointer-events: none` (see AGENTS.md's Favorites
      // section) - a real click reaches it through the canvas's own hit
      // testing, not a native pointer event on the button itself. Activating
      // it the same way `shelf.e2e.ts` activates a book - focus the element,
      // then Enter - exercises the keyboard/screen-reader entry point
      // instead, which is exactly as real a way to reach it.
      const mineToggle = page.locator('[data-control="mine"]');
      await mineToggle.waitFor({ state: 'visible', timeout: 5000 });
      await page.evaluate(() => {
        (document.querySelector('[data-control="mine"]') as HTMLElement | null)?.focus();
      });
      await page.keyboard.press('Enter');
      await landed(page, flightMs);
      await page.locator('button', { hasText: 'center' }).click();
      await landed(page, flightMs);

      // Pan off-center. At the parked center a stray fly-home would land back
      // where it started, which would make "the camera did not move" true for
      // the wrong reason - panning away is what makes the assertion mean
      // anything.
      const canvas = page.locator('canvas');
      const box = await canvas.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2 - 120, { steps: 10 });
      await page.mouse.up();
      const before = await settled(page);
      const beforeShot = await fingerprint(page);

      // Open a room's card off-center and toggle its favorite.
      const card = page.locator('.overlay');
      await page.mouse.click(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { button: 'right' });
      await card.waitFor({ timeout: 5000 });
      const favBtn = card.locator('button.favorite-toggle');
      await favBtn.waitFor({ timeout: 5000 });
      assert.equal(await favBtn.getAttribute('aria-pressed'), 'false', 'the room must start unfavorited');

      await favBtn.click();
      await waitFor(
        async () => (await favBtn.getAttribute('aria-pressed')) === 'true',
        5000,
        'the star never registered the toggle'
      );
      await page.keyboard.press('Escape');
      await card.waitFor({ state: 'detached', timeout: 5000 });

      // The camera must not have moved AT ALL - this is the behavior this
      // test exists for. Already at the overview zoom here (the "center"
      // button above), so `startRearrangement`'s zoom-out-in-place is a no-op and
      // there is no flight to wait out - a regression would be a camera
      // FLIGHT. `landed`, not `settled`: `settled` only waits out the
      // tile-slide, not a flight still easing toward its target - reading
      // straight after `settled` can catch an early frame of exactly that
      // flight, whose eased position rounds to the pre-toggle one by
      // coincidence. `landed` waits for two consecutive readings to agree,
      // which a still-moving camera cannot do.
      const after = await landed(page, flightMs);
      assert.deepEqual(
        { x: after.x, y: after.y, zoom: after.zoom },
        { x: before.x, y: before.y, zoom: before.zoom },
        'a favorite toggled live while sorted by favorites must not move the camera'
      );

      // And the map actually resorted - not "nothing moved because nothing
      // changed". Favoriting one room jumps it to the front of the order
      // (`favoriteOrder` in packages/map/favorites.ts), which reshuffles
      // nearly every cell's room.
      await waitFor(
        async () => (await fingerprint(page)) !== beforeShot,
        5000,
        'toggling a favorite while sorted by favorites never rearranged the map'
      );
    }
  );

  test('nothing logged to the console', () => {
    assert.deepEqual(session.consoleErrors, []);
  });
});
