/**
 * The browser smoke test: the center room's shelf
 * (docs/accessibility-plan.md phase D) - the diegetic search controls painted
 * into the center tile, and their keyboard interface. One of five files split
 * out of the original `smoke.e2e.mjs` (see `docs/implementation-plan.md`);
 * see `map-gestures.e2e.mjs` for the shared header comment on why and how.
 *
 * The center room's forty spines were painted pixels behind a hit-test - the
 * application's PRIMARY interface reachable only by mouse or finger.
 * Everything here is what a keyboard can now do with them, which only a real
 * browser can confirm: `center.js`'s `bookNeighbour` is asserted exactly in
 * its own unit test, but whether the key actually reaches it and focus
 * actually follows is a browser-only question.
 *
 * None of the files in this directory are part of `npm test`; run them on
 * purpose:
 *
 *   npx playwright install chromium   # once
 *   npm run test:e2e
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import {
  SEARCH_TIMEOUT, axFind, axNodes, closeLibrary, landed, openLibrary, settled, waitFor,
} from './support.mjs';

describe('the library, in a browser: the center shelf', { concurrency: false }, () => {
  let session;

  before(async () => {
    session = await openLibrary();
  });

  after(async () => {
    await closeLibrary(session, 'library-shelf.png');
  });

  test('the shelf is a real control surface: one tab stop in, arrows within, a book searches', async () => {
    const { page } = session;
    // Fly to the opening view first: the buttons exist exactly while the
    // titles are legible, so this is also the state a sighted reader would be
    // looking at when they reached for the shelf.
    await page.locator('button.search-trigger').click();
    await landed(page, session.flightMs);

    try {
      const shelf = page.locator('.center-books');
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

      // Reached from the search field. The clear button only mounts once
      // there is something to clear (SearchForm.jsx), so it takes typing a
      // query - not merely submitting one - to put it right after the input
      // and give it the first Tab; the shelf is the stop after that.
      await page.locator('input[type=search]').fill('brass');
      await page.keyboard.press('Tab');
      assert.ok(
        await page.evaluate(() => document.activeElement?.classList.contains('search-clear')),
        'Tab from the search field must reach the clear button first'
      );
      await page.keyboard.press('Tab');
      const inShelf = () =>
        page.evaluate(() => {
          const el = document.activeElement;
          return el?.closest('.center-books') ? el.dataset.book : null;
        });
      const first = await inShelf();
      assert.ok(first !== null, 'Tab from the clear button must reach the shelf');

      // Arrows move WITHIN the shelf: right along the wall's flat queue, down
      // by a shelf. Both are `bookNeighbour`, which is asserted exactly in
      // center.test.mjs - what only a browser can say is that the key actually
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
        const el = [...document.querySelectorAll('.center-books button')].find(
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
      // Back to the center at the ordinary zoom, which is where the block
      // above leaves things and what the tests after this expect - a
      // viewport filled by the center room would put every one of their fixed
      // screen points on the same tile.
      await page.locator('canvas').focus();
      await page.keyboard.press('Home');
      await page.waitForTimeout(session.flightMs + 200);
      await settled(page);
    }
  });

  test('axe finds no WCAG violations with the shelf on screen', async () => {
    const { page } = session;
    await page.locator('button.search-trigger').click();
    await landed(page, session.flightMs);
    try {
      await page.locator('.center-books').waitFor({ state: 'visible', timeout: 5000 });
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const summary = violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.help}`);
      assert.deepEqual(summary, [], `axe reported violations with the shelf up:\n  ${summary.join('\n  ')}`);
    } finally {
      await page.locator('canvas').focus();
      await page.keyboard.press('Home');
      await page.waitForTimeout(session.flightMs + 200);
      await settled(page);
    }
  });

  test('a rearrangement says what it did and what is now under the cursor', async () => {
    const { page } = session;
    // accessibility-plan.md §4.3 has said since it was written that "the new
    // occupant is announced"; §8 item 4 recorded that phase C never wired it
    // up. Standing still while the library reorders around you and hearing
    // nothing is not an accessible rearrangement, whatever the animation does.
    const live = page.locator('[role=status]');
    await page.locator('button.search-trigger').click();
    await landed(page, session.flightMs);
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
    // rearrangement parks the camera on the center, so that is the honest
    // answer here rather than the cell the search was typed from.
    assert.match(
      said,
      /the center of the library|Room \d+|a blank wall|the far field/,
      `the announcement never names a cell: ${said}`
    );

    await page.locator('canvas').focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);
    await settled(page);
  });

  test('nothing was logged to the console', () => {
    assert.deepEqual(session.consoleErrors, []);
  });
});
