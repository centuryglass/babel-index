/**
 * The browser smoke test: the catalog interface (docs/catalog-plan.md) - the
 * conventional web search UI and linear tile list that swaps in for the map.
 * One of five files split out of the original `smoke.e2e.mjs` (see
 * `docs/implementation-plan.md`); see `map-gestures.e2e.ts` for the shared
 * header comment on why and how.
 *
 * None of the files in this directory are part of `npm test`; run them on
 * purpose:
 *
 *   npx playwright install chromium   # once
 *   npm run test:e2e
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_TIMEOUT, closeLibrary, hud, landed, openLibrary, settled, waitFor } from './support.ts';

describe('the library, in a browser: the catalog', { concurrency: false }, () => {
  let session;

  before(async () => {
    session = await openLibrary();
  });

  after(async () => {
    await closeLibrary(session, 'library-catalog.png');
  });

  /** Into the catalog from the panel, and settled. */
  async function openCatalog() {
    const { page } = session;
    await page.locator('.panel .mode-toggle').click();
    await page.locator('.catalog').waitFor({ timeout: 5000 });
    await page.locator('.catalog-row').first().waitFor({ timeout: 5000 });
    return page.locator('.catalog');
  }

  async function closeCatalog() {
    const { page } = session;
    await page.locator('.catalog .mode-toggle').click();
    await page.locator('.catalog').waitFor({ state: 'detached', timeout: 5000 });
    await settled(page);
  }

  test('the catalog lists every room once, starting with the center', async () => {
    const { page, roomCount } = session;
    await openCatalog();
    try {
      const rows = page.locator('.catalog-row');
      // One row per room, plus the center's - "always 100% unique tiles", so
      // nothing here is wallpaper and nothing repeats.
      assert.equal(await rows.count(), roomCount + 1);
      assert.equal(await rows.first().getAttribute('class'), 'catalog-row catalog-center');

      // The center's row carries the shelf as real links rather than as paint,
      // first is the help button, second is the catalog link.
      assert.ok((await page.locator('.shelf-link').count()) > 0, 'the shelf is not in the center row');
      assert.equal(await page.locator('.shelf-link').first().textContent(), 'READ ME');
      assert.equal(await page.locator('.shelf-link').nth(1).textContent(), 'The Catalog');

      // Every room row names its rank and points at a real tile.
      const first = rows.nth(1);
      assert.match(await first.locator('.catalog-rank').textContent(), /^1$/);
      assert.match(await first.locator('.catalog-tile').getAttribute('src'), /^images\//);
    } finally {
      await closeCatalog();
    }
  });

  test('a search from the catalog ranks it, explains it, and marks what matched', async () => {
    const { page } = session;
    await openCatalog();
    try {
      const term = await page.locator('.catalog-row:not(.catalog-center) .chip').first().textContent();

      await page.locator('.catalog-search input').fill(term);
      await page.locator('.catalog-search input').press('Enter');
      await waitFor(
        async () => /ranked for/.test((await page.locator('.catalog-count').textContent()) ?? ''),
        SEARCH_TIMEOUT,
        'a search from the catalog never re-ranked it'
      );

      const top = page.locator('.catalog-row:not(.catalog-center)').first();

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

  test('a slow search cannot overwrite the one that came after it', async () => {
    const { page } = session;
    // `search` awaits the server, and two queries can be in the air at once: a
    // book on the shelf is one click, and the first request of a session pays
    // for loading the CLIP text tower. Without a sequence guard the slow early
    // reply lands last and wins, leaving the library ranked for a term the
    // reader has already moved on from.
    //
    // Ordered by condition rather than by duration: the first query's reply is
    // held until the second has been fulfilled, so "out of order" is
    // guaranteed here rather than raced for.
    const slow = 'magma';
    const fast = 'peaceful';
    let releasedBy = null;
    let release;
    const held = new Promise((r) => (release = r));
    const releaseTo = (who) => {
      if (!releasedBy) {
        releasedBy = who;
        release();
      }
    };
    let landed = false;

    await page.route('**/api/search*', async (route) => {
      const q = new URL(route.request().url()).searchParams.get('q');
      if (q === slow) {
        // Bounded, so a second query that never goes out fails this test
        // instead of hanging the suite - see `releasedBy` below.
        const timer = setTimeout(() => releaseTo('a timeout'), SEARCH_TIMEOUT);
        await held;
        clearTimeout(timer);
        await route.fulfill({ response: await route.fetch() });
        landed = true;
        return;
      }
      await route.fulfill({ response: await route.fetch() });
      releaseTo('the later query');
    });

    await openCatalog();
    try {
      const box = page.locator('.catalog-search input');
      await box.fill(slow);
      await box.press('Enter');
      await box.fill(fast);
      await box.press('Enter');

      await waitFor(() => landed, SEARCH_TIMEOUT * 2, 'the held reply was never delivered');
      assert.equal(releasedBy, 'the later query', 'the second query never reached the server');

      // Both replies are in, the superseded one last. The count names the
      // ranking the catalog is showing, so it is exactly the state a lost race
      // would corrupt - and the assertion below it is not a wait for anything
      // to arrive, since the stale reply has already been answered.
      await waitFor(
        async () => new RegExp(fast).test((await page.locator('.catalog-count').textContent()) ?? ''),
        SEARCH_TIMEOUT,
        `the catalog never ranked for ${JSON.stringify(fast)}`
      );
      const count = (await page.locator('.catalog-count').textContent()) ?? '';
      assert.doesNotMatch(count, new RegExp(slow), 'a superseded search overwrote the newer one');

      // And the marks agree with it. The highlight ranges are derived from the
      // ranking's own term, so a stale one showing through here would mean the
      // two disagree about which search the reader is looking at.
      const marks = await page.locator('.catalog-row mark').allTextContents();
      assert.ok(marks.length > 0, `nothing was marked for ${JSON.stringify(fast)}`);
      for (const m of marks)
        assert.match(m.toLowerCase(), new RegExp(fast), 'a mark left over from the superseded search');
    } finally {
      await page.unroute('**/api/search*');
      await page.locator('.catalog-search input').fill('');
      await page.locator('.catalog-search input').press('Enter');
      await closeCatalog();
    }
  });

  test('a search the server cannot answer says so and leaves the library alone', async () => {
    const { page } = session;
    await page.route('**/api/search*', (route) => route.fulfill({ status: 500, body: 'no' }));
    await openCatalog();
    try {
      const before = await page.locator('.catalog-count').textContent();
      const box = page.locator('.catalog-search input');
      await box.fill('brass');
      await box.press('Enter');

      // Nothing rearranged, so the effect that normally speaks for a search
      // never runs - the failure path has to write the live region itself.
      // Before this was handled the rejected promise simply went unhandled and
      // the reader was told nothing at all, which is the case this catches.
      await waitFor(
        async () => /could not be run/.test((await page.locator('[role=status]').textContent()) ?? ''),
        SEARCH_TIMEOUT,
        'a failed search never reported itself'
      );
      assert.equal(
        await page.locator('.catalog-count').textContent(),
        before,
        'a failed search re-ranked the catalog'
      );
    } finally {
      await page.unroute('**/api/search*');
      // Chromium logs a failed request on its own, and Playwright relays it -
      // so the 500 this test forced would fail the console check at the end of
      // this file. It is this test's own noise rather than the app's, and it
      // is taken back out here rather than being allowed to mask a real one by
      // widening what that check tolerates.
      const forced = /Failed to load resource[\s\S]*\b500\b/;
      for (let i = session.consoleErrors.length - 1; i >= 0; i--)
        if (forced.test(session.consoleErrors[i])) session.consoleErrors.splice(i, 1);
      await page.locator('.catalog-search input').fill('');
      await page.locator('.catalog-search input').press('Enter');
      await closeCatalog();
    }
  });

  test('pagination and scrolling are the same list, and the choice is remembered', async () => {
    const { page } = session;
    await openCatalog();
    try {
      await page.locator('.paging button', { hasText: 'pages' }).click();
      await page.locator('.pager').waitFor({ timeout: 5000 });

      const namesOn = async () =>
        page.locator('.catalog-row:not(.catalog-center) .catalog-name').allTextContents();

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

  test('the catalog folds out of the center tile rather than appearing', async () => {
    const { page } = session;
    // The FLIP, which is the whole transition: the first row's thumbnail starts
    // ON the map's center tile and eases to its resting place. Worth an
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
    // entirely on how large the center cell is on screen, and this file shares
    // one page - at the return-to-center zoom (220) the cell is SMALLER than
    // the thumbnail and the tile would legitimately shrink into place, while
    // from far enough out the center is off screen and there is deliberately no
    // flip at all. The search trigger flies to the opening view, which frames
    // the center tile near its native width.
    await page.locator('button.search-trigger').click();
    await landed(page, session.flightMs);

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
      // In `finally`, not after the assertions: this file shares one page, and
      // a failure here that left the catalog open would fail every test after
      // it for a reason none of them are about.
      if (await page.locator('.catalog').count()) await closeCatalog();
    }
  });

  test('a room opens in full from the catalog, by its tile and by its story', async () => {
    const { page } = session;
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
      assert.match(await overlay.locator('.overlay-tile').getAttribute('src'), /^images\/[^/]+$/);

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
    const { page } = session;
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
    const { page, origin } = session;
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
    const { page } = session;
    // THE assertion the whole design rests on. The map is hidden rather than
    // unmounted, so a trip through the catalog carries no state and rebuilds
    // nothing - if this fails, the mode has become the thing design-history
    // rejected ("modes carry state, and state desyncs").
    await page.locator('canvas').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(session.flightMs + 200);
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
    assert.deepEqual(session.consoleErrors, []);
  });
});
