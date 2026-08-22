# AGENTS.md

Notes for coding agents working in this repo. Human-facing docs are
[`README.md`](README.md) (how to run it), [`concept.md`](concept.md) (what it is
meant to become), and [`docs/implementation-plan.md`](docs/implementation-plan.md)
(how it gets there, and what is next).

## What this is

An AI art experiment based on the Library of Babel: a pannable, zoomable map of
generated library rooms. One tile is **one shelved wall** — 5 shelves × 32 books
= 160 books, four tiles to a gallery's 640. Variant images come from an external
inpainting pipeline that is out of scope for this repo; what lives here is the
map, the tile geometry, and an offline demo that needs nothing but a directory of
images.

## Commands

```sh
npm install                        # run this first
npm run demo                       # http://localhost:5173, against assets/corpus-sample/
npm run demo -- --images <dir> [--base base.jpg] [--base-dir assets] [--port 5173] [--config config.json]
npm test                           # node --test, ~1s, no browser and no network
npm run test:e2e                   # browser smoke test; needs `npx playwright install chromium` once
npm run generate:mips -- --images <dir>    # write the resolution pyramid, in place
npm run generate:figures                  # regenerate docs/figures/
npm run generate:depgraph                 # write depgraph.html, the dependency atlas
node tools/base-image/import-shelf-svg.mjs tools/base-image/shelf_geometry.svg
```

**Run `npm install` before anything else.** Without `node_modules`, `npm test`
fails three files — `mips.test.mjs`, `app.test.mjs`, `bundle.test.mjs` —
because `sharp`, `express` and `esbuild` are missing. Most of the suite passes
regardless, so this reads as damage from your change rather than a missing
install. If those three are the only failures, install rather than debug.

There is no build step, bundler config or linter. The demo server bundles the
client with esbuild in-process at startup (`packages/server/index.mjs`), so
editing web sources means restarting `npm run demo` — except `index.html`, read
per request. The server refuses a busy port rather than binding silently over a
stale instance.

## Layout

| | |
| --- | --- |
| `packages/server/` | demo server: `index.mjs` is the CLI, `app.mjs` the four routes, `scan.mjs` the directory scan |
| `packages/web/` | React + canvas map; `camera.js` is pure maths, `useMapCamera.js` the pointer plumbing, `render.js` one frame, `tiles.js` the image cache, `rooms.js` url composition, `pyramid.js` the resolution policy |
| `packages/config/` | the by-feel numbers: `config.mjs` is defaults + validation (no fs), `load.mjs` reads the optional `config.json` overlay |
| `packages/map/ordering.js` | slot placement, the search density gradient, ranking, pan resistance — no DOM, no imports |
| `packages/map/metadata.js` | normalising and joining the keyword/story sidecar — one implementation, used by `scan.mjs` and by the browser |
| `packages/map/illusion.js` | the sliding-tile planner: rows and columns rotate, swaps are legal only off camera. No DOM, no imports |
| `packages/map/board.js` | cuts a finite board out of the infinite map for one rearrangement, and decides when a change cannot be animated |
| `packages/map/scoring.js` | folding, tokenising, the two match rules, the three-signal blend, and how sure it is |
| `packages/map/describe.js` | the words a reader hears: one cell (`describeCell`) and one whole arrangement (`describeArrangement`) — no DOM, no imports |
| `packages/map/nextRoom.js` | the walk ctrl+arrow makes: the next ranked room along an axis, skipping wallpaper |
| `packages/web/src/slide.js` | the second renderer, for a rearrangement only: a board, a parked camera, one line mid-slide |
| `packages/web/src/picking.js` | which room is under a screen point — pure, so the overlay's logic is testable without a browser |
| `packages/web/src/centre.js` | the centre room's shelf: book geometry, title assignment, the hit-test, the arrow-key walk, and the compositing — the pure half, like `picking.js` |
| `packages/pipeline/` | the pyramid generator: `index.mjs` is the CLI, `mips.mjs` the resizing, `layout.mjs` the on-disk level layout (sharp-free, so `scan.mjs` can read it) |
| `tools/base-image/` | tile geometry (`lib/geometry.js`) and the SVG importer that generates `lib/measured.js` |
| `tools/depgraph/` | the dependency atlas: `scan-npm.mjs` walks the install, `scan-internal.mjs` scans the repo's own imports, `graph.mjs` is the shared maths, `page/` is the canvas client |
| `assets/corpus-sample/` | 27 ranked rooms, with all five pyramid levels, so the demo needs no setup. The wallpaper is not here - it comes from `--base-dir` (below) |
| `assets/base.tile.png` | the blank base tile, served at cell (0, 0); `mask.png` is its inpainting mask. This is the demo's `--base-dir` default |
| `assets/base_variations/` | the inpainted wallpaper variants, one per file; the map picks between them per cell. Swap these for real inpainting output |
| `assets/blender/` | the base render source; nothing reads it |
| `docs/borges-parameters.md` | every number from the story, with the passage it comes from |
| `docs/accessibility-plan.md` | the keyboard/screen-reader plan: every phase landed, and what is deliberately still open |

## Conventions

- **ESM everywhere** (`"type": "module"`). `.mjs` for anything Node runs directly
  (servers, tools, tests), `.js` for modules the browser bundles, `.jsx` for
  React. Node built-ins are imported with the `node:` prefix.
- **Node 20 is the floor** (`engines`), and CI runs 20/22/24. No TypeScript, and
  no dependency should be added without a reason that survives the question "can
  this be twenty lines instead?" — the dependency list is deliberately short.
- **Tests sit next to the code** as `*.test.mjs` and use `node:test` +
  `node:assert/strict`. `node --test` discovers them, so a new file needs no
  wiring. The e2e file is `*.e2e.mjs` precisely so it stays outside that pattern.
- **Fixtures are synthesised, not committed.** `packages/server/image-fixtures.mjs`
  builds PNG/JPEG/WebP headers byte by byte. Don't make tests depend on
  `assets/corpus-sample/` staying exactly what it is.
- **Comments explain why, not what.** Files open with a block comment saying what
  the file is for and which decision it embodies. Prose comments use ASCII
  hyphens; markdown uses em dashes. Match the surrounding density rather than
  adding a comment per line.
- Two-space indent, semicolons, single quotes, trailing commas in multi-line
  literals. Just follow the file you're in.

## Things that will bite you

### Tile geometry

- **`tools/base-image/lib/measured.js` is generated.** Never hand-edit it. Change
  the Blender render, re-trace in Inkscape, re-run `import-shelf-svg.mjs`, then
  `npm test`. The trace is just `book<n>` rects plus one `search_box` rect now —
  no board, upright or lamp is read from the SVG. The importer fails loudly on a
  rect it cannot label (not `book<n>` or `search_box`) or a missing `search_box`;
  it no longer requires an even book count per shelf, because the centre's own
  shelves do not have one (art can break a shelf into more than one run - see
  `centre.js`'s `RUNS`).
- **Changing the tile's aspect is two edits, not one.** `BASE_TILE` and the
  `viewBox` of `shelf_geometry.svg` state the same fact, and measured coords are
  normalised against the traced width and height separately — disagree and every
  rect is stretched onto art it no longer matches, so the books stop landing on
  the books, silently (each rect is individually still inside the tile). The
  trace records its own aspect and `geometry.test.mjs` asserts the two agree.
  Re-trace, re-import, then update `BASE_TILE`.
- **`layout()` defaults its height to the traced aspect, never to a square.** A
  `height = width` default is how a 4:3 trace would come out 1024²: each rect is
  still inside the tile, so nothing complains and the books stop landing on the
  books. The same rule governs how the trace is normalised — x against width, y
  against height (see `centre.js`'s per-axis spine fractions); one divisor for
  both axes is the same bug. Asserted.
- **Don't pin art choices in tests.** Shelf spacing, book width, shelf count and
  book count are free to move - the centre's own book count is a UI choice
  (legible search-history titles), not a restatement of the story. Assert only
  that books stay inside the opening, don't overlap, and each shelf has one
  baseline.
- **Only the centre room needs exact geometry.** It is cell (0, 0), reserved by
  `packages/map`, and carries the search box and controls. Every other room
  needs only a bounding box, because inpainting doesn't preserve shelf counts —
  per-book hit-testing is impossible on corpus rooms and always will be. Picking
  resolves to a cell, never a book; a book-pull animation would sample a
  plausible spine from the tile's pixels rather than identify a real one.

### The map and its coordinates

- **The world's base unit is the cell, and a cell is not square.** World
  coordinates are in cells; `zoom` is pixels per cell *width* and `pxPerCell()`
  in `camera.js` is the only place height is derived from it. Never write `zoom`
  for both axes. Cameras carry an optional `aspect`, so anything constructing one
  must spread the old camera rather than rebuilding `{x, y, zoom}`, or the shape
  is lost mid-gesture.
- **`packages/map` measures distance as it looks, not as it indexes.** It is
  shape-blind except for one injected `aspect`, and every distance goes through
  `cellDistance()` — `hypot(x, y * aspect)`, i.e. cell *widths*. That makes the
  library round on screen. A raw `Math.hypot(x, y)` anywhere in that file is the
  bug. Placement uses the same metric and has to: a circular boundary around an
  elliptical spread of rooms is a circle empty at top and bottom. `aspect`
  defaults to 1, so a square cell behaves as before and the module needs no
  imports.
- **The centre room is cell (0, 0)** and is reserved — `packages/map` never
  assigns a corpus room there.
- **Corpus size and generic ratio are runtime parameters**, arguments to
  `createLayout()`, not build-time settings. Growing the corpus must keep
  existing slots where they are and append further out; that property is what
  makes the sliders usable and is asserted in `ordering.test.mjs`.
- **Re-ranking swaps one array; only a search may move slots.** A reorder (the
  shuffle button, a re-sort of the same results) stays a swap of `order` — the
  map rearranges, it does not reload. A search is the one thing allowed to
  rebuild the layout, because its certainty profile is an input to placement;
  that rebuild is the same O(slots) the ratio slider does on every drag. Nothing
  else recomputes placement.
- **The map is virtualized canvas.** Do not mount thousands of DOM nodes.

### The base tile and its wallpaper variants

- **The centre and the wallpaper are different images, and neither is the
  other.** Cell (0, 0) always draws the blank `base.tile.png` (the `CENTRE` tile
  id), reserved for the search box and controls; every generic cell draws one of
  the inpainted variants (`variantId(i)`), never the blank tile. `variantId(-1)`
  is `CENTRE`, which is only the fallback for a corpus with no variants at all.
- **The variant is positional and order-independent, and that is load-bearing.**
  `layout.variantAt(x, y)` is a seeded hash of the coordinate alone — a reorder
  never changes a generic cell's face. That is the whole reason `board.js` and
  `illusion.js` still see one interchangeable `GENERIC` value and the
  rearrangement planner did not have to learn about variants. `roomAt` is
  unchanged; only the two renderers (`render.js`, `slide.js`) resolve a cell to a
  variant. `slide.js` reads the variant at each tile's *home* board cell so a
  sliding line carries its own faces instead of flipping variant mid-ride.
- **The base tiles live outside `--images`.** `scan.mjs` discovers them in
  `--base-dir` (default `assets/`): the centre by name (`base.tile.*`, else
  `base.*`, else `--base`) and the variants as every image in `base_variations/`.
  They ride in the manifest as `base: { centre, variants }` and are served from
  the `/base/` mount, not `/images/`. The old "a `base.*` inside the corpus dir is
  the wallpaper" behaviour survives only as the `baseDir === imagesDir` case.
- **The base tiles are served flat (level 0) for now.** `rooms.js` resolves a base
  id to its url at level 0 only; every coarser request falls back through
  `servableLevel`. Bounded, because the cache keys on id not cell, but it means
  `main.jsx` pins each base id at level 0 rather than at the coarsest rung — so
  the "12 KB pinned generic" is a full-res download until the base assets get
  their own pyramid (plan §8). Do not pin a base id at `FALLBACK_LEVEL`; there is
  no tile there.

### The centre room's controls

- **`centre.js` is the pure half, and the geometry comes from the tools tree.**
  The book layout, `assignTitles`, the hit-test and `pickTags` live in
  `packages/web/src/centre.js` and are asserted browser-free in `centre.test.mjs`
  — the same split as `picking.js`. Every book is lettered; a book is one
  flat slot id (`BOOK_COUNT` of them), assigned top left to bottom right, so
  there is no (shelf, index) pair to keep in step. A shelf need not be one
  contiguous run - art can break it into more than one, and `centre.js`'s
  `RUNS` (not `GEOMETRY.shelves` directly) is what the hit-test walks, so a gap
  wider than a book resolves to nothing rather than a phantom book. The rects come from
  `layout({ width: 1, height: 1 })` in `tools/base-image/lib/geometry.js`, the
  one module the tile trace feeds, so there is no second copy to drift.
- **The fractions are per-axis, and that is load-bearing.** `render.js` stretches
  the centre tile width→`cellPx.x` and height→`cellPx.y` independently, so a
  spine rect is `{x,w}` against the cell width and `{y,h}` against its height —
  `layout({width:1,height:1})` returns exactly that. One divisor for both axes is
  the same silent-stretch bug the tile geometry warns about.
- **Compositing is content, not chrome, and it is zoom-gated.** It draws on the
  centre cell whenever `centreSlots` is passed, but `composeSpines` itself draws
  nothing below a legible spine width — so far out it is free. `render.test.mjs`
  never passes `centreSlots`, which is why its recording `fakeCtx` needs no
  `save`/`rotate` and the byte-cost assertions are untouched. Keep it that way.
- **The books are DOM buttons AND painted spines, and there is one `onBook`
  for both.** `centre-books` is one absolutely-positioned container matching
  the centre cell, written once per frame like `.centre-search`, with
  `BOOK_COUNT` buttons inside it in per-axis PERCENTAGES - so a pan costs one
  style assignment, not forty. Writing each button's geometry per frame from
  `bookScreenRects()` is the trap the plan names; don't. The container is
  `pointer-events: none` with no `:focus-within` escape hatch, so the canvas
  keeps every gesture and a sighted click still routes `onTap` ->
  `bookAtPoint` -> `onBook`; a second copy of "what does book i do" written
  inline in either path will drift. The shelf is ONE tab stop (roving
  tabindex, `role="toolbar"`), and where an arrow key goes lives in
  `bookNeighbour` - rows there are SHELVES, not the hit-test's runs, because a
  gap between two runs is somewhere a click can land and not somewhere focus
  should stop. `areSpinesLegible` is the single zoom gate: the buttons exist
  exactly while `composeSpines` draws a title, so a reader never tabs to a book
  nobody can see named.
- **`onTap` must lose to a pan and to a flight.** It fires only on a pointer-up
  that stayed within the slop and did not stop a flight, and a completed
  long-press clears the tap candidate so a press is never also a tap. History is
  session-only React state; it fills the whole wall as one queue, newest search
  first, top left to bottom right, skipping any book an override has claimed.
  Every book history has not reached is a random keyword tag (the pool is
  cycled to letter the whole wall). Assignment order is
  override → history (newest first) → tags, and override books are reserved
  first. Titles read top-to-bottom, as printed spines do.
- **Two opening views, and they are not interchangeable.** The page-load view is
  DERIVED, not configured: `main.jsx` computes it once at mount with `fitZoom`
  (camera.js), framing the centre room's book-bounding box (`GEOMETRY.opening`,
  exported as `CENTRE_SHELF_RECT` from `centre.js`) on the display so the spines are legible,
  centred on the shelf and capped at the tile's NATIVE width so a page never
  loads upscaled. It is passed to `useMapCamera` as `opening` — do not restate it
  as a config number, and do not read the viewport inside the hook. `defaultZoom`
  (220, config) is the return-to-centre view, used by the "centre" button and the
  rearrangement's park; the split exists precisely so the reorder animation has a
  wall of rooms to slide across rather than the one shelf the opening shows.
  Collapsing them silently breaks whichever view loses.
- **The zoom cap is `MAX_ZOOM_FACTOR` × the tile's native width** (2× = 2048 at
  1024w), derived in `ZOOM_LIMITS` so it tracks the tile, not a literal. Past 1×
  the flat base tile is upscaled and softens; the OPENING view is separately
  capped at 1× in `main.jsx` so a load is never blurry, while a reader may zoom to
  2× by hand to read a spine. Raising the cap breaks the "tile too large to reach"
  example in `pyramid.test.mjs` (its base scales with `MAX_ZOOM_FACTOR`); that is
  the test working, not a regression. Config's `camera.maxZoom` may only narrow
  this, never widen it.
- **`CENTRE_SEARCH_RECT` is traced but not wired up.** The SVG's `search_box`
  rect reserves where the live search field belongs on the centre tile, in the
  same cell fractions as `CENTRE_SHELF_RECT`. The DOM search form in `main.jsx`
  does not read it yet - it still lives in the fixed side panel - so a change
  here is reserved space for a future pass, not a live feature.

### Search and the density gradient

- **Search blends three signals into one sort; it does not tier them.** Every
  signal is normalised to [0, 1] *before* weighting, and the CLIP term is
  min-maxed across the corpus for that query — raw cosines on this corpus sit in
  a band too narrow to weight against a keyword ratio. Bucketing keyword hits
  ahead of everything would let one weak partial beat a room CLIP is certain
  about; a test fails against a tiering implementation. Rooms with no metadata
  are ranked by whatever signal applies, never parked below described ones.
- **Keyword partials divide by the keyword; story matches divide by the query.**
  Opposite on purpose. `art` matched only 3/11 of `art nouveau`, but a hit in a
  long story is not worth less than the same hit in a short one — there the
  question is how much of the *query* was found. Both directions are asserted.
- **The density gradient is one formula, not three cases.** A rank's acceptance
  threshold is `contentRatio + (peak - contentRatio) * certainty`, the walk goes
  outward, and the hard-edged cluster, the gradual falloff and the flat "nothing
  matched" map all fall out of it. Don't special-case any of them. Two rules keep
  it honest, both asserted: certainty is **non-increasing with rank** (a rank
  more certain than the one above it contradicts best-first ordering), and
  anything under `CERTAINTY_FLOOR` snaps to exactly the baseline — so a query the
  corpus cannot answer produces the uniform map cell for cell.
- **Certainty is absolute; ranking is relative. Don't feed one the other's
  numbers.** The blend min-maxes CLIP across the corpus, so some room scores 1
  for *any* query — drive the gradient off that and nonsense clusters as
  confidently as an exact match. `matchCertainty` reads raw cosines against
  absolute bounds (`CLIP_CERTAINTY`, config `search.density.clipLow/High`), which
  is why `embeddingScores` divides the int8 quantisation back out and returns a
  real cosine. A test fails against a certainty computed from the normalised
  column.
- **`collectSlots` prefilters the far field at the baseline.** Sorting every cell
  a *certain* rank could take would sort the whole sweep; instead each ring
  carries a lower bound on the rank the walk must have reached by then, and
  because the ramp is non-increasing, a lower bound on the rank is an upper bound
  on the threshold. Break the monotonicity and the prefilter silently drops
  cells. A fuzz test against an unpruned walk guards it and catches an off-by-one
  in the ring bound.
- **`embeddings.bin` is keyed by row order; `metadata.json` by filename, and the
  rules differ with it.** The blob is positional, so `scan.mjs` rejects one whose
  count has drifted — a stale one would attach the wrong vector to the wrong
  room. The sidecar is joined per file, so a partial match is simply partial and
  every matching entry still lands; never turn that into the blob's all-or-nothing
  rule. Worth being loud about: `matched: 0` against a non-zero `entries` means
  the keys have drifted, which from the map looks exactly like having no sidecar.
  Both numbers go in the manifest and `index.mjs` warns.
- **A room's optional `alt` is a caption, not a story, and nothing generates
  it here.** `normaliseEntry` carries it, `describeCell` returns it as
  `picture`, and the card shows it above the story as a visibly different
  thing - the story is fiction about the room, the caption is a report of the
  image, and merging them lets a reader take one for the other. It never feeds
  the search index. Absent normalises to null and every consumer must read the
  same without it, which is every corpus that exists today; an entry carrying
  only an `alt` still counts as an entry. Do not write one into
  `assets/corpus-sample/`: that sidecar is placeholder text that describes
  nothing about its images, and a placeholder caption is the padded sentence
  the plan says to omit.

### The reorder animation

- **A rearrangement is a sliding-tile illusion, and the wallpaper is not a gap.**
  The generic room is a wall like any other; 80% of cells being identical is a
  fact about the art, not permission to slide a room *over* them. Rooms travel
  only as part of a whole row or column rotating. `illusion.js` makes that
  structural: rotations are legal anywhere, a `swap` (which reads as
  teleportation) is rejected if either end is on camera. Don't add a move type
  that moves one cell.
- **The illusion bounds are the viewport PLUS one cell.** The planner swaps a
  value into the cell just outside the region and slides it inward; with the
  region hugging the viewport that swap lands on a partially visible cell and the
  illusion breaks along the screen edge. `board.js` refuses a margin under 1.
- **The centre room is the planner's fixed tile, and gets there for free.** As
  cell (0, 0) it holds the same value in both boards by construction. Locking it
  forbids every shift of its row and column, which is why the map visibly pivots
  around it — and why phase 1 exists at all, to feed a column that can never be
  rotated.
- **The board is finite only because the camera is parked.** Rotations wrap
  around the board, invisible solely because the camera sits on the centre at the
  opening zoom for the whole animation and the board is far larger than the
  screen. Anything that moves the camera mid-rearrangement — a pan, a zoom, a
  `flyTo` — must end the animation instead, which the canvas `pointerdown`
  handler in `main.jsx` does.
- **`board.js` returning null is a real answer, not a failure.** With the
  rooms-on-the-map slider pulled back, a reorder changes *which* rooms are
  placed, so a room the new order wants on camera may never have been on the
  board. It cannot slide in from a cell it was never in, so the caller falls back
  to the instant rebuild. Don't "fix" this by substituting an off-camera tile: a
  tile changing its face and sliding on as something else is exactly what this
  approach exists to prevent.
- **Staging is why the conveyor works.** Phase 2 parks a whole BATCH of columns
  before feeding any of them, because extracting a later value can rotate the
  column holding an earlier one. A board with a small alphabet never hits this —
  every value has a copy off camera. The case that does is a board whose distinct
  values all start on camera, which is exactly what the density gradient builds;
  `illusion.test.mjs` carries it and randomized tests do not.
- **The batch size is not a tuning knob.** It is `capacity / valuesPerLine`, and
  parking a batch is what makes the animation a wave. One line per batch — the
  strictly sequential original — is what a region too wide to park in degrades
  to; nothing breaks there, it just gets slower.
- **Two parking pools, and the difference is load-bearing.** The conveyor parks
  in any column outside the region, because phase 2 rotates only region columns.
  The fixed tile's column parks in the CORNERS — outside the region's columns
  *and* its rows — because phase 1 rotates region rows and a row rotation sweeps
  every column. Using the conveyor's pool there silently loses the staged value.
- **A reserved cell is never a source.** `makeAvailable` skips them; otherwise a
  copy standing by for one slot gets handed back for another, swapped away, and
  the earlier reservation points at a cell holding something else.
- **The animation overlaps runs only two ways, both proved rather than
  eyeballed.** A `wave` stage's lines are independent (the planner parked them
  together), so its lanes run concurrently. Any other stage CASCADES: runs start
  a beat apart but finish in plan order, and since a run's moves are applied as
  it passes them — the last at its completion — ordered completions are ordered
  application. So a swap emitted after a shift must attach to that shift's run at
  its completion, not to the next run's start, or the cascade applies the plan
  out of order.
- **A rearrangement announces its outcome, and that moves the cursor without a
  keypress.** One live-region write carries the search's signals note, the
  arrangement summary (`describeArrangement`) and the cell the reader ends up
  at - folded together because a polite region queues two writes as two
  interruptions of one event. The note is stashed in `pendingNote` when the
  search resolves rather than announced there. It is read after the camera
  settles, never before: an animated rearrangement parks on the centre first,
  so an earlier read names a cell the reader is about to be moved off. The
  consequence to remember when writing tests: `cursor` is no longer "only
  changes on a keypress", so anything asserting the canvas's `aria-label`
  must establish its own camera rather than assume the page is still where it
  loaded.
- **Visible cost is the viewport's, not the corpus's.** Every move outside the
  region is an invisible swap, so the board can be as large as needed (157×209 at
  5000 rooms) without lengthening the animation. Slide count scaling with corpus
  size is the bug.

### Camera and gestures

- **`flyTo` returns a promise for the landing, and the rearrangement awaits it.**
  Flights ease, so `cam.current` is unchanged when `flyTo` returns; planning
  against it would plan for wherever the reader was standing. The promise also
  says WHETHER it landed — false means a hand hit the map — and an interrupted
  flight must fall back to the instant rebuild rather than rearranging under
  someone who has just grabbed it.
- **`flyTo`'s third-argument `{ ms }` overrides the configured duration for one
  call**, which is what lets the keyboard's short nudges (arrow, ctrl+arrow,
  PgUp/PgDn — `camera.keyboardMoveMs`, 140ms) share every mechanic a "fly home"
  already has — interrupt-on-a-new-flight, the landing promise, reduced motion
  collapsing it to zero — rather than a second, parallel "ease the camera"
  implementation. A keyboard handler chaining a SECOND move off the first must
  not read `cam.current` for the target — that is the flight's INTERPOLATED
  position, not where it is headed, and two key-repeat presses landing in the
  same rAF tick will both read a value that has not moved yet and compute the
  same target. Read `flightTarget()` (`flight.current?.to ?? cam.current`)
  instead; found by two `PageDown` presses back to back silently cancelling
  each other rather than compounding.
- **The keyboard and the pointer are damped by the same resistance but
  DIFFERENT curves, and merging them is a real bug.** `panByPixels` floors its
  scale at 0.12 so a drag never feels frozen solid; that floor is free for a
  pointer because a hand runs out of screen long before it runs out of map.
  A held arrow key has no such bound - the browser repeats `keydown` about
  thirty times a second for as long as it is down (each flagged
  `event.repeat`), so any non-zero floor is a constant outward velocity that
  never stops. Measured with the shared curve, a six-second hold reached 31
  cells past a boundary eight full-width drags could only push 15 past, still
  climbing linearly. `panByCells` therefore scales straight from `damp` with
  no floor, so the step approaches zero as the resistance does and a hold
  settles about where a determined drag does. Inside the content region
  `damp` is exactly 1, and there `panByCells` lands the camera CELL-CENTRED on
  the destination rather than adding a raw delta - both move one cell from an
  aligned camera, but only the snap recovers. A trip outside leaves the camera
  off the grid (the damped steps out there are fractional by design, and the
  glide stops wherever it happens to cross back in), and a raw delta carries
  that offset forever: every press advancing one cell while the cell itself
  sits visibly off-centre, part of it off-screen. Both axes snap, not just the
  one being moved along - the offset a trip outward leaves is rarely
  axis-aligned, so pressing Left has to fix the vertical drift too.
- **The glide applies to the keyboard exactly as it does to a pointer, and
  must not be exempted for it.** The boundary's pushback is an affordance, not
  an obstacle: walking out past the last ranked room and feeling the library
  pull you home is the point, and arrow keys get it for the same reason a
  released drag does. This was briefly broken by a `glideExempt` ref that
  skipped the glide after any landed flight — reasoned from "the glide would
  fight the cursor's announced position", which has the causality backwards
  (the cursor is DERIVED from the camera, so it moves WITH the glide, and only
  a separately-tracked copy could disagree). Because the flag was set on every
  landing and cleared only by a pointerdown, it disabled the pushback for the
  whole keyboard session: pan out forever, then get yanked back the moment a
  mouse touched the map. `smoke.e2e.mjs` now asserts the drift happens with no
  pointer involved.
- **The glide respects `prefers-reduced-motion` too, via `glideToRest` rather
  than skipping the correction.** There is no closed form for where `glideStep`
  would eventually settle — the pull shrinks as resistance climbs back toward
  1, which is what makes the eased version smooth — so `glideToRest` runs the
  same step function to convergence (bounded at 20,000 iterations; every one
  is arithmetic, not a frame) instead of inventing a different endpoint.
  Motion-on and motion-off settle in the same place, differing only in whether
  the trip is visible.
- **While flying home to start a rearrangement, the map draws the OLD
  arrangement.** `layout` and `order` update the moment a search resolves, before
  the camera has moved, so without the hold in `anim.current.before` the map
  shows the new library, flies to it, then slides it in from the one it already
  replaced. A unit test cannot see this.
- **The render effect must cancel its pending frame on cleanup.** Its closure
  captures `layout` and `order`, so a frame scheduled through the old closure and
  left to fire after the effect is rebuilt repaints the state that render pass
  replaced. Reachable because the rearrangement trigger runs in `useLayoutEffect`
  (it must run before the first paint of the new arrangement), which schedules a
  `requestDraw` before the render effect is rebuilt.
- **A flight interpolates zoom geometrically and position linearly**, on the loop
  the glide already runs. Zoom is pixels per cell, so a linear ramp from 26 to
  900 sits near 900 for nearly the whole flight and reads as a snap then a
  crawl — `camera.test.mjs` asserts the midpoint against the geometric mean.
  Sharing the glide's rAF is what makes the precedence one `else` rather than two
  loops racing; don't start a second. `pointerdown` and `wheel` each drop the
  flight, both with their own e2e assertion. In the e2e, anything reading the
  camera after a "centre" click needs `landed()`, not `settled()`, and how long
  it waits is read off the manifest, because `camera.flightMs` is config.
- **`zoomBy` takes a factor, `zoomAt` is the wheel's exponential wrapper around
  it.** One fixed-point implementation for both gestures — a pinch knows the
  ratio its fingers moved and has no wheel delta to invent. Don't grow a second.
- **`useMapCamera.js` tracks pointers by id, in a Map, and that is load-bearing
  for touch.** One finger is a drag, two are a pinch, and the pinch is always
  between the *first two* so a third does not hijack it. Two rules that look
  optional and are not: a second finger cancels any pending long press, and
  dropping back to one finger must re-anchor the drag to where that finger
  actually is — otherwise the map lurches by the width of the gesture every time
  a pinch ends. `smoke.e2e.mjs` covers both; nothing else can.
- **Pointer capture is best-effort and must never be load-bearing.** Both
  `setPointerCapture` and `releasePointerCapture` throw `NotFoundError` for a
  pointer the browser does not consider capturable, which is ordinary on touch.
  Do the `pointers` bookkeeping FIRST and wrap the capture calls; an `?.` guards
  the method being missing, not the call throwing. Unguarded, a throw strands a
  finger in the Map and every later gesture reads as a pinch against a finger no
  longer on the glass. `pointercancel` reaches the release with capture already
  dropped, so the path is real.
- **The overlay opens on right-click or long press, never left-click**, which
  stays reserved for "focus this room". **The long press must lose to a pan**:
  the timer lives on `useMapCamera.js`'s pointer stream so a press that wanders
  past the slop radius cancels, and the slop exists because a finger never holds
  still. Break that and the map is unusable on a phone — `smoke.e2e.mjs` covers
  it, no unit test can.

### The dependency atlas

- **It is measured, not declared, and that is the whole point.** `scan-npm.mjs`
  reads what is on disk under `node_modules` and resolves each dependency the
  way Node does - climbing the `node_modules` chain from the importing package
  upward. A nested copy is therefore its own node, which is the only way the
  graph can show that `@img/sharp-libvips-linux-x64` is installed twice at two
  versions. Reading the declared ranges out of `package.json` instead would
  collapse those to one node and describe a tree that was never installed.
- **A package's size excludes what it nests.** Otherwise a shared dependency is
  counted once per dependent and the total comes out larger than the directory
  it was measured from. Asserted.
- **`scan-internal.mjs` scans text rather than parsing it**, because the
  alternative is a parser dependency. The cost is one real hazard, guarded by
  tests that were checked by breaking the scanner on purpose: the match must
  REQUIRE `from` and must not cross an `=`, or an `export const X = { ... }`
  whose prose happens to contain `from "camera.js"` is read as a re-export, and
  an exported function returning a string is read as an import. Both bugs were
  live before the guard existed. The same limitation is why this file's own test
  fixtures split the word `import` - a dynamic import inside a string is
  indistinguishable from a real one to a scanner.
- **The page is a build product and is gitignored.** `page/page.html` is a body
  FRAGMENT, not a document: the default run wraps it in a minimal skeleton so
  the file opens from disk, and `--fragment` emits it bare for a publishing host
  that supplies its own `<head>`. Nesting a second `<head>` inside a host's
  `<body>` is what that split exists to prevent.
- **Node colour is sequential, never categorical.** Depth on the npm side,
  fan-in on the repo side - one hue, light to dark. The only second hue is the
  orange used for selection and dev-only marks; test files and outside imports
  are told apart by FORM (hollow, square), not by a ninth colour, because a
  node-link graph puts arbitrary pairs of nodes side by side and no eight-hue
  palette survives that colourblind-safely.

### Config and the pyramid

- **`packages/config/config.mjs` is the tuning surface, and no `config.json` is
  committed.** One that spelled out every value would silently become the real
  surface, and editing the documented defaults would stop mattering. The overlay
  is partial and optional. Config never throws: every adjustment lands in `notes`
  and the server prints them, because a value that silently did not take effect
  is the only failure mode a tuning file really has.
- **What belongs in config is what is *derived and asserted* nowhere, not what is
  merely by-feel.** The pyramid's budgets stay out because a test would
  contradict them; `defaultZoom`, `flightMs` and the animation's five durations
  are in because nothing derives from them and no test pins their values. The
  tests do assert a *consequence* of the shipped durations — that a rearrangement
  is seconds, not tens of them — which a `config.json` cannot break. Of the five,
  `stagger` shapes the animation most: it sets how long the wave takes to cross
  the screen, where `perCell` only sets how fast one line rides. `WHEEL_ZOOM_RATE`,
  `LONG_PRESS_MS` and `PRESS_SLOP_PX` remain in source because they predate
  `packages/config`, not by rule.
- **Consuming files state no fallback defaults.** `slide.js` takes its durations
  from config and `useMapCamera.js` takes its flight duration from config and its
  opening camera from `main.jsx` (derived) — each restates none. A default in the
  consuming file is a second statement of the same fact, and the two drift.
- **Zoom config narrows, never widens.** `ZOOM_LIMITS` in `camera.js` is the hard
  range and the only statement of it; `pyramid.test.mjs` asserts every ladder
  rung is reachable inside it. Config can only tighten the range, which is why a
  config edit can never invalidate the assertion and nothing consults the ladder
  at load time. A narrowing that leaves the finest rung unreachable is fine and
  silent — the cost is inactive code and unrequested files. `DEFAULTS.camera.minZoom`
  is `null` for "as far as the camera allows", so 26 and 900 are not restated.
- **The configured range rides on the camera as `limits`**, the same optional
  field as `aspect` and with the same hazard: rebuild a camera instead of
  spreading it and the range is lost mid-gesture while everything still looks
  applied. Both are asserted.
- **Every pyramid number lives in `packages/web/src/pyramid.js`** — the tile's
  dimensions, the ladder, per-level cache budgets, the hysteresis band, the
  prefetch ring. Don't reintroduce one as a literal in `tiles.js` or the render
  loop; those read the policy, they don't restate it. The three rules it serves,
  in the order they win: a cell never fails to display, cells load slightly
  before they are needed, hold rather than refetch. Per-level LRU is load-bearing
  for the first — one global LRU lets a zoom-in evict the coarse field the
  fallback depends on.
- **The tile is 1024×768, and the shape is not settled.** `BASE_TILE` is the only
  place size or shape is stated, and the ladder is divisors of it, so every size,
  byte cost and level choice is derived — don't compute one from a literal, and
  don't assume square. (Treat any "1024²" in prose as a bug; it was square until
  recently.) The tests run the policy at four aspects and name what a new shape
  breaks: a rung outside the camera's clamp, or a budget below one screen. Going
  4:3 broke the second — a shorter tile fits more rows, so the coarsest budget
  went 7000 → 8200.
- **The pyramid is wired in; three files hold the seams.** `scan.mjs` discovers
  which `<dir>/<width>/` levels exist and puts them in the manifest, `rooms.js`
  turns `(id, level)` into a url and returns null for a level the corpus lacks,
  and `tiles.js` resolves a wanted level to the nearest *servable* one. That last
  part keeps a flat directory working: with only level 0 on disk, every request
  resolves to it. Don't "fix" a null from `urlFor` into a fetch.
- **The render loop lives in `render.js`, not `main.jsx`.** It takes a 2d context
  and the world's state and owns no React — that is what lets `render.test.mjs`
  assert a zoomed-out frame's byte cost without a browser. Keep DOM lookups out.
- **Tile eviction is frame-aware, and must stay that way.** The renderer walks
  cells row by row, so mid-frame the tiles it has already drawn are the least
  recently used entries. A plain LRU evicts the top of the screen to make room
  for the bottom of the same screen, blanking and refetching tiles that never
  left the viewport. `tiles.js` stamps entries with `beginFrame()`'s counter and
  will not evict anything from the current or previous frame; the render loop
  must call `beginFrame()` once per frame for that to mean anything. When a screen
  exceeds the budget the cache holds it and reports `overBudget()`.

### Testing and CI

- **e2e IS a merge gate now.** `ci.yml` runs `npm test` across the Node matrix
  *and* calls `e2e.yml` as a reusable workflow; the aggregate `ci` job needs both,
  so it stays the single required check. `e2e.yml` keeps its `workflow_dispatch`
  for ad-hoc runs against a chosen Node version. The consequence to respect: a
  flaky browser test now blocks merges for everyone, so a smoke test that is
  timing-dependent rather than state-dependent is no longer merely annoying.
  Wait on a condition, never on a duration.
- **`settled()` does not mean the tiles have arrived.** It waits out a
  rearrangement and two frames - the camera and the animation, not the network.
  A far-out screen can be settled and still be a cell or two short while a level
  decodes, which is how the pyramid test flaked about one run in five. Anything
  asserting on `blank` must poll for it, bounded, rather than trust the first
  reading.
- **The HUD updates on the next animation frame, not before `page.keyboard.press`
  returns.** A keyboard test reading `hud(page)` immediately after a PageUp/
  PageDown raced that frame and read the stale zoom about one run in four -
  even a keyboard move with `keyboardMoveMs: 0` (reduced motion) still takes
  one rAF tick to notice the flight is already done, so "instant" never means
  synchronous. Poll for the change, same as `blank` above. The live region's
  text is a different story: it comes from a React state commit, not a
  `requestAnimationFrame` callback, and has not been observed to race across
  many runs - but if that ever changes, it gets the same treatment.
- **A rapid second keyboard press can read the same stale value the first one
  did.** `cam.current` is the flight's INTERPOLATED position, not its target -
  two `PageDown` presses back to back both computed their zoom from a value
  that had not moved a single frame yet, so the second press cancelled the
  first's effect instead of compounding it. The fix pattern generalises:
  anything a keyboard handler chains off (the camera's target zoom, the
  cursor's next cell) needs a source that is synchronously correct across two
  same-tick calls. `flightTarget()` (`flight.current?.to ?? cam.current`) is
  that source, and DERIVING from it beats tracking a second copy: the cursor
  is `cursorCell(flightTarget())`, so it is synchronously correct for a
  chained press AND cannot drift from the camera when something else (the
  edge's glide) moves it. A hand-maintained ref was the first fix and it went
  stale exactly where it mattered. Note a `useEffect` syncing a ref from state
  is NOT synchronously faster than the state itself; both lag the same render,
  so that is never the answer either.
- **Two reads of the same UI, separated by a slow call, can describe two
  different renders.** A test read a search's result count, then - after a
  CDP `Accessibility.getFullAXTree` round trip - read an attribute off what it
  assumed was the same list. The ranking can still change shortly after
  results first appear (CLIP arrives after an initial keyword/story rank), and
  the gap was wide enough to land on that window once the suite had grown
  long enough to shift timing. Read values that must agree back to back, not
  separated by the slowest call in the test; where genuine settling is needed,
  poll for two AGREEING reads with a real gap between them, not two reads
  taken one after another with nothing elapsed - that proves nothing.
- **A test's own cleanup belongs in `finally`, not at the end of the function
  body.** The fix above still let one assertion failing mid-test skip the
  cleanup after it - stranding the ratio slider and the camera in a state only
  that test expected, for every test that shares this suite's one `page`
  afterward. One flake became two unrelated-looking failures in two other
  tests. Sabotage-test the cleanup itself, not just the assertion it is
  guarding: force the slow path the original flake depended on and confirm
  the cascade is actually gone, not just less likely.
- **A green e2e test that cannot fail is worse than none.** If you change it,
  break the app on purpose and confirm it fails.
- **Assert on the accessible NAME, not on `aria-valuetext`.** A test that reads
  an ARIA attribute back out of the tree is testing the browser: chromium 1194
  honours `aria-valuetext` on a native `input[type=range]` and Chrome 151
  ignores it, reporting the raw value instead. CI installs whatever Chromium the
  pinned Playwright wants (1234 = Chrome for Testing 151) while a sandbox may
  only have an older one, so this reached CI green-locally and red-there. A name
  is computed by the accname algorithm the same way everywhere, so anything a
  reader MUST hear belongs in the label; keep `aria-valuetext` for browsers that
  honour it, where it is what a drag announces. `BABEL_E2E_CHROMIUM` points the
  suite at a specific binary when the pinned one cannot be downloaded.
- **An accessibility assertion must dump the node it failed on.** "expected
  /%/, got 26" cannot distinguish a missing attribute from an ignored one, and
  the difference cost a CI round trip. Check every case before asserting any of
  them, and put the whole computed node in the message - the failing run is
  usually on a machine you cannot open a browser on.
- **CDP touch injection bypasses the browser's gesture arbitration**, so
  `smoke.e2e.mjs` cannot see anything involving `touch-action`, `pointercancel`,
  or the real capture lifecycle — it dispatches straight to the page. Treat it as
  a known blind spot. Where a gesture bug is suspected, simulate the condition
  explicitly (see the test that makes the capture calls throw) and confirm on a
  device with `?touchdebug`, which prints the raw pointer stream on screen.

## Next up

`docs/implementation-plan.md` §8 holds the ordered queue, and §7 the open
questions. Keep both current: when a step lands, move it out of §8 and fold what
was learned into the relevant phase section, so the plan stays the thing you can
read to know where the project is. `docs/design-history.md` records decisions
that were reversed and alternatives that were rejected — consult it before
re-treading one.

Accessibility has its own plan, [`docs/accessibility-plan.md`](docs/accessibility-plan.md),
because it cuts across every file rather than sitting in one phase. Every phase
in it has landed; what is left is in its §8, and the top item there is that
**none of it has been run against a real screen reader**. Three things from it
to know before touching the web package: there is **no DOM mirror of the board
at all** — the map is one `role="application"` region with a single cursor at
the cell under the camera centre (~110 nodes against 33k), **alt text is never
generated at runtime** (described rooms already ship keywords and a story, and
anything more is an optional sidecar field produced offline in the corpus), and
`role="application"` is scoped to the canvas and **must not creep onto the
panel or the card**, which are ordinary DOM a virtual cursor has to be able to
read.
