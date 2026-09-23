# The map

Hazards for coding agents working on the map: tile and cell geometry, the
center tile and its controls, the camera, config and the resolution pyramid.
`AGENTS.md`'s "Things that will bite you" routes here, and its conventions
still apply.

## Tile geometry

- **`tools/center-placement/lib/measured.ts` is generated.** Never hand-edit
  it. Center-tile geometry is human-managed in `shelf_geometry.svg`, parsed
  with `import-shelf-svg.ts` (`npm run generate:shelf-geometry`), and
  validated with `npm test`.
- **Don't assume the tile aspect ratio; read it from `BASE_TILE`.** If it
  ever changes, update `BASE_TILE` in `pyramid.ts` and `shelf_geometry.svg`
  together and re-run `import-shelf-svg.ts`. Nothing else should need
  updating.
- **Don't pin art choices in tests.** Shelf spacing, book width, shelf count
  and book count are free to move. Assert only that books stay inside the
  opening, don't overlap, and each shelf has one baseline.
- **Only the center room needs exact geometry.** It carries the search box
  and controls; other rooms have none and need only bounding boxes.

## The map and its coordinates

- **The world's base unit is the cell, and a cell is not square.** World
  coordinates are in cells. `zoom` is pixels per cell *width*, and
  `camera.ts`'s `pxPerCell()` is the only place height is derived from it -
  never write `zoom` for both axes. Cameras carry an optional `aspect` and
  `limits`, so code that builds a camera spreads the old one rather than
  rebuilding `{x, y, zoom}`, or the shape and range are lost mid-gesture.
- **`packages/map` measures distance as it looks, not as it indexes.** Every
  distance goes through `cellDistance()` - `hypot(x, y * aspect)`, in cell
  widths - which makes the library round on screen. A raw
  `Math.hypot(x, y)` in that package is a bug. Placement uses the same
  metric: a circular boundary around an elliptical spread of rooms is empty
  at top and bottom.
- **The center room is cell (0, 0)**, and `packages/map` never assigns a
  corpus room there.
- **Corpus size and generic ratio are runtime parameters** to
  `createLayout()`. Growing the corpus keeps existing slots in place and
  appends further out; the sliders depend on that, and `ordering.test.ts`
  asserts it.
- **Only four things recompute placement.** A relevance re-sort is a swap of
  `order`: the map rearranges but does not reload. These rebuild the layout,
  each O(slots):
  - the generic-ratio slider;
  - the shuffle button, which rerolls `seed` (which cells are content slots)
    alongside `order`, and first clears any active search or favorite sort,
    since either one pins the layout it would otherwise rescatter;
  - a search, and an active favorite sort (`'mine'`/`'count'`), which are
    placement inputs through their strength profiles (see `search.md`,
    "Distance from the center carries one meaning at a time").
- **The map is virtualized canvas.** Do not mount thousands of DOM nodes.

## The center tile and its generic tiles

- **The center and a generic tile are different images.** Cell (0, 0)
  always draws the blank `center_tile.png` (the `CENTER` tile id). Every
  generic cell draws one of the inpainted generic tiles (`genericId(i)`),
  never the blank tile. `genericId(-1)` is `CENTER`, the fallback only for a
  corpus with no generic tiles.
- **Which generic tile a cell shows depends only on its coordinate.**
  `layout.genericIndexAt(x, y)` is a seeded hash of the coordinate, so a
  reorder never changes a generic cell's face. That lets `board.ts` and
  `illusion.ts` treat every generic cell as one interchangeable `GENERIC`
  value (`roomAt`'s `{ generic: true }`). The renderers are the only places a
  cell resolves to a tile id; `slide.ts` reads the generic index at each
  tile's *home* cell, so a sliding line keeps its faces mid-ride.
- **The shared tiles live outside `--images`.** `scan.ts` finds them in
  `--shared-dir` (default `assets/`): the center by name (`center_tile.*`,
  else `center.*`, else `--center`), and the generic tiles as every image in
  `generic/`. They ride in the manifest as `shared: { center, generic }` and
  are served from `/shared/`, not `/images/`. A `center.*` in the corpus dir
  counts as a generic tile only when `sharedDir === imagesDir`.
- **Shared art has its own pyramids, in separate manifest arrays that are
  not interchangeable.** `generate:mips --shared-dir`
  (`packages/pipeline/shared-mips.ts`) writes the same per-file
  `<width>/<file>` ladder a room gets, never packed into sheets, and
  `scan.ts` discovers what is on disk:
  - `shared.levels` is the intersection of the center and generic trees; a
    level counts only where every one of those files has it.
  - `shared.distillLevels` (`generic_distill/`) is never intersected with
    `levels`, because not every generic tile has a distill alternate.
  - `shared.favoriteLevels` covers the hand-tuned favorite badge art; see
    `favorites.md`, "The on-map badge".
  - Every other shared id (the distill toggle's faces, the forget-searches
    overlay) is flat level-0 art, reached through `servableLevel`.

  `main.tsx` pins the center at level 0 and each generic or distill tile at
  the coarsest level its own array has - never a hardcoded `FALLBACK_LEVEL`,
  since a corpus with no shared pyramid has only level 0. `drawGenericFade`
  (and its GL and slide counterparts) draws the distill alternate at the
  base tile's level: distill is a mode toggle, visible at any zoom.

## The center room's controls

- **`center.ts` is the pure half, and the geometry comes from the tools
  tree.** The book layout, `assignTitles`, the hit-test and `pickTags` live
  in `packages/web/src/lib/center.ts`, tested browser-free in
  `center.test.ts`. A book is one flat slot id (`BOOK_COUNT` of them), top
  left to bottom right. The hit-test walks `center.ts`'s `RUNS`, not
  `GEOMETRY.shelves`, so a gap in a shelf resolves to no book. The rects come
  from `layout({ width: 1, height: 1 })` in
  `tools/center-placement/lib/geometry.ts`, the one module the tile trace
  feeds.
- **The fractions are per-axis.** The renderers stretch the center tile's
  width to `cellPx.x` and height to `cellPx.y` independently, so a spine
  rect is `{x, w}` against the cell width and `{y, h}` against its height.
  One divisor for both axes silently stretches everything.
- **Spine compositing is content, and it is zoom-gated.** It draws on the
  center cell whenever `centreSlots` is passed, and `composeSpines` draws
  nothing below a legible spine width. `render.test.ts` never passes
  `centreSlots`, which keeps its recording `fakeCtx` free of
  `save`/`rotate` and its byte-cost assertions stable.
- **The books are DOM buttons and painted spines, with one `onBook` for
  both.**
  - `.center-books` is one container positioned once per frame in per-axis
    percentages. Don't position each button per frame from
    `bookScreenRects()`.
  - The container is `pointer-events: none`, so a click routes through the
    canvas's `onTap` -> `bookAtPoint` -> `onBook`. A second copy of "what
    book i does" in either path will drift.
  - The shelf is one tab stop (roving tabindex), with arrow-key movement in
    `center.ts`'s `bookNeighbour`. `areSpinesLegible` is the single zoom gate
    that keeps a reader from tabbing to a book nobody can read.
- **The center cell's DOM overlays are sized to the whole cell, and `#root`'s
  clip keeps them off the page.** `.center-search`, `.center-books`,
  `.center-book` and `.center-controls` are several screens wide at reading
  zoom. A phone responds to that by shrinking the page scale, which drags
  every dialog and the map's paint size with it. `#root`'s `overflow: clip`
  in `style.css` prevents it (its comment explains why `clip` and not
  `hidden`); `map-gestures.e2e.ts`'s "zooming in never grows the page past
  the viewport" guards it.
- **`onTap` loses to a pan, a flight, and a long-press.** It fires only on a
  pointer-up that stayed within the slop and did not stop a flight, and a
  completed long-press clears the tap candidate.
- **Two opening views, and they are not interchangeable.**
  - The page-load view (`main.tsx`, `fitZoom` at mount) frames the center
    shelf so its spines are legible. `center.ts`'s `openingZoom` caps it at
    1x so a load is never upscaled.
  - The return-to-center view (`overviewZoom`, recomputed at each call site:
    the center button, a room double-tap, the rearrangement's park) frames
    `config.camera.overviewCellsPerAxis` whole rows/columns, so a rearrangement
    has rooms to slide across.

  Collapsing them breaks whichever view loses. `camera.ts`'s
  `fitZoom`/`overviewZoom` comments carry the derivation.
- **The zoom cap is `MAX_ZOOM_FACTOR` times the tile's native width**,
  derived in `camera.ts`'s `ZOOM_LIMITS`. A reader may zoom past 1x by hand
  to read a spine. Raising the cap breaks the "tile too large to reach"
  example in `pyramid.test.ts`; that is the test doing its job.

## Camera and gestures

- **`flyTo` returns a promise for the landing.** `cam.current` has not moved
  when it returns, and the promise resolves false if a hand hit the map
  mid-flight.
- **A handler chaining a move off camera state reads `flightTarget()`, never
  `cam.current`.** `cam.current` is the flight's interpolated position, so
  two key-repeat presses in one frame both compute the same target and cancel
  instead of compounding. The same applies to the cursor cell.
- **Keyboard and pointer panning share `damp` but not its curve.**
  `panByPixels` floors its scale so a drag never feels frozen. A held arrow
  key auto-repeats, so the same floor would be a constant outward velocity
  that never stops. `panByCells` uses `damp` unfloored, and inside the content
  region (`damp === 1`) snaps cell-centered so a boundary trip doesn't
  offset the grid.
- **The edge glide applies to keyboard input too.** The boundary pushback is
  an affordance and must fire with no pointer involved. For
  `prefers-reduced-motion`, `glideToRest` runs the same step function to
  convergence; there is no closed form.
- **A flight interpolates zoom geometrically and position linearly,** on the
  glide's rAF loop - don't start a second loop. `pointerdown` and `wheel`
  each drop an in-flight animation.
- **Pointer capture is best-effort.** `setPointerCapture`/
  `releasePointerCapture` can throw `NotFoundError`, which is ordinary on
  touch. Do the `pointers` map bookkeeping before the capture call, not
  gated by it.
- **The overlay opens on right-click or long press, never left-click** (left
  focuses the room). A long press loses to a pan: its timer lives on the
  pointer stream, so moving past the slop radius cancels it.

## Config and the pyramid

- **No `config.json` is committed, and config never throws.** A committed
  file spelling out every value would become the real surface. Every
  adjustment lands in `notes`, printed by the server, because a value
  silently not taking effect is the one failure a tuning file has.
- **Consuming files state no fallback defaults.** They read values from
  config with nothing restated locally.
- **Zoom config narrows, never widens.** `camera.ts`'s `ZOOM_LIMITS` is the
  only statement of the hard range. The configured range rides on the
  camera as `limits` (see "The world's base unit is the cell").
- **Every pyramid number lives in `packages/web/src/lib/pyramid.ts`** - tile
  dimensions, the ladder, cache budgets, the prefetch ring. `tiles.ts` and
  the render loop read it rather than restating it.
- **A level is per-file or sheet-packed, never both on disk.** The pipeline
  writes every level per-file, composites levels at or above
  `SHEETS.fromLevel` into `<width>-sheets/`, then deletes those per-file
  directories. `scan.ts`'s `discoverLevels` prefers a complete sheets
  directory and falls back to per-file.
- **Tile eviction is frame-aware.** The renderer walks cells row by row, so
  a plain LRU would evict the top of the screen for its own bottom.
  `tiles.ts` won't evict anything stamped in the current or previous frame,
  so the render loop must call `beginFrame()` once per frame.
