/**
 * The browser smoke test: accessibility-plan.md phases A/B and E - the axe
 * sweeps, the panel's accessible names, the card's focus handling, the live
 * region, reduced motion, and the sidecar's optional `alt` caption. One of
 * five files split out of the original `smoke.e2e.mjs` (see
 * `docs/implementation-plan.md`); see `map-gestures.e2e.mjs` for the shared
 * header comment on why and how. The map's own keyboard interface (phase C)
 * is `keyboard-cursor.e2e.mjs`, and the center room's shelf (phase D) is
 * `shelf.e2e.mjs`.
 *
 * The accessibility block asserts what only a browser can compute: an
 * accessible name comes from labels, roles and content together, so checking
 * the JSX would only restate the source. Those tests read the real tree back
 * out - `axNodes` for Chromium's computed properties, axe for the broad sweep.
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

describe('the library, in a browser: accessibility', { concurrency: false }, () => {
  let session;

  before(async () => {
    session = await openLibrary();
  });

  after(async () => {
    await closeLibrary(session, 'library-accessibility.png');
  });

  test('axe finds no WCAG violations on the opening view', async () => {
    const { page } = session;
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
    const { page } = session;
    // The "non-generic" slider defaults short of maxed, and at anything less
    // than 100% the density gradient CAN show a cluster - `gradedCount` counts
    // ranks the gradient lifts ABOVE the baseline, and there is no "above" left
    // once the baseline already is the maximum. Pulling it down first is what
    // makes a cluster possible at all; a maxed ratio would make this test time
    // out waiting for a listbox a correct app is right not to show.
    const ratio = page.locator('.row', { hasText: 'non-generic' }).locator('input[type=range]');
    await ratio.focus();
    await ratio.press('Home');

    // try/finally, not just a trailing restore at the end of the test: several
    // tests after this one - card focus, the live region, reduced motion - rely
    // on the map being dense and the camera centered, so an assertion failing
    // partway through must not ALSO strand those for everything that runs
    // afterward. That turns one failure into an unrelated-looking cascade,
    // which is exactly what made a flake here harder to diagnose than it
    // needed to be.
    try {
      // "brass" is a confirmed hit in the sample corpus's own metadata - see
      // `map-gestures.e2e.mjs`'s keyword chips test, which reads real keywords
      // off a real card. Anything that finds zero matches would test the empty
      // state instead of this one, so a query known to match is not a
      // convenience, it is the point. This search is also what several tests
      // later in this file lean on staying active - see the live-region and
      // reduced-motion tests below.
      await page.locator('button.search-trigger').click();
      await landed(page, session.flightMs);
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
      // (fitted tight on the center tile) rather than simply focusing it; an
      // assertion failing before this test flies anywhere else left the
      // camera there once, and a right-click at a fixed screen point in a
      // LATER test landed on the center tile's own controls instead of a room
      // - one test's failure taking down an unrelated one's precondition,
      // which is worse than the original failure. Clicking "center" is cheap
      // and makes every subsequent test's assumption ("a dense map, framed
      // normally") true regardless of how far this one got. Deliberately does
      // NOT clear the search query - the live-region and reduced-motion tests
      // below need it still active.
      await ratio.press('End');
      await page.getByRole('button', { name: 'center' }).click();
      await landed(page, session.flightMs);
    }
  });

  test('the panel controls carry accessible names, and the sliders say what they count', async () => {
    const { page } = session;
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
    const { page } = session;
    // Blocking page zoom is a WCAG 1.4.4 failure, and the attributes that did
    // it here are easy to reintroduce by reflex the next time a touch gesture
    // misbehaves on iOS. Asserted so that reflex fails loudly.
    const viewport = await page.locator('meta[name=viewport]').getAttribute('content');
    assert.doesNotMatch(viewport, /user-scalable\s*=\s*no/, 'page zoom must not be disabled');
    assert.doesNotMatch(viewport, /maximum-scale/, 'page zoom must not be capped');
  });

  test('the canvas is a named application region, not an anonymous graphic', async () => {
    const { page } = session;
    // Superseded by phase C: the canvas WAS `role="img"` with a static label,
    // a placeholder for the picture nobody could yet navigate. Now it is the
    // cursor's own `role="application"` region, named by whatever cell is
    // currently under the camera center.
    //
    // Named by WHICHEVER cell that is, and this test deliberately does not
    // move the camera to make it a known one. The rearrangement announcement
    // (§8 item 4) means a search moves the cursor as well as the map, so a
    // listbox jump earlier in this file can leave it on a room rather than
    // the center - and flying home to pin the name down would wipe the live
    // region the announcement test after this one reads. What must hold here
    // is the role and that the name is a real cell's, which is exactly what
    // an unlabelled graphic or a static placeholder would fail.
    const named = page.getByRole('application', {
      name: /the center of the library|Room \d+, rank \d+ of \d+|a blank wall|the far field/i,
    });
    await named.waitFor({ timeout: 5000 });
    assert.equal(await named.count(), 1, 'exactly one application region, and it is the map');
  });

  test('the card takes focus, is named by its room, and Escape gives focus back', async () => {
    const { page } = session;
    const card = page.locator('.card');

    // This used to right-click a fixed pixel with no setup of its own,
    // trusting the camera/ratio state the tests before it happened to leave
    // behind - which read as this test's own flake on a run where it didn't
    // (see git history). A dense map and a centered camera are a real,
    // checkable precondition, not a guess, so establish both explicitly
    // rather than lean on whatever ran earlier in this file.
    const ratio = page.locator('.row', { hasText: 'non-generic' }).locator('input[type=range]');
    await ratio.focus();
    await ratio.press('End');
    await page.getByRole('button', { name: 'center' }).click();
    await landed(page, session.flightMs);

    // And a single right-click can still land in the gap between a render and
    // the browser wiring up its context-menu handler on a loaded runner -
    // retry once rather than trust one attempt, but still fail loudly if the
    // card genuinely never shows.
    await page.mouse.click(880, 300, { button: 'right' });
    try {
      await card.waitFor({ timeout: 3000 });
    } catch {
      await page.mouse.click(880, 300, { button: 'right' });
      await card.waitFor({ timeout: 5000 });
    }

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
    const { page } = session;
    // The status text already existed and already said the right thing; it
    // simply updated a div nothing was listening to. The hint must stay OUT of
    // the live region - a node that falls back to the instructions would read
    // them aloud again every time a status cleared. Leans on the ranked-listbox
    // test's search ("brass") still being active.
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
    const { page } = session;
    // Asserted through the CAMERA rather than by watching for the absence of an
    // animation, which would be a race dressed up as a test. A normal
    // rearrangement parks the camera on the center first, because the slide is
    // planned against exactly the cells on screen. Reduced motion bails out
    // before that flight - there is no animation to set up, and moving someone's
    // camera unasked is the very thing they turned off - so the giveaway is a
    // camera that did not move at all.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    try {
      // Somewhere clearly not the center, so "did not move" is unambiguous.
      await page.mouse.move(700, 420);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(700 - i * 25, 420 - i * 15);
      await page.mouse.up();
      const before = await settled(page);
      assert.ok(
        Math.abs(before.x) > 0.2 || Math.abs(before.y) > 0.2,
        `the drag must leave the center, got (${before.x}, ${before.y})`
      );

      // "rescatter", not "reorder", and the difference is load-bearing: the
      // ranked-listbox test's search is still active by the time this runs, so
      // `order` is then `result.order` - the same array by reference no matter
      // how often `orderSeed` is bumped - so the render effect's deps never
      // change and "reorder" rearranges nothing at all. Rescatter bumps the
      // layout seed, which rebuilds `layout` and always triggers a
      // rearrangement. Written down because this test passed against a
      // deliberately broken app until the button was swapped.
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

    // Put the reader back on the center for whatever runs next.
    await page.getByRole('button', { name: 'center' }).click();
    await landed(page, session.flightMs);
  });

  test('keyboard focus is visible', async () => {
    const { page } = session;
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

  // --- the sidecar's optional alt (accessibility-plan.md phase E) ------------
  //
  // Last in this file because it reloads: everything above shares one page,
  // and a reload would wipe the search/ratio/camera state the tests above
  // this point lean on each other for.

  test("a room's picture caption is shown when the corpus carries one, and nothing is invented when it does not", async () => {
    const { page } = session;
    // Phase E is a format change plus a fallback, and producing the field is
    // the corpus generator's job upstream of this repo - so no corpus here
    // ships one, and the placeholder sidecar in `assets/corpus-sample/`
    // deliberately never will: a caption that describes nothing about the
    // image it is attached to is exactly the padded, confident sentence §3.5
    // says to write no caption instead of. Handing the PAGE a corpus that does
    // carry one is the only honest way to see the whole path - fetch, join,
    // describeCell, card - actually reach the screen.
    //
    // Sets its own camera and density rather than inheriting them: a reload
    // resets both, and at the opening view the center room fills the screen so
    // a fixed screen point would land on the one cell that is never a corpus
    // room.
    const openCard = async () => {
      const ratio = page.locator('.row', { hasText: 'non-generic' }).locator('input[type=range]');
      await ratio.focus();
      await ratio.press('End');
      await page.locator('canvas').focus();
      await page.keyboard.press('Home');
      await page.waitForTimeout(session.flightMs + 200);
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

  test('nothing was logged to the console', () => {
    assert.deepEqual(session.consoleErrors, []);
  });
});
