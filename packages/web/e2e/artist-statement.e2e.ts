/**
 * The artist's statement overlay: it opens as a two-page book from the center
 * shelf, it opens the Babel book ON TOP of itself, and Escape peels the two off
 * in order (book first, statement second) rather than closing both at once.
 * That last part is the whole reason `useDialog` grew a topmost-only stack, and
 * it is exactly the kind of thing only a real browser with two live `window`
 * keydown listeners can prove - so it lives here, not in a unit test.
 *
 * See `support.ts` for the shared harness and `accessibility.e2e.ts` for the
 * focus/Escape-restore pattern these follow. Not part of `npm test`; run with:
 *
 *   npx playwright install chromium   # once
 *   npm run test:e2e
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import { axFind, axNodes, closeLibrary, openLibrary } from './support.ts';

describe('the library, in a browser: the artist statement', { concurrency: false }, () => {
  let session;

  before(async () => {
    session = await openLibrary();
  });

  after(async () => {
    await closeLibrary(session, 'library-artist-statement.png');
  });

  // The center-book button is `display:none`/`pointer-events:none` until the
  // render loop shows it (the canvas owns the click via `centerBookAtPoint`),
  // so the honest way in for a test is the same one a keyboard reader has:
  // focus the button and press Enter.
  async function openStatement(page) {
    const book = page.locator('.center-book');
    await book.waitFor({ state: 'visible', timeout: 5000 });
    await book.focus();
    await page.keyboard.press('Enter');
    await page.locator('.statement-overlay').waitFor({ timeout: 5000 });
  }

  test('opens as a two-page book, named and focused, and axe-clean', async () => {
    const { page } = session;
    const statement = page.locator('.statement-overlay');
    try {
      await openStatement(page);

      // Focus moves into the dialog - otherwise a keyboard reader is told a
      // dialog opened and cannot reach a word of it.
      assert.ok(
        await page.evaluate(() =>
          document.activeElement?.classList.contains('statement-overlay')
        ),
        'the statement must take focus when it opens'
      );

      // Both pages are present, and each carries its own text - the myth on the
      // left, the real statement on the right.
      assert.equal(await page.locator('.statement-story').count(), 1, 'the story page');
      assert.equal(await page.locator('.statement-real').count(), 1, 'the statement page');
      assert.match(
        await page.locator('.statement-story').textContent(),
        /Oh time thy pyramids/,
        'the story page carries the myth'
      );
      assert.match(
        await page.locator('.statement-real').textContent(),
        /AI doesn't take away the human work/,
        'the statement page carries the real statement'
      );

      // Named by what it is, so a reader knows what opened.
      const dialog = axFind(await axNodes(page), 'dialog', /artist's statement/i);
      assert.ok(dialog, 'the statement must be named');

      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const summary = violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.help}`);
      assert.deepEqual(summary, [], `axe reported violations:\n  ${summary.join('\n  ')}`);
    } finally {
      await page.keyboard.press('Escape');
      await statement.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
  });

  test('the Babel book stacks over the statement and Escape peels them off in order', async () => {
    const { page } = session;
    const statement = page.locator('.statement-overlay');
    const babel = page.locator('.overlay-scrim.stacked');
    try {
      await openStatement(page);

      // "Click here to run some equivalent code" is a real inline button (the
      // one control on the page with pointer events), and it opens the Babel
      // book on top.
      await page.locator('.statement-link').click();
      await babel.waitFor({ timeout: 5000 });

      // The statement is still mounted - stacked over, not replaced - and set
      // back with the `behind` class while the book is up.
      assert.equal(await statement.count(), 1, 'the statement stays mounted under the book');
      assert.equal(
        await page.locator('.overlay-scrim.behind').count(),
        1,
        'the statement scrim is dimmed behind the book'
      );

      // The book, being topmost, is what took focus.
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        'a random book',
        'the book takes focus as the topmost dialog'
      );

      // One Escape closes only the book. If the topmost-only guard regresses,
      // this is where it shows: both would close and the statement would detach
      // here instead of below.
      await page.keyboard.press('Escape');
      await babel.waitFor({ state: 'detached', timeout: 5000 });
      assert.equal(await statement.count(), 1, 'the statement survives closing the book');
      assert.equal(
        await page.locator('.overlay-scrim.behind').count(),
        0,
        'the statement is no longer dimmed once the book is gone'
      );
      // Focus is handed back into the statement, onto the control that opened
      // the book.
      assert.ok(
        await page.evaluate(() =>
          document.activeElement?.classList.contains('statement-link')
        ),
        'closing the book returns focus to the control that opened it'
      );

      // A second Escape closes the statement, and focus lands back on the
      // center-book button that opened it - not stranded on a detached node.
      await page.keyboard.press('Escape');
      await statement.waitFor({ state: 'detached', timeout: 5000 });
      assert.ok(
        await page.evaluate(() =>
          document.activeElement?.classList.contains('center-book')
        ),
        'closing the statement returns focus to the center book'
      );
    } finally {
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await statement.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
  });

  test('the two pages collapse to one column when too narrow for two', async () => {
    const { page } = session;
    const statement = page.locator('.statement-overlay');
    const tracks = () =>
      page.evaluate(() => {
        const el = document.querySelector('.statement-book');
        return getComputedStyle(el).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
      });
    try {
      // Wide: two reading columns fit, so the book is a spread.
      await openStatement(page);
      assert.equal(await tracks(), 2, 'a wide display shows two pages side by side');

      // Narrow enough that two readable columns no longer fit - the collapse is
      // keyed off the book's own available width (a container query), not a
      // device or pointer gate, so shrinking the window is enough to trigger it.
      await page.setViewportSize({ width: 460, height: 800 });
      await page.waitForFunction(() => {
        const el = document.querySelector('.statement-book');
        return el && getComputedStyle(el).gridTemplateColumns.split(/\s+/).filter(Boolean).length === 1;
      }, null, { timeout: 5000 });
      assert.equal(await tracks(), 1, 'a narrow display stacks the pages in one column');
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.keyboard.press('Escape').catch(() => {});
      await statement.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
  });
});
