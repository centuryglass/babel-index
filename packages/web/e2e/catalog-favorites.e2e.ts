/**
 * The browser smoke test for favoriting from the catalog: the one half of the
 * favoriting path `favorites.e2e.ts` does not cover, since that file only
 * ever reaches the star through the map's diegetic controls. Its own header
 * explains why `favorites: true` is what makes this file different from the
 * rest of the suite - it is the same reason here.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeLibrary, openLibrary, waitFor } from './support.ts';

describe('the library, in a browser: catalog favorites', { concurrency: false }, () => {
  let session;

  before(async () => {
    session = await openLibrary({ favorites: true });
  });

  after(async () => {
    await closeLibrary(session, 'library-catalog-favorites.png');
  });

  /** Into the catalog from the panel, and settled - same as `catalog.e2e.ts`. */
  async function openCatalog() {
    const { page } = session;
    await page.locator('.panel .mode-toggle').click();
    await page.locator('.catalog').waitFor({ timeout: 5000 });
    await page.locator('.catalog-row').first().waitFor({ timeout: 5000 });
    return page.locator('.catalog');
  }

  test(
    'favoriting a room from a catalog row counts it, sorts it to the front, and survives a reload',
    async () => {
      const { page } = session;
      await openCatalog();

      // The first non-center row - the center carries no favorite toggle of
      // its own (it is not a file that can be favorited).
      const row = page.locator('.catalog-row:not(.catalog-center)').first();
      const roomId = await row.getAttribute('data-room-id');
      assert.ok(roomId, 'the row carries no room id to track across a reload');

      const favBtn = row.locator('button.favorite-toggle');
      await favBtn.waitFor({ timeout: 5000 });
      assert.equal(await favBtn.getAttribute('aria-pressed'), 'false', 'the room must start unfavorited');
      assert.equal(await favBtn.locator('.favorite-count').textContent(), '0', 'a fresh store must start at 0');

      // The row's own click handler (opening the room) is what
      // `FavoriteToggle`'s `stopPropagation` exists to lose to - clicking the
      // star must not also open the overlay.
      await favBtn.click();
      await waitFor(
        async () => (await favBtn.getAttribute('aria-pressed')) === 'true',
        5000,
        'the catalog row star never registered the toggle'
      );
      assert.equal(
        await favBtn.locator('.favorite-count').textContent(),
        '1',
        'the server never returned the room favorited from a catalog row'
      );
      assert.equal(await page.locator('.overlay').count(), 0, 'favoriting a row opened its overlay');

      // Sort by "my favorites first" - a re-rank, not a rebuild, so the same
      // rows are still there, just reordered.
      await page.locator('.catalog-sort select').selectOption('mine');
      await waitFor(
        async () => /sorted by your favorites/.test((await page.locator('.catalog-count').textContent()) ?? ''),
        5000,
        'the catalog never switched to sorting by favorites'
      );
      await waitFor(
        async () =>
          (await page.locator('.catalog-row:not(.catalog-center)').first().getAttribute('data-room-id')) === roomId,
        5000,
        'favoriting a room never moved it to the front under "my favorites first"'
      );

      // Reload - a fresh page, a fresh React tree, and (per
      // `useFavorites.ts`) a personal favorites list read back out of
      // `localStorage` rather than rebuilt from nothing. The sort itself is
      // plain React state and is not expected to survive this; the favorite
      // is.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => /[1-9]\d* drawn/.test(document.getElementById('hud')?.textContent ?? ''),
        null,
        { timeout: 30_000 }
      );

      await openCatalog();
      const sameRow = page.locator(`.catalog-row[data-room-id="${roomId}"]`);
      await sameRow.waitFor({ timeout: 5000 });
      const sameFavBtn = sameRow.locator('button.favorite-toggle');
      await waitFor(
        async () => (await sameFavBtn.getAttribute('aria-pressed')) === 'true',
        5000,
        'the favorite did not survive a reload'
      );
      assert.equal(
        await sameFavBtn.locator('.favorite-count').textContent(),
        '1',
        'the global count did not survive a reload'
      );
    }
  );

  test('nothing logged to the console', () => {
    assert.deepEqual(session.consoleErrors, []);
  });
});
