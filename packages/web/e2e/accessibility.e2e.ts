/**
 * The browser smoke test for accessibility: the axe sweeps, the panel's
 * accessible names, the card's focus handling, the live region, reduced
 * motion, and the sidecar's optional `alt` caption. See
 * `map-gestures.e2e.ts` for the shared header comment on why and how,
 * including how to run the suite. The map's own keyboard interface is
 * `keyboard-cursor.e2e.ts`, and the center room's shelf is `shelf.e2e.ts`.
 *
 * The accessibility block asserts what only a browser can compute: an
 * accessible name comes from labels, roles and content together, so checking
 * the JSX would only restate the source. Those tests read the real tree back
 * out - `axNodes` for Chromium's computed properties, axe for the broad sweep.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import {
  SEARCH_TIMEOUT, axFind, axNodes, closeLibrary, landed, openLibrary, settled, waitFor,
} from './support.ts';

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
    // The broad net under the specific assertions below: an unlabelled
    // control, a bad contrast ratio, a role missing a required attribute,
    // anywhere on the page. It does not replace the named tests; axe can tell
    // that the rooms slider has a name, not that the name says what it counts.
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const summary = violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.help}`);
    assert.deepEqual(summary, [], `axe reported violations:\n  ${summary.join('\n  ')}`);
  });

  test('the ranked listbox is honestly counted, reachable with no arrow keys, and axe-clean [SR-48]', async () => {
    const { page } = session;
    // The "non-generic" slider defaults short of maxed, and at anything less
    // than 100% the density gradient can show a cluster - `gradedCount` counts
    // ranks the gradient lifts above the baseline, and there is no "above" left
    // once the baseline already is the maximum. Pulling it down first is what
    // makes a cluster possible at all; a maxed ratio would make this test time
    // out waiting for a listbox a correct app is right not to show.
    const ratio = page.locator('.row', { hasText: 'non-generic' }).locator('input[type=range]');
    await ratio.focus();
    await ratio.press('Home');

    // Later tests (card focus, the live region, reduced motion) need a dense
    // map and a centered camera, so the restore is in `finally` (see
    // docs/agents/testing.md, "Test cleanup belongs in `finally`").
    try {
      // "clockwork" is a keyword in the sample corpus's own metadata, so it
      // ranks real results rather than falling back to CLIP alone. A query
      // with zero matches would test the empty state instead. The live-region
      // and reduced-motion tests later in this file need this search to stay
      // active.
      await page.locator('button.search-trigger').click();
      await landed(page, session.flightMs);
      await page.locator('input[type=search]').fill('clockwork');
      await page.locator('input[type=search]').press('Enter');

      const results = page.locator('.results-list');
      await results.waitFor({ timeout: SEARCH_TIMEOUT });

      // Wait for the mounted count to hold across two reads. `.results-list`
      // existing does not mean the search is done: CLIP embeddings load
      // asynchronously and can re-rank a keyword/story-only result shortly
      // after it appears (see `SEARCH_TIMEOUT`).
      const options = results.locator('.result');
      let previousCount = null;
      let count;
      // `previousCount` starts at `null`, which no real count equals, so two
      // agreeing reads are always at least one `waitFor` poll interval apart.
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

      // Wait for the search's rearrangement to settle. Later tests read its
      // announcement from the live region, and the announcement fires only
      // once the rearrangement settles and is still current, so a later layout
      // change mid-animation would drop it as stale. The center-tile loading
      // indicator (`loadingAnimation.ts`) adds a full cycle to that settle.
      await settled(page);

      const label = await page.locator('#results-label').textContent();
      const first = results.locator('li').first();
      const posinset = await first.getAttribute('aria-posinset');
      const setsize = await first.getAttribute('aria-setsize');

      // The label reports the true match count, not just the mounted window.
      assert.match(label, /results\s+\d+/, `the results label must report a count, got ${JSON.stringify(label)}`);

      // `aria-setsize`/`aria-posinset` go on the `<li>`, since only `listitem`
      // supports them (axe's `aria-allowed-attr` rule catches them on the
      // button). CDP's `Accessibility.getFullAXTree` does not surface either
      // property for a native `<li>`, so this checks only that the DOM carries
      // the values, not that a screen reader receives them (issue #243).
      assert.equal(posinset, '1');
      assert.ok(Number(setsize) >= count, `setsize ${setsize} must be at least the ${count} mounted`);

      // The button carries the name a reader hears. `listitem` has no "name
      // from contents" in the accessible-name algorithm, so the `<li>` is
      // nameless in the tree. Checked last because the CDP round trip is slow.
      const nodes = await axNodes(page);
      assert.ok(axFind(nodes, 'button', /^Room \d+/), 'a result button must be named by its room');

      // No arrow keys in this flow; the listbox is reachable with focus and
      // Enter alone. The map's arrow-key interface is `keyboard-cursor.e2e.ts`.
      await options.first().focus();
      await page.keyboard.press('Enter');

      const card = page.locator('.overlay');
      await card.waitFor({ timeout: 5000 });
      // Compare the dialog's accessible name, not `.card-id`'s visible text,
      // which leads with the room's title when it has one. The name
      // (`desc.name`) comes from the same `describeRoom` call that built the
      // result button's text, so the two match exactly.
      const cardLabel = await card.getAttribute('aria-label');
      const firstResultText = await options.first().textContent();
      assert.equal(
        cardLabel, firstResultText,
        `the opened card must be the room the result named: ${JSON.stringify({ firstResultText, cardLabel })}`
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
      // Restores the ratio and the camera. A search trigger that finds the
      // field off screen flies to the far-zoomed `opening` view, where a later
      // test's right-click at a fixed screen point would land on the center
      // tile's controls instead of a room. Leaves the search query active for
      // the live-region and reduced-motion tests.
      await ratio.press('End');
      await page.getByRole('button', { name: 'center' }).click();
      await landed(page, session.flightMs);
    }
  });

  test('the panel controls carry accessible names, and the sliders say what they count', async () => {
    const { page } = session;
    const nodes = await axNodes(page);

    // A slider whose label is a sibling with no `htmlFor` reaches the reader
    // as a bare number with no indication of what it measures.
    const rooms = axFind(nodes, 'slider', /rooms on the map/i);
    const ratio = axFind(nodes, 'slider', /non-generic/i);
    assert.ok(rooms, 'the rooms slider must have an accessible name');
    assert.ok(ratio, 'the ratio slider must have an accessible name');

    // The name must also say what the number counts. This asserts on `name`,
    // not `aria-valuetext` (see docs/agents/testing.md, "Assert on the
    // accessible name, not raw ARIA attributes"). It fails both on a label
    // with no `htmlFor`, which leaves no name to match, and on a label that
    // says only a bare number.
    //
    // Both sliders are checked before either is asserted, and the failure
    // dumps both nodes, so a missing attribute and an ignored one read apart.
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
    // The canvas is the cursor's own `role="application"` region, named by
    // whatever cell is currently under the camera center - not a static label
    // on a picture nobody can navigate.
    //
    // Named by whichever cell that is, and this test does not move the camera
    // to make it a known one. The rearrangement announcement means a search
    // moves the cursor as well as the map, so a listbox jump earlier in this
    // file can leave it on a room rather than the center - and flying home to
    // pin the name down would wipe the live region the announcement test after
    // this one reads. What must hold here is the role and that the name is a
    // real cell's, which an unlabelled graphic or a static placeholder fails.
    const named = page.getByRole('application', {
      name: /the center of the library|Room \d+, rank \d+ of \d+|a blank wall|the far field/i,
    });
    await named.waitFor({ timeout: 5000 });
    assert.equal(await named.count(), 1, 'exactly one application region, and it is the map');
  });

  test('the card takes focus, is named by its room, and Escape gives focus back', async () => {
    const { page } = session;
    const card = page.locator('.overlay');

    // A dense map and a centered camera are real, checkable preconditions -
    // establish both rather than lean on whatever the tests before this one
    // happened to leave behind, which reads as this test's own flake when
    // they don't hold.
    const ratio = page.locator('.row', { hasText: 'non-generic' }).locator('input[type=range]');
    await ratio.focus();
    await ratio.press('End');
    await page.getByRole('button', { name: 'center' }).click();
    await landed(page, session.flightMs);

    // And a single right-click can still land in the gap between a render and
    // the browser wiring up its context-menu handler on a loaded runner -
    // retry once rather than trust one attempt, but still fail if the card
    // never shows.
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
      await page.evaluate(() => document.activeElement?.classList.contains('overlay')),
      'the card must take focus when it opens'
    );

    // And it is named by the room it describes (its `aria-label`,
    // `desc.name`), not just "room".
    const dialog = axFind(await axNodes(page), 'dialog', /^room \d+/i);
    assert.ok(dialog, 'the card must be named by the room it describes');

    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });

    // And focus is not stranded on the node that just left the document, which
    // is the way this breaks: focus on a detached element belongs to nothing,
    // Tab restarts from the top, and a screen reader is left describing a card
    // that is no longer there.
    //
    // Focus return to the opener is not asserted here. Right-clicking the
    // canvas blurs the focused control to the body before the card mounts, so
    // a pointer-opened card has no opener. `RoomOverlay` restores focus when
    // there is one; `keyboard-cursor.e2e.ts` asserts it for a card opened
    // with Enter on the map cursor.
    assert.ok(
      await page.evaluate(() => document.activeElement?.isConnected ?? false),
      'focus must not be left on a detached node'
    );
  });

  test('what the map just did is announced politely [SR-47]', async () => {
    const { page } = session;
    // The hint must stay out of the live region - a node that falls back to
    // the instructions would read them aloud again every time a status
    // cleared. Leans on the ranked-listbox test's search ("clockwork") still
    // being active.
    const live = page.locator('[role=status]');
    await live.waitFor({ timeout: 5000 });
    await waitFor(
      async () => /ranked by/.test((await live.textContent()) ?? ''),
      SEARCH_TIMEOUT,
      'the live region never carried the result of the search'
    );
    assert.doesNotMatch(await live.textContent(), /drag to pan/, 'the hint must not be announced');
  });

  test('reduced motion rebuilds the library instead of sliding it [SR-31]', async () => {
    const { page } = session;
    // Asserted through the camera, since watching for the absence of an
    // animation would race. A normal rearrangement zooms out in place to plan
    // the slide against the cells on screen, then flies back to the reader's
    // zoom (`startRearrangement`, `useRearrangement.ts`). Reduced motion
    // returns before that flight, so the camera must not move at all.
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

      // "rescatter", not "reorder": "reorder" clears any active search as
      // part of its own reshuffle, which would confound this test's own
      // camera-didn't-move assertion with a second rearrangement it didn't
      // ask for. Rescatter only bumps the layout seed, which rebuilds
      // `layout` and always triggers a rearrangement on its own, with no
      // search to clear.
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
    // `outline: none` with a border-colour shift instead reads as perfectly
    // reasonable in the stylesheet, so the computed outline is what this
    // reads back - the only place that regression is visible.
    // Focus has to arrive by keyboard. `:focus-visible` follows the most recent
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

  // --- the sidecar's optional alt caption ------------------------------------
  //
  // Last in this file because it reloads: everything above shares one page,
  // and a reload would wipe the search/ratio/camera state the tests above
  // this point lean on each other for.

  test("a room's picture caption becomes real <img alt> text in the catalog and overlay, and nothing is invented when it is absent", async () => {
    const { page } = session;
    // The sample corpus ships a caption for every room (the curation tools
    // produce it upstream of this repo), so the present case runs end to end
    // (fetch, join, `describeRoom`, `<img alt>`) against the corpus as it
    // ships. The absent case, where nothing may be invented in the caption's
    // place, is produced by routing the sidecar's `alt` back out.
    const openCatalogHere = async () => {
      await page.locator('.panel .mode-toggle').click();
      await page.locator('.catalog').waitFor({ timeout: 5000 });
      await page.locator('.catalog-row').first().waitFor({ timeout: 5000 });
    };
    const closeCatalogHere = async () => {
      await page.locator('.catalog .mode-toggle').click();
      await page.locator('.catalog').waitFor({ state: 'detached', timeout: 5000 });
      await settled(page);
    };

    // Every caption the corpus actually ships, so the assertions can check "a
    // real one reached the screen" without pinning which room lands in row 1 or
    // what its exact text is - both free to move as the sample set does. Read it
    // the way the app does - `api/manifest`, then `manifest.metadata.url` - so
    // the relative urls resolve through `<base href>` as they do in the client
    // (see docs/agents/deploy.md, "Deployment and the base path").
    const sidecar = (await page.evaluate(async () => {
      const manifest = await (await fetch('api/manifest')).json();
      return (await fetch(manifest.metadata.url)).json();
    })) as Record<string, { alt?: unknown }>;
    const captions = new Set(
      Object.values(sidecar)
        .map((room) => room.alt)
        .filter((alt): alt is string => typeof alt === 'string' && alt.length > 0)
    );
    assert.ok(captions.size > 0, 'the sample corpus must ship captions for this test to mean anything');

    // As it ships: the room's own caption reaches the tag, unchanged. Row 0 is
    // the center; row 1 is the first real room.
    await openCatalogHere();
    let row = page.locator('.catalog-row').nth(1);
    const shipped = await row.locator('.catalog-tile').getAttribute('alt');
    assert.ok(
      captions.has(shipped),
      `the catalog tile must carry the room's shipped caption, got ${JSON.stringify(shipped)}`
    );

    await row.locator('.catalog-tile-button').click();
    let overlay = page.locator('.overlay');
    await overlay.waitFor({ timeout: 5000 });
    assert.equal(
      await overlay.locator('.overlay-tile').getAttribute('alt'),
      shipped,
      'the overlay must show the same caption as the row it opened from'
    );
    // And it stays a different thing from the story. The story is fiction about
    // the room and the caption is a report of the image; a reader has to be able
    // to tell which they are being told, so they are two nodes.
    const story = await overlay.locator('.story').first().textContent();
    assert.notEqual(story, shipped, 'the caption must not have replaced the story');
    await page.keyboard.press('Escape');
    await overlay.waitFor({ state: 'detached', timeout: 5000 });
    await closeCatalogHere();

    // The one consumer with no `<img>` to put the caption on - the map canvas's
    // own fallback content, read by a touch screen reader - still carries it
    // as text.
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(session.flightMs + 200);
    // `state: 'attached'`, not the default `'visible'` - canvas fallback content
    // is never painted, so it cannot satisfy Playwright's visibility check
    // even though it is present in the tree.
    await canvas.locator('.picture').waitFor({ state: 'attached', timeout: 5000 });
    assert.ok(
      captions.has(await canvas.locator('.picture').textContent()),
      'the map fallback must carry the room\'s real caption'
    );

    // Absent: strip every caption back out, and nothing may be invented to fill
    // the gap.
    await page.route('**/metadata.json', async (route) => {
      const sidecar = await (await route.fetch()).json();
      for (const key of Object.keys(sidecar)) {
        const { alt: _drop, ...rest } = sidecar[key];
        sidecar[key] = rest;
      }
      await route.fulfill({ json: sidecar });
    });
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => /[1-9]\d* drawn/.test(document.getElementById('hud')?.textContent ?? ''),
        null,
        { timeout: 30_000 }
      );

      await openCatalogHere();
      row = page.locator('.catalog-row').nth(1);
      assert.equal(await row.locator('.catalog-tile').getAttribute('alt'), '', 'no sidecar alt, no invented caption');

      await row.locator('.catalog-tile-button').click();
      overlay = page.locator('.overlay');
      await overlay.waitFor({ timeout: 5000 });
      assert.equal(await overlay.locator('.overlay-tile').getAttribute('alt'), '');
      await page.keyboard.press('Escape');
      await overlay.waitFor({ state: 'detached', timeout: 5000 });
      await closeCatalogHere();
    } finally {
      await page.unroute('**/metadata.json');
    }
  });

  test('nothing was logged to the console', () => {
    assert.deepEqual(session.consoleErrors, []);
  });
});
