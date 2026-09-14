# Native pinch-zoom on mobile: fix-design brief

**Implemented.** All three bugs below are fixed by `packages/web/src/lib/
visualViewport.ts`'s `resetNativeZoom`, called at every dialog's own open/
close boundary (`useDialog.ts`, and `HelpDialog`/`RoomOverlay`, which still
inline their own copy of that machinery) - a boundary reset rather than the
"read `visualViewport`, reposition dialogs off it" direction sketched below,
per that direction's own caveat that it was unvalidated. `style.css`'s
`touch-action` scoping was never re-narrowed; AGENTS.md's "Native pinch-zoom
on mobile" section is the current, accurate account of the design. This doc
stays as the historical brief and investigation notes below remain useful
background, but treat AGENTS.md as authoritative on the actual mechanism.

This was originally a pointer for a future session, not a design doc kept in
sync with the code as it evolves. It exists because the session that built
the regression harness below (`packages/web/e2e/pinch-zoom-native.e2e.ts`)
deliberately stopped short of root-causing or fixing the bugs it reproduces,
per the user's own instruction to keep that work to a size that fits in one
context.

## What exists now

Native pinch-zoom is normally kept off via `touch-action` in
`packages/web/style.css` (see the `TEMPORARY` comments there and in
`packages/web/index.html`), a trade made after two real-device reports of
three bugs, all traceable to the same root cause: nothing in this app reads
or reacts to `window.visualViewport` - the browser's own zoom/pan state -
so anything that assumed layout viewport == visual viewport (dialog
layout, the search badge's fixed position) gets it wrong once a reader
natively zooms.

1. Opening a dialog while the map is natively zoomed in opens the dialog
   already magnified.
2. Panning inside a natively-zoomed overlay pans the whole document; closing
   the overlay leaves that pan applied, displacing fixed/absolute chrome
   (the map canvas, the search badge).
3. Native zoom used on/through an overlay persists as browser-level zoom
   after the overlay closes, leaving the map magnified but rendering
   whatever resolution its own (unchanged) `camera.zoom` had already loaded.

`packages/web/e2e/pinch-zoom-native.e2e.ts` reproduces all three against a
real Chromium gesture recognizer (not just this app's own pointer-event
handlers) with `touch-action` temporarily opened back up. Every test in
that file is `test.skip`, each carrying the reason string
`'reproduces a known, not-yet-fixed native-zoom bug - see docs/
pinch-zoom-native-fix-plan.md'`; all three were confirmed failing for the
stated reason (not a harness bug) during that session, then left skipped so
`ci.yml` stays green. **Un-skip them as part of implementing the fix below,
and only then** - that's the acceptance criteria, not a design to satisfy
independently.

One thing the harness-building session found worth keeping: `canvas` keeps
its own `touch-action: none` even though everything else was opened back
up. Letting native zoom compete for the same two-finger gesture the map's
existing, separate pinch-to-zoom-the-map feature already owns (`useMapCamera.ts`)
breaks that feature outright - the browser's native gesture recognizer wins
the arbitration and the app's own pointer stream gets cut mid-gesture
(confirmed directly: `map-gestures.e2e.ts`'s pinch/lift-a-finger tests fail
without this). None of the three bugs above are about the bare map surface
losing its own zoom - they're about chrome layered on top of it (the shelf's
buttons, the search badge, a dialog) - so the regression tests target those
elements instead, which sit outside `<canvas>` in the DOM.

## Root cause, one level deeper than "add a listener"

Straightforward as "listen to `visualViewport` and fix it up" sounds, the
three bugs pull in different directions once you get concrete:

- Bug 1's naive fix - reset zoom to 1 when a dialog opens - would reintroduce
  the WCAG 1.4.4 problem `index.html`'s own (now-edited) comment already
  flags: a low-vision reader who deliberately zoomed the page does not want
  that undone by opening a dialog. The dialog needs to render *legibly at
  whatever zoom the reader already chose*, not force a reset.
- Bugs 2 and 3 are about *leftover* state outliving the interaction that
  created it, which is a cleaner target - nothing should still be applied to
  the document once the overlay that (arguably legitimately) caused it is
  gone.

So "read `visualViewport`, reposition dialogs and chrome off it" is the
right general shape for bug 1 (never resetting a reader's chosen zoom, just
rendering correctly under it), but bugs 2/3 may want something closer to
"the overlay's own gesture handling should not be leaking state past its
own lifecycle" - which could mean the fix lives more in how `RoomOverlay`/
`useImageZoom` scope their own gesture (their `useDialog`-adjacent open/close
lifecycle already exists to hang cleanup off of) than in a document-wide
`visualViewport` listener. Don't assume one mechanism covers all three
without checking each bug's own regression test independently once a
candidate fix is in place.

## Candidate direction (unvalidated - start here, don't treat as decided)

- A `lib/visualViewport.ts` + hook reactive to `visualViewport`'s `resize`/
  `scroll` events, mirroring `useMapRenderer.ts`'s existing `window resize`
  -> redraw pattern (`useMapRenderer.ts:406,426`), for whatever needs to
  render correctly under an arbitrary native zoom rather than assuming
  `100vw`/`100vh` at `(0,0)`.
- `useDialog.ts` - and `RoomOverlay`/`HelpDialog`, which CLAUDE.md already
  flags as still inlining their own copies of that logic; migrating them
  onto `useDialog` is probably worth doing in the same pass rather than
  fixing three copies - positions/sizes itself off the live visual viewport
  for bug 1.
- The search badge (and anything else meant to read as fixed screen chrome
  rather than document content) gets repositioned off the same visual-
  viewport state, for bug 2.
- For bug 3: since nothing should be forcibly resetting native zoom, there's
  no "reconcile a forced reset" step - `camera.zoom` and
  `visualViewport.scale` are simply orthogonal, and the fix is ensuring the
  map's own rendering copes with whatever `visualViewport` state persists
  post-close, rather than assuming it's 1.
- Revisit whether `useImageZoom.ts`'s scoped pinch-zoom on the room tile
  stays, goes, or coexists with native zoom now that native zoom is safe to
  allow through more of the app - decide based on what actually reproduces
  once instrumented, not preemptively here.

## How to start

1. Un-skip one test in `pinch-zoom-native.e2e.ts` at a time (they're
   independent) and add temporary instrumentation - console logging of
   `visualViewport`'s `resize`/`scroll` events, `window.scrollX/Y`, and the
   relevant camera/dialog state at each step - to pin down exactly what's
   desynced in that specific case, rather than guessing from this doc alone.
2. Also confirm what modern browsers actually do with `position: fixed`
   under active pinch-zoom (visual vs. layout viewport) directly, rather
   than assuming spec behavior - it's known to have varied across engines
   historically.
3. Implement against the now-instrumented test, one bug at a time, checking
   the others don't regress as you go (all three share the same CSS
   surface).
4. Once all three pass, remove `test.skip` and the `SKIP` constant from the
   spec, and re-run `map-gestures.e2e.ts` (and ideally the full
   `npm run test:e2e`) to confirm the canvas's own pinch-to-zoom and every
   other dialog/touch path still work - this session's own verification
   pass is recorded in the PR that introduced this doc, but CSS changed
   again by then needs its own check.
5. Real-device verification via `?touchdebug` before calling it done - CDP
   touch injection bypasses real gesture arbitration (`touch-action`,
   `pointercancel`, real capture lifecycle), per CLAUDE.md's own caveat, so
   the automated suite passing is necessary but not sufficient.
