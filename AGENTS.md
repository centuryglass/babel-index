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
npm run demo -- --images <dir> [--base base.jpg] [--port 5173] [--config config.json]
npm test                           # node --test, ~1s, no browser and no network
npm run test:e2e                   # browser smoke test; needs `npx playwright install chromium` once
npm run generate:mips -- --images <dir>    # write the resolution pyramid, in place
npm run generate:tile -- --base <image>   # draw the measured geometry over a real image
npm run generate:figures                  # regenerate docs/figures/
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
| `packages/web/src/slide.js` | the second renderer, for a rearrangement only: a board, a parked camera, one line mid-slide |
| `packages/web/src/picking.js` | which room is under a screen point — pure, so the overlay's logic is testable without a browser |
| `packages/pipeline/` | the pyramid generator: `index.mjs` is the CLI, `mips.mjs` the resizing, `layout.mjs` the on-disk level layout (sharp-free, so `scan.mjs` can read it) |
| `tools/base-image/` | tile geometry, the SVG importer, the placeholder renderer, the overlay |
| `assets/base-tile/` | generated geometry + placeholder art, 1024×768 like the tile |
| `assets/corpus-sample/` | 26 rooms + a generic, with all five pyramid levels, so the demo needs no setup |
| `assets/base.cell.png` | the preferred base tile, inpainted and tiling; `mask.png` is its inpainting mask. Nothing reads either yet |
| `assets/blender/` | the base render source; nothing reads it |
| `docs/borges-parameters.md` | every number from the story, with the passage it comes from |

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
  `npm run generate:tile` and `npm test`. The importer fails loudly if the trace
  stops agreeing with the story (wrong shelf count, uneven book counts, spines
  outside every bay).
- **Changing the tile's aspect is two edits, not one.** `BASE_TILE` and the
  `viewBox` of `shelf_geometry.svg` state the same fact, and measured coords are
  normalised against the traced width and height separately — disagree and every
  rect is stretched onto art it no longer matches, so the books stop landing on
  the books, silently (each rect is individually still inside the tile). The
  trace records its own aspect and `geometry.test.mjs` asserts the two agree.
  Re-trace, re-import, then update `BASE_TILE`.
- **The lamp is a circle and stays one.** It is the single thing in `geometry.js`
  deliberately not stretched with the tile: one scalar radius scaled by *width*
  on both axes, never an `rx`/`ry` pair. Everything else is part of the wall and
  follows the tile's shape. Both halves are asserted.
- **`layout()` defaults its height to the traced aspect, never to a square.** A
  `height = width` default is how a 4:3 trace would come out 1024²: each rect is
  still inside the tile, so nothing complains and the books stop landing on the
  books. Same rule in `geometryManifest()` — x normalises against width, y
  against height; one divisor for both axes is the same bug. Both asserted.
- **Don't pin art choices in tests.** Shelf spacing, book width and how much of a
  board shows are free to move. Assert the story's invariants (5 × 32 = 160,
  books inside the opening, books resting on their board), nothing more.
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
- **Consuming files state no fallback defaults.** `slide.js` and `useMapCamera.js`
  take their durations and opening zoom from config and restate none — a default
  in the consuming file is a second statement of the same fact, and the two
  drift.
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

- **e2e is not a merge gate.** `ci.yml` runs `npm test` on every push and PR to
  `main` and is the single required check; `e2e.yml` is manual dispatch only. Run
  the smoke test yourself when the map itself changed.
- **A green e2e test that cannot fail is worse than none.** If you change it,
  break the app on purpose and confirm it fails.
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
