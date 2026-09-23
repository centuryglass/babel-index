# The rearrangement

Hazards for coding agents working on the reorder animation and the loading
indicator that fills its preload pause. `AGENTS.md`'s "Things that will bite
you" routes here, and its conventions still apply.

## The reorder animation

- **A rearrangement is a sliding-tile illusion.** Rooms travel only as part
  of a whole row or column rotating. `illusion.ts` rejects a `swap` (which
  reads as teleportation) if either end is on camera. Don't add a move type
  that moves one cell.
- **The illusion bounds are the viewport plus one cell.** The planner swaps a
  value into the cell just outside the region and slides it inward.
  `board.ts` refuses a margin under 1 because a tighter one lands that swap
  somewhere visible.
- **The center room is the planner's fixed tile**, holding the same value in
  both boards, which is why the map visibly pivots around it. This is about
  the board, not where the camera is parked.
- **The board is finite only because the camera is parked** for the whole
  animation, wherever it already was: `startRearrangement`
  (`useRearrangement.ts`) zooms out in place, not home to the center.
  - A pointer grab (`onDown` in both render hooks) ends the rearrangement,
    since a pan cannot be honored while the slide runs.
  - A control's `flyTo` (the center button, zoom buttons, keyboard pan)
    does not end it, and is overridden by the rearrangement's own next
    `flyTo`. The controls currently stay enabled while they are inert
    (issue #306).
- **While zooming out to start, the map still draws the old arrangement**
  (`anim.current.before`) until the camera lands. Without that hold the map
  shows the new library, zooms to it, then slides in from the one it
  already replaced.
- **The plan is built and fetched before the flight starts.**
  `prepareRearrangement` (`useRearrangement.ts`) simulates the moves to find
  every room the slide will show - more than the before and after
  viewports, since a line rotates whole - and fetches them, waiting up to
  `config.slide.prepareTimeoutMs`. Past that budget, or if the reader
  interacts, it falls back to an instant rebuild.
- **`board.ts` returning null is a real answer, not a failure.** With the
  rooms-on-the-map slider pulled back, a room the new order wants on camera
  may never have been on the old board. The caller falls back to an instant
  rebuild, discovered during prepare, before any flight.
- **A reserved cell is never a source** (`makeAvailable` skips them).
  Otherwise a copy staged for one slot is handed back for another, and the
  first reservation points at a cell holding something else.
- **A rearrangement announces its outcome after the camera settles**, which
  moves the screen-reader cursor without a keypress. Tests asserting the
  canvas `aria-label` must establish their own camera rather than assume
  the page is where it loaded.
- **Visible cost is the viewport's, not the corpus's.** Every move outside
  the region is an invisible swap, so a slide count that scales with corpus
  size is a bug.

`illusion.test.ts` documents the staging and batching mechanics.

## The loading indicator

- **It fills the preload pause, and the flight waits for it.**
  `startRearrangement` starts a cycle when `prepareRearrangement` begins, and
  holds the flight until a cycle boundary with at least one full cycle
  played (`loadingAnimation.ts`'s `finish()`). A warm-cache rearrangement
  still pauses for one cycle; that is intended.
- **The center-tile indicator plays only when the center shelf is legible
  on screen** (`overlapsViewport(cellRect, ...) &&
  areSpinesLegible(cellRect)`). Otherwise nothing plays and no cycle-wait is
  imposed. The search badge's ring (`SearchIcon.tsx`'s
  `SearchOrbitSpinner`) spins over the same preload window regardless of
  that gate, driven by `useRearrangement.ts`'s `onPreparingChange`.
- **The controller owns its own rAF loop,** because the map's render loop is
  on-demand and doesn't repaint during the wait. It calls the `requestDraw`
  it was handed each tick, and the renderer pulls the frame through
  `frame()`. A grab mid-preload calls `cancel()`, which stops the loop and
  resolves the pending `finish()`, ending the rearrangement.
- **`drawLoadingFrame` is drawn in both renderers, in lockstep** (see
  `rendering.md`, "The WebGL renderer").
- **The frames are a build artifact, served like fixed art** from the shared
  dir (`assets/animation/`), resolved off `sharedBase`; `scan.ts` discovers
  nothing here. A missing manifest means no indicator, read as null
  everywhere. The e2e suite's `--shared-dir` has no manifest, so e2e never
  sees the indicator.
- **The dev panel's "loop loading animations" checkbox owns the screen while
  on** (`startDebug`): a rearrangement's `play()` no-ops.
