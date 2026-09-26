/**
 * The browser smoke test for favorites: the star toggle, the global count, and
 * the sliding-tile resort that follows one while sorted by favorites.
 *
 * Boots with `openLibrary({ favorites: true })`, which the rest of the suite
 * omits (see `openLibrary`). See `map-gestures.e2e.ts` for the shared header
 * comment, including how to run the suite.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_TIMEOUT, closeLibrary, fingerprint, landed, openLibrary, recentre, settled, waitFor,
} from './support.ts';

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

      // The "sort by my favorites" switch is diegetic, painted onto the
      // center tile with `pointer-events: none` (see docs/agents/map.md's "The
      // center room's controls") - a real click reaches it through the canvas's
      // own hit testing, not a native pointer event on the button itself.
      // Activating it the same way `shelf.e2e.ts` activates a book - focus the
      // element, then Enter - exercises the keyboard/screen-reader entry point,
      // an equally real way to reach it.
      const mineToggle = page.locator('[data-control="mine"]');
      await mineToggle.waitFor({ state: 'visible', timeout: 5000 });
      await page.evaluate(() => {
        (document.querySelector('[data-control="mine"]') as HTMLElement | null)?.focus();
      });
      await page.keyboard.press('Enter');
      // Sorting by favorites is a rearrangement, so `startRearrangement`
      // (`useRearrangement.ts`) zooms out in place and eases back to the zoom
      // it was called from, here the page-load opening view. `recentre` waits
      // that out, then moves to the "center" button's wider view: the opening
      // view is too tight for a real room to be under the fixed point used
      // below.
      await recentre(page, flightMs);

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

      // The camera must not have moved at all - this is the behavior this
      // test exists for. Already at the overview zoom here (the "center"
      // button above), so `startRearrangement`'s zoom-out-in-place is a no-op and
      // there is no flight to wait out - a regression would be a camera
      // flight. `landed`, not `settled`: `settled` only waits out the
      // tile-slide, not a flight still easing toward its target - reading
      // straight after `settled` can catch an early frame of that
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

  // Both favorite-sort modes go through the same exclusivity code in
  // `main.tsx` (`onSearchStart`, `changeSort`) - neither is special-cased on
  // `'mine'` vs `'count'` - but the two are functionally distinct enough
  // (`'mine'` reads the reader's own set, `'count'` the global store) that a
  // fix landing for one and not the other is a real failure mode, not a
  // hypothetical one. Run the same check against both rather than trusting
  // that symmetry in the source carries over to the browser.
  for (const mode of ['mine', 'count']) {
    test(
      `a search and 'sort by ${mode}' are mutually exclusive: starting either one ends the other [SR-41]`,
      async () => {
        const { page } = session;

        // Reached through the catalog rather than the diegetic switches: the
        // select's `value` is a plain, unambiguous read of `sortMode`, where
        // the center-tile switches would need pixel-diffing the canvas.
        await page.locator('.panel .mode-toggle').click();
        await page.locator('.catalog').waitFor({ timeout: 5000 });
        const sortSelect = page.locator('.catalog-sort select');
        const searchBox = page.locator('.catalog-search input');
        try {
          // Start a favorite sort, then start a search - the search must end it.
          await sortSelect.selectOption(mode);
          assert.equal(await sortSelect.inputValue(), mode);

          const term = await page.locator('.catalog-row:not(.catalog-center) .chip').first().textContent();
          await searchBox.fill(term);
          await searchBox.press('Enter');
          await waitFor(
            async () => /ranked for/.test((await page.locator('.catalog-count').textContent()) ?? ''),
            SEARCH_TIMEOUT,
            'a search from the catalog never re-ranked it'
          );
          assert.equal(
            await sortSelect.inputValue(),
            'relevance',
            `starting a search left the '${mode}' sort switch lit`
          );

          // Now the other direction: starting a favorite sort while that search
          // is still running must clear it.
          await sortSelect.selectOption(mode);
          await waitFor(
            async () => (await searchBox.inputValue()) === '',
            5000,
            `starting the '${mode}' sort left the search box populated`
          );
          assert.doesNotMatch(
            (await page.locator('.catalog-count').textContent()) ?? '',
            /ranked for/,
            `starting the '${mode}' sort left the search active`
          );
        } finally {
          await sortSelect.selectOption('relevance');
          await searchBox.fill('');
          await searchBox.press('Enter');
          await page.locator('.catalog .mode-toggle').click();
          await page.locator('.catalog').waitFor({ state: 'detached', timeout: 5000 });
          await settled(page);
        }
      }
    );
  }

  test('nothing logged to the console', () => {
    assert.deepEqual(session.consoleErrors, []);
  });
});
