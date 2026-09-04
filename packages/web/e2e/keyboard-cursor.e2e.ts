/**
 * The browser smoke test: the map's own keyboard interface
 * (docs/accessibility-plan.md phase C) - the keyboard cursor, arrow panning,
 * the boundary announcement, PageUp/PageDown zoom, and the `/`/`?` shortcuts.
 * One of five files split out of the original `smoke.e2e.mjs` (see
 * `docs/implementation-plan.md`); see `map-gestures.e2e.ts` for the shared
 * header comment on why and how.
 *
 * `role="application"` on the canvas turns off a screen reader's browse-mode
 * reading for exactly this element, which is what lets arrow keys reach the
 * page at all rather than being consumed by the reader's own navigation. None
 * of that can be asserted from JSX - only a real browser resolves whether a
 * role actually changes what a key press does.
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
import { SEARCH_TIMEOUT, closeLibrary, hud, landed, openLibrary, waitFor } from './support.ts';

describe('the library, in a browser: the keyboard cursor', { concurrency: false }, () => {
  let session;

  before(async () => {
    session = await openLibrary();
  });

  after(async () => {
    await closeLibrary(session, 'library-keyboard-cursor.png');
  });

  test('the map is reachable, and the sample corpus is small enough to have a real edge', async () => {
    const { page } = session;
    // The 26-room sample corpus gives a `boundaryRadius` of only a few cells
    // even fully dense - discovered while driving this by hand, not designed
    // in - which is what makes the boundary-crossing test below reachable in
    // a handful of presses rather than needing a huge synthetic corpus.
    const ratio = page.locator('.row', { hasText: 'non-generic' }).locator('input[type=range]');
    await ratio.focus();
    await ratio.press('End');

    await page.locator('canvas').focus();
    // Home for the same reason as the application-region test in
    // `accessibility.e2e.ts`: the cursor follows a rearrangement now, not
    // only a keypress, so where a fresh page load leaves it is not a
    // precondition to lean on.
    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);
    await assert.doesNotReject(
      page.getByRole('application', { name: /center of the library/i }).waitFor({ timeout: 2000 })
    );
  });

  test('arrows pan the cursor and announce it; ctrl+arrow always lands on a room', async () => {
    const { page } = session;
    const canvas = page.locator('canvas');
    const live = page.locator('[role=status]');

    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);
    const home = await hud(page);

    await page.keyboard.press('ArrowRight');
    await waitFor(
      async () => (await hud(page)).x !== home.x,
      2000,
      'an arrow press must move the camera by exactly one cell'
    );
    const afterOneStep = await hud(page);
    assert.ok(
      Math.abs(afterOneStep.x - home.x - 1) < 1e-6,
      `one arrow press must move exactly one cell: ${home.x} -> ${afterOneStep.x}`
    );
    await waitFor(
      async () => /Room \d+|a Babel shelf/.test((await live.textContent()) ?? ''),
      2000,
      'an arrow press must announce something about the new cursor cell'
    );

    // Ctrl+arrow's whole point: whatever it lands on, if it finds anything at
    // all, is a real room - never the wallpaper a plain arrow could have just
    // as easily landed on. That is the one thing worth asserting without
    // hard-coding a room id or a step count from the sample corpus, both of
    // which would be pinning an art/layout fact this test does not own.
    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);
    await page.keyboard.press('Control+ArrowRight');
    await waitFor(
      async () => /^Room \d+|^nothing further/.test((await live.textContent()) ?? ''),
      2000,
      'ctrl+arrow must announce a room or say it found nothing'
    );
    const ctrlArrowText = await live.textContent();
    if (!/^nothing further/.test(ctrlArrowText)) {
      assert.match(ctrlArrowText, /^Room \d+/, 'ctrl+arrow must never land announcing a generic shelf');
      // And it must actually have MOVED the camera - a room announcement
      // without a matching jump would mean the text and the map disagree.
      await waitFor(async () => (await hud(page)).x !== home.x, 2000, 'ctrl+arrow never moved the camera');
    }
  });

  test('the boundary is announced once on crossing, not on every step past it', async () => {
    const { page } = session;
    const canvas = page.locator('canvas');
    const live = page.locator('[role=status]');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);

    // Walk outward until the crossing message appears, or give up - the exact
    // step count depends on which direction the corpus's slots happen to
    // extend, so this does not hard-code one.
    let crossedAt = -1;
    for (let i = 1; i <= 30; i++) {
      await page.keyboard.press('ArrowRight');
      const text = (await live.textContent()) ?? '';
      if (/edge of the library/.test(text)) {
        crossedAt = i;
        break;
      }
    }
    assert.ok(crossedAt > 0, 'walking outward must eventually cross the boundary and say so');

    // One more step past it must NOT repeat the boundary sentence - only the
    // crossing itself is announced, or the room name would be drowned every
    // single press through the far field.
    await page.keyboard.press('ArrowRight');
    const next = (await live.textContent()) ?? '';
    assert.doesNotMatch(next, /edge of the library/, 'the boundary sentence must not repeat on every step');
  });

  test('Home and ctrl+Home fly the cursor, and Enter opens what it lands on', async () => {
    const { page } = session;
    const canvas = page.locator('canvas');
    const live = page.locator('[role=status]');
    await canvas.focus();

    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(session.flightMs + 200);
    await waitFor(
      async () => /^Room \d+, rank 1 of/.test((await live.textContent()) ?? ''),
      2000,
      'ctrl+Home must land on the best-ranked room (rank 1)'
    );

    // Standing on a real room, Enter opens its card - the keyboard path into
    // a room's content that right-click and long-press never gave a keyboard
    // user.
    await page.keyboard.press('Enter');
    const card = page.locator('.overlay');
    await card.waitFor({ timeout: 5000 });
    // `.card-id` now leads with the room's title when it has one, so a real
    // room is confirmed via the dialog's own accessible name (`desc.name`,
    // `describeRoom`) instead - unaffected by title/filename display order.
    assert.match(await card.getAttribute('aria-label'), /^Room \d+/);

    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(
      await page.evaluate(() => document.activeElement?.tagName),
      'CANVAS',
      'closing a card opened by the map keyboard must return focus to the map'
    );

    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);
    await waitFor(
      async () => (await live.textContent()) === 'the center of the library',
      2000,
      'Home must return to the center and announce it'
    );
  });

  test('PageUp/PageDown zoom without moving the cursor cell', async () => {
    const { page } = session;
    // A keyboard zoom eases over `camera.keyboardMoveMs`, so the HUD is not
    // final the moment `page.keyboard.press` returns - poll for the change
    // rather than reading once. This needed polling even back when the move
    // was instant, because "instant" still meant "on the next animation
    // frame"; it raced about one run in four then, and the easing only widens
    // the window. Same discipline `settled()` uses for its own asynchrony.
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);
    const before = await hud(page);

    await page.keyboard.press('PageUp');
    await waitFor(async () => (await hud(page)).zoom !== before.zoom, 2000, 'PageUp never changed the zoom');
    const zoomedIn = await hud(page);
    assert.ok(zoomedIn.zoom > before.zoom, `PageUp must zoom in: ${before.zoom} -> ${zoomedIn.zoom}`);
    assert.ok(Math.abs(zoomedIn.x - before.x) < 1e-6, 'PageUp must not pan the cursor');
    assert.ok(Math.abs(zoomedIn.y - before.y) < 1e-6, 'PageUp must not pan the cursor');

    await page.keyboard.press('PageDown');
    await page.keyboard.press('PageDown');
    await waitFor(
      async () => (await hud(page)).zoom < before.zoom,
      2000,
      'PageDown never brought the zoom back below where it started'
    );
    const zoomedOut = await hud(page);
    assert.ok(zoomedOut.zoom < before.zoom, `PageDown must zoom out: ${before.zoom} -> ${zoomedOut.zoom}`);
  });

  test('a keyboard nudge eases under normal motion and arrives at once under reduced motion', async () => {
    const { page } = session;
    // The keyboard used to write the camera directly - instant, no animation
    // at all, which read as jarring against a search or a click that always
    // eases. `keyboardMoveMs` (config) gives a short flight instead; this is
    // the only layer that can see whether one is actually happening, since
    // `flyTo`'s timing lives in a rAF loop no unit test drives.
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);
    const before = await hud(page);

    await page.keyboard.press('ArrowRight');
    const samples = [];
    for (let i = 0; i < 8; i++) {
      samples.push((await hud(page)).x);
      await page.waitForTimeout(20);
    }
    // Three, not merely more-than-one: an "instant" arrival still spans two
    // distinct values in a sampling window this wide, because the flight
    // machinery takes exactly one rAF tick even at 0ms duration to notice it
    // is already done - `before.x` on the sample that lands before that tick,
    // `before.x + 1` on every one after. That two-value pattern is what a
    // broken "always instant" sabotage produces and this test failed to catch
    // the first time it was written; three or more values is only reachable
    // by genuinely easing across several frames of `keyboardMoveMs`.
    const distinctValues = new Set(samples.map((x) => x.toFixed(3))).size;
    assert.ok(
      distinctValues >= 3,
      `an arrow press under normal motion must ease across several frames, saw ${JSON.stringify(samples)}`
    );
    await waitFor(async () => (await hud(page)).x === before.x + 1, 1000, 'the arrow press never finished arriving');

    await page.getByRole('button', { name: 'center' }).click();
    await landed(page, session.flightMs);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    try {
      await canvas.focus();
      await page.keyboard.press('Home');
      await page.waitForTimeout(50);
      const rmBefore = await hud(page);
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(30); // well under keyboardMoveMs - nothing to ease if this is instant
      const rmAfter = await hud(page);
      assert.equal(
        rmAfter.x, rmBefore.x + 1,
        `reduced motion must arrive at once, not ease: ${rmBefore.x} -> ${rmAfter.x} after 30ms`
      );
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }

    await page.getByRole('button', { name: 'center' }).click();
    await landed(page, session.flightMs);
  });

  test('rapid keyboard presses compound instead of collapsing into one', async () => {
    const { page } = session;
    // A real regression, found driving this by hand: two PageDown presses back
    // to back both read the camera's pre-flight zoom (nothing had eased yet,
    // even one frame in) and computed the SAME target, so the second press
    // silently cancelled the first instead of zooming out twice. Fixed by
    // chaining off the in-flight target rather than the interpolated one;
    // this is the test that would have caught it.
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);
    const before = await hud(page);

    await page.keyboard.press('PageUp');
    await waitFor(async () => (await hud(page)).zoom !== before.zoom, 1000, 'PageUp never took effect');
    const zoomedIn = await hud(page);

    await page.keyboard.press('PageDown');
    await page.keyboard.press('PageDown');
    await waitFor(
      async () => (await hud(page)).zoom < before.zoom,
      2000,
      'two PageDown presses must bring the zoom back below the starting point, not just to it'
    );
    const zoomedOut = await hud(page);
    assert.ok(
      zoomedOut.zoom < before.zoom * 0.9,
      `two PageDown presses must compound: started ${before.zoom}, zoomed in to ${zoomedIn.zoom}, ` +
        `two steps back landed at ${zoomedOut.zoom} - a single collapsed step would land back near ${before.zoom}`
    );

    // Same check the other direction, cheaply: two rapid arrow presses must
    // move two cells, not one.
    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);
    const beforeArrows = await hud(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await waitFor(
      async () => (await hud(page)).x === beforeArrows.x + 2,
      1000,
      'two rapid arrow presses must move two cells, not collapse into one'
    );

    await page.getByRole('button', { name: 'center' }).click();
    await landed(page, session.flightMs);
  });

  test('arrows re-center the map after a trip outside the boundary', async () => {
    const { page } = session;
    // Reported from real use: after pushing past the border the camera settles
    // off-center from the cursor's own cell - part of it hanging off the screen
    // edge - and arrowing around in bounds never fixes it, while a zoom or a
    // ctrl+arrow does. The cause is that a trip outside leaves the camera off
    // the grid (damped steps out there are fractional by design, and the glide
    // stops wherever it happens to cross back in), and a raw per-press delta
    // carries that offset forever.
    //
    // Only a browser reaches this: it needs the real damping, the real glide,
    // and the real settling between them.
    const canvas = page.locator('canvas');
    await page.getByRole('button', { name: 'center' }).click();
    await landed(page, session.flightMs);
    await canvas.focus();

    // Push out past the edge, then let the glide carry the camera back in.
    await page.keyboard.down('ArrowRight');
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(33);
      await page.keyboard.down('ArrowRight');
    }
    await page.keyboard.up('ArrowRight');

    const outsideNow = await hud(page);
    assert.ok(outsideNow.x > outsideNow.edge, `the hold must end outside: x=${outsideNow.x}, edge=${outsideNow.edge}`);

    // Walk back in. Once inside, a press must land the camera cell-centered on
    // BOTH axes - the offset a trip outward leaves is rarely axis-aligned, so
    // an implementation that only fixed the axis being moved along would leave
    // the other one crooked forever.
    const offCenter = (v) => Math.abs(v - Math.floor(v) - 0.5);
    await waitFor(
      async () => {
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(250);
        const c = await hud(page);
        // The HUD rounds to one decimal, so "centered" is .5 within that.
        return c.x < c.edge && offCenter(c.x) < 0.05 && offCenter(c.y) < 0.05;
      },
      15000,
      'arrowing back in bounds never re-centered the camera on its cell'
    );

    // And it stays centered, one clean cell per press, rather than re-acquiring
    // an offset as it goes.
    for (let i = 0; i < 3; i++) {
      const before = await hud(page);
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(300);
      const after = await hud(page);
      assert.ok(
        offCenter(after.x) < 0.05 && offCenter(after.y) < 0.05,
        `press ${i + 1} left the camera off-center: x=${after.x}, y=${after.y}`
      );
      assert.ok(
        Math.abs(after.x - before.x + 1) < 0.05,
        `press ${i + 1} must move exactly one cell: ${before.x} -> ${after.x}`
      );
    }

    await page.getByRole('button', { name: 'center' }).click();
    await landed(page, session.flightMs);
  });

  test('a held arrow key cannot outrun what a hand can drag to', async () => {
    const { page } = session;
    // Parity, and the only place it can be observed: holding a key is a real
    // browser behaviour (the OS repeats `keydown` ~30x a second for as long as
    // it is down, each flagged `repeat: true`) that no unit test produces and
    // no single `press()` reproduces.
    //
    // The bug this pins: damping the keyboard with the POINTER's curve looks
    // right and is not. `panByPixels` floors its scale at 0.12 so a drag never
    // feels frozen, which costs nothing because a hand runs out of screen -
    // but for a key that repeats indefinitely, any non-zero floor is a
    // constant outward velocity. Measured with the shared curve, a six-second
    // hold reached 31 cells past a boundary eight full-width drags could only
    // push 15 past, and it was still climbing linearly.
    const canvas = page.locator('canvas');
    const recentre = async () => {
      await page.getByRole('button', { name: 'center' }).click();
      await landed(page, session.flightMs);
    };

    /** Hold ArrowRight for real: `down()` again while held sends repeat keydowns. */
    const hold = async (repeats) => {
      await canvas.focus();
      await page.keyboard.down('ArrowRight');
      for (let i = 0; i < repeats; i++) {
        await page.waitForTimeout(33);
        await page.keyboard.down('ArrowRight');
      }
      await page.keyboard.up('ArrowRight');
      return (await hud(page)).x;
    };

    await recentre();
    const brief = await hold(30);

    await recentre();
    const long = await hold(180);

    // Six times the input must not buy anything like six times the distance -
    // the step has to approach zero as the resistance does. A floored curve
    // grows linearly and would sail past this.
    assert.ok(
      long < brief * 2,
      `a six-times-longer hold must not travel proportionally further: ` +
        `30 repeats reached ${brief}, 180 reached ${long}`
    );

    // And the absolute reach stays in the same neighbourhood a determined
    // drag gets to, which is what "parity" actually means here. Generous
    // bound: this is asserting an order of magnitude, not a tuned constant.
    const { edge } = await hud(page);
    assert.ok(
      long < edge + 40,
      `a held key must not sail off into the far field: reached ${long}, edge at ${edge}`
    );

    await recentre();
  });

  test('the edge pushes back on a keyboard cursor too, and respects reduced motion', async () => {
    const { page } = session;
    // The boundary's pan resistance is a REAL affordance, not an obstacle for
    // the keyboard to be exempted from: walking out past the last ranked room
    // and feeling the library pull you home is the same thing a pointer drag
    // gets on release (accessibility-plan.md §3.1's "the edge speaks").
    //
    // Written after shipping the opposite. An earlier fix exempted every
    // landed flight from the glide, on the theory that correcting a
    // keyboard-placed camera would fight the cursor's announced position -
    // which got the causality backwards (the cursor is DERIVED from the
    // camera, so it simply moves with it) and, because the exemption was set
    // on every landing and only cleared by a pointerdown, silently disabled
    // the pushback for the entire keyboard session. This is the test that
    // would have caught that.
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);

    let crossedX = null;
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(200);
      const text = (await page.locator('[role=status]').textContent()) ?? '';
      if (/edge of the library/.test(text)) {
        crossedX = (await hud(page)).x;
        break;
      }
    }
    assert.ok(crossedX !== null, 'walking outward must cross the boundary within a bounded number of presses');

    // Walk a few cells clear of the boundary so the pull is unambiguous, then
    // stop touching anything. The drift back must happen on its own - no
    // pointer, no further keys. A mouse pan producing a sudden correction that
    // idling does not is precisely the "snaps back when I try to pan" symptom.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(200);
    }
    const far = await hud(page);
    assert.ok(far.x > far.edge, `the walk must end outside the content region: x=${far.x}, edge=${far.edge}`);

    await waitFor(
      async () => (await hud(page)).x < far.x - 0.5,
      5000,
      'the edge must pull a keyboard-placed camera back on its own, with no pointer involved'
    );

    // And it keeps pulling toward the region rather than stalling partway.
    const settling = await hud(page);
    await waitFor(
      async () => (await hud(page)).x < settling.x,
      5000,
      'the pull must continue, not stop after one frame'
    );

    // Reduced motion gets the same correction without the frames it takes to
    // ease there - the glide had never checked the setting at all, an ambient
    // gap older than any of the keyboard work.
    await page.getByRole('button', { name: 'center' }).click();
    await landed(page, session.flightMs);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    try {
      await page.mouse.move(900, 400);
      await page.mouse.down();
      await page.mouse.move(0, 400, { steps: 5 });
      await page.mouse.up();
      const justReleased = (await hud(page)).x;
      await page.waitForTimeout(80);
      const afterOneFrame = (await hud(page)).x;
      await page.waitForTimeout(1200);
      const later = (await hud(page)).x;
      assert.notEqual(justReleased, afterOneFrame, 'a release outside the region must still correct SOMETHING');
      assert.equal(
        afterOneFrame, later,
        `reduced motion must settle the glide near-instantly, not ease it over seconds: ${afterOneFrame} -> ${later}`
      );
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }

    await page.getByRole('button', { name: 'center' }).click();
    await landed(page, session.flightMs);
  });

  test('/ reaches the search field from the map keyboard', async () => {
    const { page } = session;
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);

    await page.keyboard.press('/');
    await waitFor(
      async () => (await page.evaluate(() => document.activeElement?.tagName)) === 'INPUT',
      2000,
      '/ must move focus to the search field'
    );
  });

  test('? announces the surroundings, on request rather than on every move', async () => {
    const { page } = session;
    const canvas = page.locator('canvas');
    const live = page.locator('[role=status]');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.waitForTimeout(session.flightMs + 200);

    await page.keyboard.press('?');
    await waitFor(
      async () => /edge of the library is about/.test((await live.textContent()) ?? ''),
      2000,
      '? must report the distance to the edge'
    );
  });

  test("the cursor's own story and chips are real, touch-reachable elements - not gated on Enter", async () => {
    const { page } = session;
    // `role="application"` plus a keyboard IS the desktop story, but VoiceOver
    // and TalkBack have nothing that corresponds to "press Enter" - accessibility-
    // plan.md §4.2b/§4.4 requires the cursor's content to be reachable without
    // it. Canvas fallback content is never PAINTED (that is the whole point -
    // it does not duplicate what is already on screen for sighted users), so a
    // real pointer click cannot reach it; `dispatchEvent` is the stand-in here
    // for how an assistive technology's own activation lands on an element
    // regardless of visibility.
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(session.flightMs + 200);

    const chips = canvas.locator('button');
    await waitFor(async () => (await chips.count()) > 0, 2000, 'the best-ranked room must have keyword chips');
    const term = await chips.first().textContent();

    await chips.first().dispatchEvent('click');
    await waitFor(
      async () => (await page.locator('input[type=search]').inputValue()) === term,
      SEARCH_TIMEOUT,
      'activating a cursor chip must run the same search a card chip does'
    );
  });

  test('axe finds no WCAG violations with the keyboard cursor active', async () => {
    const { page } = session;
    const canvas = page.locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(session.flightMs + 200);

    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const summary = violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length}): ${v.help}`);
    assert.deepEqual(summary, [], `axe reported violations with the cursor active:\n  ${summary.join('\n  ')}`);
  });

  test('nothing was logged to the console', () => {
    assert.deepEqual(session.consoleErrors, []);
  });
});
