# The Indexing of Babel — implementation plan

How to get from [`concept.md`](../concept.md) to a working thing: what a tile is,
what exists, the phases, and what is next. The settled decisions are listed in
[§6](#6-decisions-made); decisions that were reversed and alternatives that were
rejected live in [`design-history.md`](design-history.md).

---

## 1. What a tile is

**One tile is one shelved wall**, seen in shallow one-point perspective — not a
whole room. Faithful 3D reconstructions of the Library already exist and this
isn't one. The tile is a repeating unit that happens to be built to Borges'
numbers:

![what a tile is](figures/hexagon-plan.svg)

```
one tile   = one shelved side = 5 shelves x 32 books = 160 books
four tiles = the shelved sides of one gallery        = 640 books
```

Tiling needs no special machinery. Every variant is inpainted from the same base
render with a mask that stays clear of the edges, so the frame — the dark side
returns, the ceiling strip, the floor — is common to every room by construction.
Adjacent tiles meet on identical pixels because they are literally the same
pixels. There is nothing to enforce and nothing to verify.

That the frame really is invariant is worth stating as a measurement rather than
an assumption. Across the 512-image test corpus, per-image deviation from the
mean 24px border is **0.56/255 median, 1.18 at p99** — the JPEG noise floor, and
nothing more.

---

## 2. What exists now

| | |
| --- | --- |
| `packages/server/` + `packages/web/` | **the offline demo** — `npm run demo` |
| `packages/map/` | slot placement, ranking, pan resistance |
| `packages/pipeline/` | the pyramid generator — `npm run generate:mips` |
| `tools/base-image/` | tile geometry and the SVG importer |
| `assets/blender/babel_shelf.blend` | the base render source |
| `assets/corpus-sample/` | 26 rooms + a generic, with all five pyramid levels, so the demo needs no setup |
| `docs/borges-parameters.md` | the story's numbers, with sources |

### The demo

```sh
npm install && npm run demo        # http://localhost:5173
npm run demo -- --images <dir>     # against a full corpus
```

A directory of images is the entire data layer — plus, once
[§3c](#3c-room-metadata--keywords-and-stories) lands, two text sidecars beside
it. Corpus size and generic ratio are sliders, not settings. Search runs real
CLIP against a corpus that has been embedded, and falls back to a deterministic
pseudo-ranking labelled as such when it has not.

Exercised end to end in a real browser against 511 rooms: 1664 visible cells at
zoom 29 drew with nothing stalled, the boundary radius tracked the sliders
(28.6 → 16.3 at 60% non-generic → 4.2 at 40 rooms), and panning past the
boundary was damped rather than blocked.

### Tile geometry is measured, not eyeballed

The opening, the case uprights, all five shelf boards, **all 160 book
rectangles** and the lamp are traced off the Blender render in Inkscape and
imported by `tools/base-image/import-shelf-svg.mjs` into `lib/measured.js`.
Tracing takes five minutes and avoids parsing the `.blend`, which would be a lot
of machinery for the same numbers.

The importer validates rather than trusts: it applies the Inkscape layer
transform, refuses any transform it does not understand, classifies rects by
colour, and fails if the trace stops agreeing with the story. The current trace
imports as 5 bays × 32 books, 160/160 spines placed, 0 unclassified, and the
overlay confirms every rectangle lands on a real book.

Still eyeballed, and part of the geometry's non-measured features: the side
returns, the ceiling strip and the cornice.

#### Changing the geometry

The proportions have moved once already — the tile went 1024² → 1024×768 to
uncramp the shelf — and may move again. The trace is the interface, so a change
is a three-step loop and touches no code:

```sh
# 1. adjust the render in Blender, re-trace in Inkscape
# 2. re-import
node tools/base-image/import-shelf-svg.mjs tools/base-image/shelf_geometry.svg
# 3. confirm the trace still agrees with the story and the tile
npm test
```

`lib/measured.js` is generated — never hand-edit it; the header says so. Two
guardrails make a bad re-trace loud rather than silent:

- The **importer** refuses transforms it does not understand, reports
  unclassified rects, and fails if the bays hold uneven book counts or if any
  spine falls outside every bay.
- The **tests** re-assert the story's numbers (5 × 32 = 160), that books stay
  inside the opening, that each shelf has a single baseline, and that books rest
  on their board rather than through it.

So if the geometry changes and something no longer adds up, `npm test` says so
before the map does. What the tests deliberately do *not* pin is anything that
is a legitimate art choice — shelf spacing, book width, how much of the board
shows. Those are free to move.

#### Changing the tile's aspect

Changing the tile's *shape* is the same loop plus one more thing to keep in
step. `BASE_TILE` in `packages/web/src/pyramid.js` and the `viewBox` of
`shelf_geometry.svg` are two statements of one fact, and `measured.js` normalises
x against the traced width and y against the traced height *separately* — which
is what lets the geometry work at any shape, and also what makes a mismatch
silent. If the trace is square and the tile is 16:9, every measured rect is
stretched onto art it no longer matches: the books stop landing on the books,
and nothing says so, because each rect is individually still inside the tile.

So the trace now records the shape it was made at (`MEASURED.tile`), and
`geometry.test.mjs` asserts it against `BASE_TILE`. Change one, forget the other,
and the suite fails with both numbers and the fix in the message. Re-render,
re-trace, re-import, then update `BASE_TILE`.

**The lamp is the exception, and stays circular deliberately.** Everything else
in the tile is part of the wall and stretches with it; the lamp is a globe, and a
globe that turned into an ellipse because the wall got wider would read as a
mistake rather than as a wider wall. It is one scalar radius scaled by *width* on
both axes, never an `rx`/`ry` pair — which round-trips the traced circle exactly,
given the trace and the tile agree. Both halves are asserted, so neither the
circle nor the stretching can quietly become the other.

---

## 3. Phases

### Phase 1 — variant generation *(concept step 2)*

Out of scope for this repo. Two observations from the test corpus that are worth
carrying into the full run:

- **~2% of images blow through the frame.** In `151`, `153`, `060`, `418`,
  `444`, `482` and a few others, bright content or floor clutter reaches the
  edge — peak border deviations of 130–245/255 against a 0.56 noise floor, so
  the discriminator is unambiguous. These will read as a repeating bright blot
  at every tile junction. Consistent with the mask being loose; not worth
  tightening if the next mask is cleaner, but worth *scoring* — see below.
- **Provenance sidecars.** Prompt, seed, model hash, ControlNet weights. Ten
  thousand rooms without them is an unnavigable pile.

### Phase 2 — curation *(concept step 3)* — **dropped**

No review tool: no scores, no tags, no `x`-to-reject, no SQLite. Curation happens
at generation time, and the three retrieval signals of
[§3d](#3d-hybrid-search--three-signals-one-sort) cover what tagging was
for. See [`design-history.md`](design-history.md#curation-dropped) for the
reasoning.

What survives, and is not curation: **border drift** (mean + peak deviation from
the corpus mean frame), a *pipeline report* rather than a sort key. It measures a
structural defect rather than taste — ~2% of the test corpus reaches the frame
and reads as a repeating bright blot at every tile junction, which is exactly the
seam argument in [§1](#1-what-a-tile-is) verified. The `curate/` package,
`score`/`tags`/`status` in the room schema, and perceptual hashing all left with
the tool; `scoreSortSpines` — a centre-room control with nothing left to sort
by — is freed for reuse ([§5b](#5b-the-metadata-overlay)).

### Phase 3 — the display map *(concept step 4)*

`packages/map/ordering.js` implements the layout; it is tested and ready for a
renderer to sit on top.

- **Corpus size and generic ratio are runtime parameters**, not build-time ones.
  Both are arguments to `createLayout()`, changing either re-derives the layout
  in O(slots) with no data reload. Wire them to sliders and tune by feel.
- Growing the corpus **keeps existing slots in place** and appends further out,
  so tuning doesn't reshuffle the map underneath you. That's asserted in the
  tests, because it's the property that makes a slider usable.
- **Slot placement** is a seeded hash of the coordinate — stable, stored
  nowhere, extends infinitely.
- **The origin is reserved** for the centre room. Ranked rooms start in the ring
  around it.
- **Re-ranking swaps one array.** Slot positions never move, so a search reads
  as the library rearranging itself rather than as a page reload.
- **Pan resistance** falls off cubically past the outermost occupied slot, so
  the edge is felt rather than hit.
- **Distances are measured in cell widths**, not raw cells, so the region is
  round on screen at any cell shape — [§5a](#5a-why-the-map-knows-the-cell-shape).

Rendering: a virtualized canvas drawing only visible tiles. Do not mount
thousands of DOM nodes.

#### Resolution pyramid — built

The demo loads full-resolution images at every zoom, and that is the ceiling it
will hit first. Fully zoomed out on a 2560×1440 device-pixel viewport the map
draws ~7500 cells; at 1024×768, decoded RGBA is 3 MB per image, so that screen
wants ~22 GB of decoded bitmap. It survives at 511 rooms only because the cache
is capped at 240 entries and the browser discards aggressively — which is to say
it survives by thrashing, and at a larger corpus it stops surviving.

The fix is a pyramid, generated once in the pipeline. Picking the level from
zoom keeps decoded bytes per screen roughly constant however far out the camera
goes, which is the property that makes corpus size stop mattering for rendering
cost.

##### Two faults, one of them independent of the pyramid

Panning at full zoom-out against a large corpus, rooms already on screen blinked
out and came back. Two separate faults:

- **The cache is smaller than a screen.** At `MIN_ZOOM` a screen wants ~800
  distinct rooms (2.4 GB decoded) against a budget of 240. Unfixable without the
  pyramid — this is the ceiling the ladder exists to lower.
- **Eviction picked the wrong victims.** The renderer walks cells row by row, so
  within a frame the tiles it has *already drawn* are the least recently used
  entries; a miss halfway down the screen evicted the rows above it. A plain bug,
  independent of the budget, and what turned "the cache is too small" into "tiles
  flicker". `tiles.js` now stamps each entry with the frame it was drawn in and
  will not evict anything touched by the current or previous frame (the previous
  included, because a pan moves the viewport by a cell or two). When a screen
  genuinely does not fit, the cache holds it and `overBudget()` reports the
  overage rather than pretending.

Rule 1's third layer landed with the fix: a cell whose room has not arrived draws
the **pinned generic room** instead of a flat `#15120f`, so a miss is a wall, not
a hole — invisible at the ~26px cells where this happens.

##### The three rules, in priority order

Everything below follows from these, and they are listed in the order they win
when they conflict:

1. **A cell never fails to display.** Not "rarely" — the design has no state in
   which a cell that has any image at all draws a hole.
2. **Cells load slightly before they are needed**, so panning and zooming arrive
   at tiles that are already there.
3. **Hold rather than refetch.** RAM is cheaper than a round trip, and the map
   is a thing you wander back and forth across.

##### Where the numbers live

**[`packages/web/src/pyramid.js`](../packages/web/src/pyramid.js) is the single
tuning surface.** The tile's dimensions, the ladder, per-level cache budgets, the
hysteresis band and the prefetch ring are all constants at the top of that file,
each with the arithmetic that justifies it written next to it. No pyramid number
belongs anywhere else: `tiles.js` reads the ladder and `budgetOf()`, the render
loop reads `pickLevel()` and `PREFETCH`. Tune there, run `npm test`, and the
assertions in `pyramid.test.mjs` will say if a value has been moved somewhere
that breaks one of the three rules.

**The tile size is not settled, so nothing derives from it by hand.**
`BASE_TILE = {w, h}` is the only statement of size or shape; the ladder is
expressed as *divisors* of it, and every pixel count, byte cost and level choice
is computed. Changing the tile is editing one object.

| Level | Divisor | Size¹ | Decoded/tile¹ | Budget | Budget bytes¹ | Worst-case visible¹ |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | ÷1 | 1024×768 | 3 MB | 240 | 720 MB | 30 |
| 1 | ÷2 | 512×384 | 768 KB | 400 | 300 MB | 99 |
| 2 | ÷4 | 256×192 | 192 KB | 900 | 169 MB | 336 |
| 3 | ÷8 | 128×96 | 48 KB | 1600 | 75 MB | 1271 |
| 4 | ÷16 | 64×48 | 12 KB | 8200 | 96 MB | 7500 |

¹ At the current `BASE_TILE` of 1024×768. These columns are illustrative — they
move with the tile, and the tests recompute them rather than trusting the table.
≈1.3 GB if every level fills, which is a ceiling and not a reservation: entries
appear only as cells are visited. `CACHE_SCALE` dials the whole table at once for
a machine that can spare less; the ratios between levels are the part worth
keeping.

##### Changing the tile

Edit `BASE_TILE`. The suite then re-derives the consequences and reports the two
that need a human decision:

- **Reachability.** A much larger or much taller tile can push a rung outside the
  camera's zoom clamp, and a level nothing can select is dead weight in the
  pipeline. The test couples the ladder to `MIN_ZOOM`/`MAX_ZOOM` and names the
  rung to add or drop. (At 4096² level 0 is already unreachable — `MAX_ZOOM ×
  dpr 2` does not reach half of it.)
- **Budgets.** A shorter tile fits more rows on the same screen, so the
  worst-case screen grows and a budget sized for the old shape may no longer
  hold one. This is not hypothetical: going from 1024² to 1024×768 took the
  coarsest level's worst case from 5700 cells to 7500, which is why its budget
  is 8200 rather than the 7000 it was. Pushing further to 1280×720 fails the
  check with the number it needs — 8200 against 10616. That is the intended
  behaviour: the budgets are a judgement call about memory, so the test computes
  the floor and leaves the choice.

Non-square is handled in selection, not merely tolerated. Demand normalises both
axes onto the width ladder and takes the larger, so a cell whose shape differs
from the tile's — a wide tile stretched into a square cell — is resolved on
whichever axis needed more, never under-resolved on the stretched one. The tests
run the whole policy at 16:9, 3:4, a small square and a non-power-of-two tile.

Two things that table encodes. First, **level 0 is budgeted at eight times its
worst-case screen** (240 against 30) — that headroom is rule 3 buying revisits,
not screens: tour eight rooms up close, come back to the first, no refetch.
Second, **the coarse levels get the bigger budgets**, which is rule 3 in service
of rule 1: the coarse field is what every finer level falls back on, so it must
not be what gets evicted to make room for a zoom-in.

##### Level selection

Demand is `zoom × devicePixelRatio` — **device** pixels, because that is what a
tile actually covers. Picking on CSS pixels would ship half-resolution art to
every retina display. The chosen level is the smallest tile not smaller than the
demand, so a tile is never upscaled while a big enough one is available.

Every level must be reachable by some zoom within the camera's own clamp — a
level nothing can select is dead weight in the pipeline. `pyramid.test.mjs`
couples the ladder to `MIN_ZOOM`/`MAX_ZOOM` and asserts it: change the clamp and
it names the rung to add or drop.

Switching carries a **15% hysteresis band** (`HYSTERESIS`). Without it, holding a
zoom near a boundary flickers between two levels and every flicker is a full
screen of fetches. A jump of several levels still lands on the true level rather
than creeping one rung per frame.

##### Rule 1: never blank

Three layers, in order:

- **`bestAvailable()` falls back through the room's other levels** — coarser
  first (cheap, usually already resident from the zoomed-out view, upscales to
  something soft but correct), then finer (memory already spent, so drawing it
  beats drawing nothing). A cell draws a hole only if *no* level of that room is
  resident.
- **The generic room's coarsest level is preloaded and pinned**, never evictable.
  12 KB decoded (1.2 KB over the wire) buys a last-resort fill for any cell
  whose own room has nothing yet, so the floor is a real wall rather than a flat
  `#15120f` hole.
- **A 404 is remembered, not retried** (`tiles.js` does this already) and
  permanently demotes that cell to the next level that works.

Because the fallback is what makes this true, per-level LRU is load-bearing
rather than a nicety. **A single global LRU would break rule 1**: zooming in
would flood the cache with level 0 and evict the entire coarse field, so zooming
back out would flash blank across the whole screen — exactly the failure the
pyramid exists to prevent. Budgets are therefore per level, and levels never
evict each other.

##### Rule 2: load ahead

- **A ring of `PREFETCH.margin` cells outside the viewport** is loaded at the
  current level, queued strictly behind everything visible.
- **The next level out is warmed for visible cells** (`warmLevels()`). The
  asymmetry is deliberate: zooming *in* needs few tiles and the coarse one on
  screen upscales acceptably while they arrive, whereas zooming *out* needs ~4×
  as many tiles at once and has nothing to show until they land.
- **`PREFETCH.concurrency` caps in-flight prefetches** below the browser's ~6
  connections per host. A prefetch that queues ahead of a visible tile has made
  rule 1 worse in order to serve rule 2, which is backwards.

##### How it is wired, end to end

- **`scan.mjs` discovers the levels.** It works out what the ladder would
  produce at the corpus's own source size, then keeps the rungs whose `<width>/`
  directory is really there, and puts them in the manifest. Level 0 is always
  present — it is the flat files — so a directory that has never been near the
  pipeline is still a valid corpus with one level. Deliberately not checked:
  whether *every room* has *every* level. A room missing one 404s, and a 404 is
  already remembered and demoted, so per-file probing would be thousands of
  stat calls to learn what the fallback handles anyway.
- **The cache keys on `(id, level)`**, not `url`, with a Map per level and each
  level's own budget from `pyramid.js`. `get(id, want)` starts the nearest
  *servable* level loading and answers with the best thing resident, reporting
  which level that was — so the renderer can tell a substitute from a hit.
  "Nearest servable" is what makes a flat corpus work: with only level 0 on
  disk, a request for level 4 resolves to 0 rather than waiting forever for a
  file that does not exist.
- **The render loop moved out of `main.jsx` into `render.js`**, which is what
  made the byte-cost test possible. It takes a 2d context and the state of the
  world, and owns no React and no DOM lookups. `main.jsx` now sizes the canvas,
  calls `draw()`, and writes the HUD.
- **The generic room is pinned and preloaded at its coarsest level** — 12 KB
  that guarantees every cell has something to draw.
- **The world's base unit is the cell, and a cell is not assumed square** —
  settled, and implemented. `camera.js` now keeps world coordinates in cells and
  applies the tile's aspect only when mapping to the screen: `zoom` is pixels per
  cell *width*, `pxPerCell()` is the single place the height follows from it, and
  every camera operation preserves the shape. `packages/map` needed no change at
  all, which is the payoff — slot placement, ranking and the boundary radius are
  all in cells and do not care what a cell looks like.

  Two consequences, both handled. **The library is round on screen, not round in
  the index**: `createLayout()` takes the cell aspect and measures every distance
  in cell *widths*, so the edge is the same distance away whichever way you drag
  — see [§5a](#5a-why-the-map-knows-the-cell-shape). And **the lamp is a circle
  and stays one**, the single thing in `geometry.js` deliberately not stretched
  with the tile; everything else is part of the wall and does follow its shape.
  See [§2](#changing-the-tiles-aspect).
- **Offline mode needs a layout convention** — `<dir>/<size>/<file>`, e.g.
  `<dir>/64/000.jpg`, with bare files at the top level read as level 0. `scan.mjs`
  discovers which levels exist and falls back to whatever it finds, so a flat
  directory keeps working unchanged and "point it at a directory" stays true.
- **Generating the pyramid is a pipeline job**, not a server job — built, as
  [`packages/pipeline/`](../packages/pipeline/). See
  [§3b](#3b-the-pyramid-generator).
- Bandwidth follows the same curve, and harder than the decode ceiling does.
  Measured on the sample corpus: a level-4 tile is **1.2 KB** encoded against
  **74 KB** at level 0, so a far-out screen costs about a sixtieth of what it
  used to. That is the number that matters once this is hosted.

#### Camera movement

"Centre" used to teleport, which loses the reader's sense of where they were.
`flyTo` now eases position and zoom together over `camera.flightMs` — 450 ms by
default — interruptible the moment a hand touches the map. The same helper
serves "fly to the best match" after a search, which is the case where the
movement is carrying meaning: it shows the top result's location relative to
where you were standing.

**The duration is `camera.flightMs` in config**, not a constant (see
[`design-history.md`](design-history.md#flight-duration-source-constant--config)).
Zero means "arrive at once", the same thing `prefers-reduced-motion` asks for, so
it is how a config switches the animation off; reduced motion still wins over
whatever is configured. Two guards, both reported rather than thrown: a duration
past five seconds is clamped, and a positive duration shorter than one frame is
honoured but flagged, because `0.45` is what seconds look like typed into a
milliseconds field.

Three things the implementation settled:

- **Zoom interpolates geometrically, position linearly**, which is the whole
  content of `flightAt()`. Zoom is pixels per cell, so a linear ramp from 26 to
  900 spends nearly all its time near 900 and reads as a snap then a crawl; the
  ratio is what the eye reads, the same reason the wheel is exponential. Position
  needs no such treatment over the tens of cells this map flies. The midpoint is
  asserted against the geometric mean, which a linear ramp fails.
- **The flight rides the glide's rAF loop rather than starting its own.** One
  loop makes the precedence statable in a single `else`: a flight owns the camera
  while it lasts, the glide takes over on arrival. That is what lets a flight
  *land* outside the content region and be pulled back afterwards, rather than
  being fought all the way there.
- **Interruption is `pointerdown` and `wheel` dropping the flight**, because a
  flight easing its zoom under a hand drags the world out from under the finger.
  Dropped on `pointerdown` rather than first move, so even a press that never
  becomes a drag stops it.

Landing returns the target camera *by identity*, so a flight ends exactly where
it was aimed, and `aspect`/`limits` come along without the interpolation knowing
they exist.

#### The reorder animation

A rearrangement is a **sliding-tile illusion**: whole rows and columns rotate,
and nothing is ever seen to move over anything else. See
[`packages/map/illusion.js`](../packages/map/illusion.js) for the planner,
[`board.js`](../packages/map/board.js) for the map-shaped half, and
[`packages/web/src/slide.js`](../packages/web/src/slide.js) for the animation.
It replaces a cross-fade;
[`design-history.md`](design-history.md#rearrangement-cross-fade--sliding-tile-illusion)
covers why, and why a free-form glide was the wrong sliding motion.

The move set makes the illusion structural rather than checked: rows and columns
may rotate anywhere, and an arbitrary swap — which would read as teleportation —
is legal only off camera. "Preserve the illusion" reduces to "emit only legal
moves", so no renderer has to be careful.

**The rearrangement is sequenced after the fly home, not against it.** Two
animations competing for attention and neither lands; and the plan is made
against exactly the cells on screen, so it cannot be made until the camera stops.
`flyTo` returns a promise for the landing and `startRearrangement` awaits it. The
promise answers *whether* it landed as well as *when*: a flight ended by a hand
landing on the map falls back to the instant rebuild rather than rearranging
under a reader who has just grabbed it.

How it fits the map:

- **The centre needs no special case.** It is cell (0, 0), already reserved by
  `ordering.js`, so it holds the same value in both boards and is simply handed
  over as the planner's fixed tile. Its row and column become unshiftable, which
  is what makes everything visibly pivot around it.
- **The board is finite, the map is not.** A window is cut per rearrangement and
  thrown away. That is only honest because the camera is parked on the centre at
  the opening zoom for the duration - the rotations wrap, and the wrap has to
  happen where nothing is drawn. It is also why the animation ends the moment
  the map is touched.
- **Visible cost is the viewport's, not the corpus's.** Everything outside the
  on-camera rectangle is a swap, and swaps are invisible, so a 5000-room corpus
  costs the same slides as a 50-room one - measured, and asserted across a 16x
  range. A 5000-room board is 157x209 and plans in 138ms.
- **The region is the viewport plus one cell.** The planner swaps into the cell
  just outside it and then slides that cell inward; a region hugging the
  viewport would put that swap on a partially visible cell and break the
  illusion along the screen edge.
- **The rooms-on-the-map slider cannot be animated.** Pulled back, a reorder
  changes *which* rooms are placed, and a room that was never on the board
  cannot slide in from a cell it was never in. `buildRearrangement` returns null
  and the caller keeps the instant rebuild. Faking it would mean a tile changing
  its face off camera and sliding on as something else.

**The animation plays as a wave, not a queue.** Two mechanisms, both structural:

- **The planner parks a batch of columns rather than one**, making the batch's
  columns independent, and says so in the move list — every move carries a
  `stage` (a hard barrier) and a `line`, and feed stages are marked `wave`. The
  animation plays a wave's lines concurrently, staggered outward from the centre,
  so a batch of columns sweeps rather than queues.
- **Everything else cascades.** Runs start a beat apart but finish in plan order,
  which is safe because a run's moves are applied as it passes them and the last
  at its completion — ordered completions are ordered application. That covers
  the extraction rotations, which a small corpus needs many of, since most of its
  rooms are on camera at once and a value with no copy off camera has to be
  rotated out before it can be staged.

The five durations are config (`slide.base`, `perCell`, `gap`, `stagger`,
`cascade`), beside the opening zoom and for the same reason - they are by-feel
numbers with no right answer. `slide.js` takes them and states none of its own.

Measured, desktop / laptop / phone: 1.20s / 0.74s / 0.60s at 200 rooms and
above, 1.73s / 1.31s / 0.99s on the 26-room sample corpus, which needs the most
extractions. Planning is 5ms, or 110ms for a 5000-room board. Growing the corpus
never lengthens the animation and mildly shortens it, which is asserted.

Two things measured rather than assumed: the animation holds one level for its
whole duration (the zoom is parked, so `pickLevel` cannot move), and no frame
went blank on the sample corpus at any point in a rearrangement.

#### Alternate generic rooms — **landed**

The generic room is ~80% of every screen, so it is the single asset the map leans
on hardest, and one of it is visibly one of it. A handful of alternates —
selected per cell by a seeded hash, with the seed in config — breaks the
wallpaper up without touching the corpus.

It costs nothing on the seam front, and for a structural reason worth stating:
every alternate is inpainted from the same base with the same edge-clear mask, so
alternates tile with each other and with every corpus room by exactly the
argument in [§1](#1-what-a-tile-is). There is nothing extra to verify.

**Where the design shifted from the original sketch.** The centre and the
wallpaper are now *different* images. The centre at cell (0, 0) is always the
blank `base.tile.png` — the plain render, reserved for the search box and
controls — and the wallpaper elsewhere is one of the inpainted variants, *never*
the blank tile. So there is a distinct `CENTRE` tile id and N `variantId(i)` ids,
not one shared `GENERIC`. The base assets also live *outside* `--images`, in a
`--base-dir` (default `assets/`): the blank tile at its root, the variants in a
`base_variations/` folder. That is what lets the base render be shared across
corpora and swapped from the inpainting pipeline without touching a corpus, and
it is why `000.jpg` is now an ordinary ranked room rather than the wallpaper.

The seams, as built:

- **`ordering.js` picks the variant.** `genericVariantAt(x, y)` alongside
  `isContentSlot`, on the same `cellHash` machinery — stable, stored nowhere,
  infinite — but salted with `genericVariantSeed` so the choice of wallpaper does
  not correlate with which cells are content slots. It is **positional and
  order-independent**, which is load-bearing: a reorder never changes a generic
  cell's face, so `board.js`/`illusion.js` still see one interchangeable
  `GENERIC` value and the rearrangement planner did not have to change at all.
  `roomAt` is unchanged; the layout gains a `variantAt(x, y)` the renderers call.
- **`scan.mjs` discovers a base set.** `scanBase()` finds the centre (`base.tile.*`,
  else `base.*`, else `--base`) and every image in `base_variations/`. The
  manifest field is `base: { centre, variants }`, served from `/base/` (a new
  static mount in `app.mjs`). The old single-directory behaviour survives as the
  `baseDir === imagesDir` case.
- **The two renderers translate a cell to a tile id.** `render.js` maps the
  centre to `CENTRE`, a generic to `variantId(layout.variantAt(x, y))`, a slot to
  its room id; `slide.js` does the same off board values, reading the variant at
  each tile's *home* board cell so a sliding line carries its own faces rather
  than flipping variant mid-ride. `variantId(-1)` is `CENTRE`, so a corpus with
  an empty `base_variations` still draws.
- **Pinning is bounded, not budgeted-per-level.** The base tiles are served flat
  (level 0), so `main.jsx` pins the centre plus each variant at level 0 — a
  handful of entries under a 240 budget, rather than the unbounded across-levels
  pinning the original sketch worried about. Giving the base assets their own
  pyramid (so the fallback is 12 KB again, not a full-res download) is
  [§8](#8-next-session) item 1.

### Phase 4 — search *(concept step 5)* — **CLIP landed; two more signals to come**

CLIP alone is wired end to end and ranks the whole corpus. Keywords and story
text join it as two further signals over the same single sort —
[§3d](#3d-hybrid-search--three-signals-one-sort) is the scoring model, and
[§3c](#3c-room-metadata--keywords-and-stories) is where the text comes from.
What follows is the CLIP half, which is done.

The CLIP backend is mostly not a cost question, because the expensive half
precomputes:

- **Image embeddings computed offline**, shipped as one blob. 5,000 rooms × 512
  dims × int8 = **2.5 MB** (26-room sample: 13 KB). `tools/embed/embed.mjs`
  writes `embeddings.bin` + `embeddings.json`.
- **Ranking runs in the browser** — `rankByEmbedding()` in `packages/map`. A few
  million multiply-adds, well under a frame.
- **Only the text tower runs at request time.** `/api/search` runs it and
  returns the query vector; the browser owns ranking, so a re-rank or a
  history restore costs no round trip.

No CLIP service to pay for in steady state.

**The model choice was correctness, not quality.** Both towers must be the *same*
CLIP or they point into different spaces and every ranking is quiet nonsense.
The image side is `transformers.js` (`Xenova/clip-vit-base-patch32`, OpenAI
weights) so the text side can be the identical model files in Node — no export,
no parity gamble. laion2b would rank a few benchmark points better, but on a
corpus of near-identical library walls that gap is imperceptible, and matching
the towers is not optional. If quality ever matters, the lever is model *size*
(B/32 → L/14), not the training set.

**Four seams hold it, and none of them restate the model choice.**
`tools/embed/embed.mjs` borrows `scanDirectory()` for the file order, so a row is
a room id by construction rather than by a re-implementation that could drift.
`scan.mjs` surfaces the blob's metadata into the manifest, and ignores a stale
blob whose count no longer matches the corpus — a wrong-length blob would rank
the wrong rooms. `app.mjs` lazy-loads the text tower (dynamic `import`, so the
stub path and the tests never pull the heavy dependency) and falls back to the
deterministic stub when there is no blob or the model will not load. `main.jsx`
fetches the blob once and ranks against it. The stub is still there, still
labelled, for a corpus that was never embedded.

### Phase 5 — the controls in the centre room *(concept step 6)*

Bind to the anchors in `tile-geometry.json`: `searchField`, `submitButton`,
`historySpines`, `scoreSortSpines`, `shuffleSpine`. Transparent hit regions
positioned by the same transform that draws the centre tile, with the visible
affordance painted into the art.

#### The history spines — landed

Every book on all five shelves — 160 of them — carries a composited title that
reads top-to-bottom down the spine, the way a shelved book is printed. Two roles
share the wall: the `historySpines` anchor (shelf 1) holds the **search
history** — every search projects onto its frontmost book, newest first, and
clicking a book repeats its search — while every other book shows a random corpus
keyword. Confining history to one shelf keeps it legible as history and turns the
rest of the wall into a browsable index; clicking any keyword book runs it as a
search. Reserved **override** books — a future artist's statement, say — are a
built seam that ships empty; history never overwrites them.

Why all 160 rather than the one history shelf: the history alone is a shelf of
text among four blank ones, and a much smaller pool of keywords to stumble on.
Lettering the whole wall is more of the corpus surfaced and a more finished tile
— the extra books are tags, so nothing about history changes.

Where it lives, and the decisions that shaped it:

- **`packages/web/src/centre.js` is the pure half**, split out like `picking.js`:
  the book geometry, `assignTitles` (override → history → tags, in that
  precedence), the hit-test, `pickTags` and the text compositing, all assertable
  without a browser (`centre.test.mjs`). Every book is one flat slot id — the
  history shelf is just the id range that falls on it — so there is one address
  for a book, not a (shelf, index) pair to keep in step. The geometry comes from
  the SINGLE SOURCE — `layout({ width: 1, height: 1 })` from
  `tools/base-image/lib/geometry.js`, the same module the manifest is generated
  from — as raw per-axis fractions, which is exactly the space `render.js`
  stretches the tile into. (Superseded below: history no longer anchors to one
  shelf.)
- **`render.js` composites on the centre cell only, and it is zoom-gated.** A
  spine narrower than a legibility floor carries no text at all — the shelf holds
  Borges' 32 books, so a title is only readable once the reader has zoomed in.
  The map OPENS framed on the bookshelf so the history is legible on load: the
  opening zoom is DERIVED at mount (`main.jsx`, via `fitZoom` in camera.js) to
  fit the centre room's book-bounding box (`GEOMETRY.opening`) to the display, centred on it and capped at
  the tile's native width so a page never loads upscaled. It is not a config
  value — being derived from the viewport, it is too far out on a phone and too
  far in on a wide monitor to state as one number. The **return-to-centre** zoom
  stays a config value (`defaultZoom`, 220): the "centre" button and the
  rearrangement park there, so the reorder animation still has a wall of rooms to
  slide across rather than the one shelf the opening view shows. Two zooms,
  because the opening and the home-for-rearrangement views want opposite things.
  Manual zoom now reaches 2x the tile's native width (`MAX_ZOOM_FACTOR`), so a
  reader can enlarge a spine past 1:1 to read it; past 1x the flat base tile is
  upscaled, which is what the base-tile LOD step (§8) will fix.
- **The gesture is a left-click / tap**, added to `useMapCamera.js` as `onTap`:
  fired on a pointer-up that neither panned past the slop nor stopped a flight,
  and cleared by a completed long-press so a press is never also a tap. Left
  click was reserved for "focus this room" and otherwise unused, so the centre
  books claim it without collision. History is session-only React state, newest
  first, capped at the 32 books.

Still unbound, for a later pass: `scoreSortSpines` (freed by the death of
curation — §5b), `shuffleSpine`, and making `searchField`/`submitButton`
themselves the hit regions rather than the side panel.

**Update — book size and count changed for legibility.** At story-accurate
spine width the composited titles above were a handful of illegible pixels even
at the 2x zoom cap. The centre tile was redrawn with fewer, wider books (3
shelves, 40 total at the time of writing, one shelf split into two runs around a
baked-in "Index of Babel" nameplate that holds no book slot), and the trace now
also reserves a `search_box` rect - exposed as `CENTRE_SEARCH_RECT` - for a
future pass to move the DOM search form onto the tile itself. The story-exact
count and `checkAgainstStory()` are gone; see
[design-history.md](design-history.md#the-centre-trace-story-exact-532--a-ui-sized-wall-and-the-lamp-dropped)
for why. This also folds in §8 item 3 (typography): the physical size half of
that item is done; contrast/weight are still open.

**Update — history is no longer confined to one shelf.** With shelves this
small, 8 slots on one shelf turned over too fast to be useful as history. History
now fills the whole wall as one queue, top left to bottom right, skipping any
book an override has claimed — `HISTORY_SLOT_COUNT` is `BOOK_COUNT`. The
`HISTORY_SHELF` constant and the "one shelf is history, the rest is tags" split
are gone; a book shows history until the queue runs out, then falls back to a
tag, same precedence as before (override → history → tags), just no longer
gated on which shelf a book sits on.

### Phase 6 — generate-on-demand *(stretch)*

Selectively enabled for short periods, so it needs a kill switch and a queue but
not autoscaling. Keep it behind a flag.

---

## 3a. Testing

~300 tests (`npm test`), in a couple of seconds, with no browser and no network.
`node --test` discovers `*.test.mjs` on its own, so a new file needs no wiring.

| | |
| --- | --- |
| `packages/config/config.test.mjs` | defaults, the narrow-only zoom rule, the flight duration and its two guards, every validator reporting rather than throwing |
| `packages/config/load.test.mjs` | a missing overlay, a partial one, a malformed one |
| `packages/map/scoring.test.mjs` | folding, both partial-match rules, normalisation, and that the blend is a blend rather than tiers |
| `packages/map/metadata.test.mjs` | entry normalisation, the filename join, coverage vs. a drifted sidecar |
| `packages/map/ordering.test.mjs` | slot placement, stability under re-ranking, resistance, roundness at any cell shape |
| `packages/server/port.test.mjs` | the busy-port check, and that its probe releases what it borrowed |
| `packages/server/scan.test.mjs` | header parsers, directory rules, the metadata sidecar |
| `packages/server/app.test.mjs` | the four endpoints, against a live socket |
| `packages/web/src/picking.test.mjs` | which room is under a point: flooring, the ranking, the centre and generic cells, any zoom or cell shape |
| `packages/web/src/camera.test.mjs` | the pan/zoom invariants, that a configured zoom range survives every operation, and that a flight eases geometrically in zoom and lands exactly |
| `packages/web/src/tiles.test.mjs` | per-level budgets, fallback across levels, frame-aware eviction, pinning, prefetch caps |
| `packages/web/src/render.test.mjs` | level selection on a real layout, never-blank, the ring and the warm pass, a zoomed-out frame's byte cost |
| `packages/web/src/pyramid.test.mjs` | level selection, fallback, budgets against one screen |
| `packages/pipeline/mips.test.mjs` | the level plan, real resizes, aspect agreement |
| `packages/web/bundle.test.mjs` | the client compiles |
| `tools/base-image/geometry.test.mjs` | the trace agrees with the story and with the tile's aspect; the layout and the manifest keep that aspect rather than squaring it |

Three notes on how, since they are the parts that were not obvious:

- **Fixtures are synthesised, not committed.** `image-fixtures.mjs` builds PNG,
  JPEG and all three WebP headers byte by byte, so the dimensions under test are
  visible in the test, and nothing depends on `assets/corpus-sample/` staying
  exactly 25 images. The nasty cases are there — a truncated JPEG, a segment
  length of zero, and the `0xc4`/`0xc8`/`0xcc` markers that share the SOF range
  and would otherwise be read as a frame header.
- **The camera maths moved to `packages/web/src/camera.js`.** `useMapCamera.js`
  keeps the pointer plumbing; everything expressible as an equation is now a
  pure function, which is the only way to assert the invariant that matters —
  zoom keeps the world point under the cursor fixed, including at the clamp.
- **The traversal test bypasses `fetch`.** `fetch` normalises `..` out of a URL
  before it reaches the wire, so the request that expresses the attack has to be
  written to a socket by hand.
- **The pyramid's tests assert the policy, not the constants.** They check that
  every level is reachable within the camera's clamp, that no budget is below
  one worst-case screen plus its prefetch ring, that coarse levels are budgeted
  above fine ones, and that a fallback exists whenever any level is resident.
  So the numbers stay tunable — moving a budget is fine, moving it somewhere
  that breaks a rule is what fails. Each was checked by breaking it on purpose:
  starving a budget, zeroing the hysteresis, reversing the coarse-before-fine
  preference, and adding a level below `MIN_ZOOM` all fail the suite.
- **And they run at five tile shapes**, not just the current one, so nothing can
  quietly re-pin itself to one size or one aspect — re-hard-coding the current
  1024×768 inside `sizeOf()` fails three of the checks. The one that mattered
  most was almost useless: the check that a stretched cell resolves on its
  hungrier axis was written with `<=`, which passes when the height is ignored
  entirely. It asserts `<` now, and fails against an implementation that drops
  the axis.

### The browser smoke test

`packages/web/e2e/smoke.e2e.mjs` — the drive script, committed. It spawns the
real demo server against the sample corpus and drives Chromium through load,
pan, zoom, both sliders, a camera flight and its interruption, a search, the
room card (right-click, chips, escape), the long press and a two-finger pinch,
plus a check that nothing reached the console.
It is the only layer that catches **"the canvas renders nothing"**, which no unit
test will and which `bundle.test.mjs` only narrows to "it at least compiled".

```sh
npx playwright install chromium   # once
npm run test:e2e                  # ~3s
```

Deliberately outside `npm test` and outside the pull-request job — a browser is
more machinery than every push earns on a project this size. It runs from
[`e2e.yml`](../.github/workflows/e2e.yml), which is manual dispatch only and
uploads the final frame as an artifact. The filename sits outside the patterns
`node --test` discovers, so it cannot creep back into the fast suite by
accident; `playwright` is a devDependency, and the PR job sets
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` so `npm ci` never fetches a browser it will
not open.

Three things it does that are worth keeping if it gets rewritten:

- **Blankness is measured, not eyeballed.** It reads the canvas back and counts
  distinct colours on a sampled grid. A working map returns hundreds; with
  `drawImage` removed it returns 5. Photographs are the signal — a canvas that
  is only flat fills is exactly the failure being hunted.
- **The search assertion holds the camera still.** A search both flies home
  *and* reorders the rooms, so comparing pixels across the flight passes on the
  camera move alone — a version whose ranking is discarded entirely still looked
  fine. It now parks at the centre, records the view, wanders off, searches, and
  compares at a provably identical camera.
- **The sliders are driven by `Home`/`End` on a focused range input**, which is
  real user input, rather than by reaching into React's value setter.
- **An animation is observed frame by frame, not by its endpoints.** A flight
  and a teleport have the same start and the same finish, so `sampleCamera()`
  starts a per-frame sampler in the page *before* pressing "centre" and counts
  the distinct cameras in between: a teleport shows exactly two. Its companion
  is `landed()` — every assertion that compares a camera before and after some
  gesture now needs the before to be a camera at rest, and two frames is no
  longer enough. It waits the flight out and then confirms stillness, because
  the last frames of a smoothstep move by less than the HUD prints and "two
  identical readings" would call it early. **How long it waits is read off the
  manifest**, not imported from `camera.js`: the duration is configurable, so a
  machine with a `config.json` would otherwise have the test waiting the wrong
  amount of time for the camera in front of it. That the whole suite still
  passes against a `flightMs` of 1500 is what proves the knob is wired — test 8
  grabs at a third of the duration, so it would find an already-landed flight if
  the configured value had not reached the client.

Each of those was checked by breaking the app on purpose and confirming the test
failed: no `drawImage`, a discarded search order, an ignored `contentRatio`, a
stray `console.error`, a `flyTo` restored to a teleport, and each of the two
interruption lines removed in turn. A green e2e test that cannot fail is worse
than none, because it is believed. (One trap in writing them: `locator.click()`
leaves the pointer over the button, so a following `mouse.down()` meant to grab
the map never reaches the canvas — move back onto the canvas before grabbing.)

The overlay's and the pinch's tests are the layer that matters most, since the
gesture is the half no unit test can reach. A press that no longer cancels on
drag, chips wired to nothing, an Escape key that does not close, a second finger
that feeds the drag instead of starting a pinch, a pinch that ignores its
midpoint, and a finger-lift that does not re-anchor all fail the suite.

**Pinch needs raw CDP**, because Playwright's touchscreen is single-touch. Two
details of `Input.dispatchTouchEvent`, both of which fail quietly: a `touchEnd`'s
`touchPoints` are the points being *released*, not the ones that remain; and
points need an explicit `id`, or Chromium matches them by position and reads a
move after a release as a new finger rather than the surviving one. Both are
written down in the helper.

**The limit of that approach is worth stating.** CDP injection dispatches pointer
events straight to the page, bypassing the compositor's gesture arbitration and
the real pointer-capture lifecycle — the very layers `touch-action` and
`pointercancel` live in. It is a known blind spot, and the first instinct on a
device-only report should not be to believe it: at least once, "pinch is broken
on Android" was a stale demo server serving old code, not the gesture code.

Three things around that blind spot are worth having:

- **The capture calls are guarded.** `set`/`releasePointerCapture` throw
  `NotFoundError` for a pointer the browser does not consider capturable, which
  is ordinary on touch, and `pointercancel` reaches the release with capture
  already dropped. An unguarded throw would strand a finger in the pointer map. A
  test makes both calls throw — the honest way to cover a hazard the injected
  path cannot produce.
- **`?touchdebug` prints the raw pointer stream on screen**, because a phone has
  no console you can read with both thumbs busy.
- **`npm run demo` refuses a busy port**, checked before anything is scanned or
  bundled — it used to bind, print its banner, take `EADDRINUSE` and exit 0,
  leaving an older process answering on that port with stale code.

### Still missing

**A prefetch-ordering test with real timing.** `render.test.mjs` asserts that
every visible cell is requested before any prefetch is issued, which is the
property that matters, but it does so within one synchronous frame. What is not
covered is a prefetch still in flight when the next frame needs the connection.

**Eviction under a long high-zoom session.** Level 0's budget of 240 is what
buys revisits rather than screens, and nothing yet wanders far enough at high
zoom to exercise it against a real corpus.

Not worth testing: the placeholder renderer's appearance, and anything that
pins an art choice rather than an invariant.

### CI

`.github/workflows/ci.yml` runs `npm test` on every pull request to `main` and
on `main` itself, across Node 20 (the `engines` floor), 22 and 24. The matrix
fans out into one check per version and a single `ci` job gates on all of them,
so branch protection requires one check name and the matrix can change without
touching repository settings.

`.github/workflows/e2e.yml` runs the browser smoke test, on manual dispatch
only, against a Node version picked at dispatch time. It is not a merge gate;
it is what you run when the map itself changed.

---

## 3b. The pyramid generator

`packages/pipeline/` turns a corpus directory into the levels the client asks
for. It is a one-shot offline job, deliberately not something the server does on
request — resizing 10,000 rooms is a pipeline concern, and a server that resizes
on demand has put a CPU-bound job on the request path.

```sh
npm run generate:mips -- --images assets/corpus-sample
npm run generate:mips -- --images <dir> --out <dir> [--quality 82]
```

**The ladder is imported from `pyramid.js`, not restated.** What the pipeline
writes and what the client asks for cannot drift, because there is one ladder
with two consumers. Sizes come from each source image's real dimensions rather
than from `BASE_TILE`, so the tool works on whatever the render actually is, and
both axes are divided together — a non-square source keeps its aspect at every
level.

**`sharp`, decided.** It is ~1 MB of JavaScript over prebuilt libvips binaries
(~28 MB installed, devDependency only, never shipped to the browser), and it is
several times faster than shelling out to ImageMagick without assuming anything
is installed on the machine. Resizing does not survive "can this be twenty lines
instead?", so it is the one place a real dependency was the right answer.
`lanczos3` is the kernel: these are photographs being minified, and a box filter
would alias the book spines into moiré.

**Level 0 stays flat.** Run in place and the smaller levels appear as
`<dir>/<width>/` subdirectories while the source files stay exactly where they
are — no duplicated bytes, and a corpus that has never been through the pipeline
still reads as a valid level 0. Pass `--out` and every level is written including
0, copied rather than re-encoded so the source art is never requantised. On the
26-room sample: 108 files, 2.0 MB → 3.4 MB.

Directories are named for the **width**, because width is the axis the client's
ladder is expressed in and the aspect is fixed, so the width names the level
unambiguously.

Two things it refuses to do quietly:

- **A corpus that cannot agree on an aspect ratio is an error**, listed room by
  room, before anything is resized. The map draws one cell shape; a room with
  another is either stretched or letterboxed, and that is not a decision to make
  silently on someone's behalf. A pixel of encoder rounding is tolerated.
- **A source too small for the whole ladder yields fewer levels, never duplicate
  ones.** Two divisors that round to the same width would write the same
  directory twice, the second pass overwriting the first at the wrong size.

Re-running is safe: the scan ignores the `<width>/` directories it writes, so a
second run resizes the originals rather than compounding on its own output.

---

## 3c. Room metadata — keywords and stories

Every room but the centre carries two pieces of authored text, both generated
upstream alongside the image:

- **Exactly three stylistic keywords** — material, movement, technique, artist
  and so on — the concepts that steered that variant's generation.
- **A short enigmatic fictional setting**, one paragraph, from a fixed prompt.

Both are retrieval signals ([§3d](#3d-hybrid-search--three-signals-one-sort)) and
both are readable in the UI ([§5b](#5b-the-metadata-overlay)). Generation is out
of scope here for the same reason the images are.

### The format

**Keyed on filename, not on id** — a `metadata.json` sidecar in the corpus
directory, which is what the generator already writes:

```json
{
  "001.jpg": {
    "keywords": [
      { "text": "verdigris copper", "type": "material" },
      { "text": "art nouveau",      "type": "movement" },
      { "text": "wet collodion",    "type": "technique" }
    ],
    "story": "The catalogue lists a room that has never been surveyed…",
    "alt": "A tall shelved wall in green shadow, its brass rail catching one lamp."
  }
}
```

`alt` is optional and is the one field here that is *not* a retrieval signal:
one sentence describing the picture, for a reader who cannot see it
([`accessibility-plan.md`](accessibility-plan.md) §3.5). Written once, offline,
by the generator, with the room's own story passed in as context so the two
accounts of one image cannot diverge — never at runtime, which is what keeps
the map free of a model dependency. It is optional in the strong sense: a room
whose story is thin should carry no `alt` rather than a padded one, because
"no description recorded" is a better answer than a confident sentence about a
wall of books that could be any wall of books. Absent, everything reads the
same without it.

The filename key is a deliberate difference from `embeddings.bin`, which is
row-major by room id and therefore only correct as long as nothing about the
directory changes. That coupling is why `scan.mjs` has to ignore a blob whose
count no longer matches: its rows are positional, so a stale one would silently
attach the wrong vector to the wrong room. A filename-keyed map has no such
failure mode — add, remove or rename images and every surviving entry still
lands on its own room. So the staleness rule is different, and weaker on
purpose: **join per file, tolerate misses, report the count.** A room with no
entry simply has no keywords, which is exactly what the centre room and the
generic alternates want anyway.

`type` is optional and worth including if the generator already knows it — it
lets the overlay label a chip and leaves room for weighting an artist match
differently from a material one later. Nothing should require it.

### How it reaches the client — built

Same shape as the embedding blob, for the same reason. `scan.mjs` reads the
sidecar and surfaces `metadata: { url, matched, entries }` into the manifest; the
static mount serves the file itself, and the client fetches it once in parallel
with `embeddings.bin`. It does **not** go inline in `/api/manifest`: at 5,000
rooms × (three keywords + ~300 characters of story) the sidecar is ~1.7 MB,
comparable to the 2.5 MB blob, and the manifest is fetched before anything can
render.

That keeps the property phase 4 established — the server runs the text tower and
nothing else, ranking is the browser's, and a re-rank or a history restore costs
no round trip.

**The join has one implementation and two consumers.**
`packages/map/metadata.js` normalises an entry and joins a sidecar onto the
corpus by filename; `scan.mjs` calls it to count coverage and the browser calls
it to build the array search and the overlay will read. Two implementations of
the same join is exactly how a room ends up described by its neighbour's
keywords.

**`matched` and `entries` are both reported, and the pair is the point.** A
sidecar whose keys have drifted — describing files this corpus no longer has —
produces zero matches, which from the map is indistinguishable from having no
sidecar at all. `matched: 0` against `entries: 2` is the only way to tell, so the
demo server says so at startup:

```
26 rooms with keywords or story (26 entries in the sidecar)
0 rooms with keywords or story (2 entries in the sidecar)
  none of them matched a room - are the sidecar keys the image filenames?
```

**Normalisation is liberal on purpose.** Keywords may be plain strings or
`{text, type}` objects and both normalise to the same record, because losing a
keyword over a missing category would be the wrong trade. The count is *not*
enforced — "exactly three" is a fact about how the corpus is generated, not a
constraint the map needs — and an entry with neither keywords nor story
normalises to null rather than to an empty record, so "has metadata" stays a real
question.

Not yet built, and deliberately: nothing *reads* the keywords yet beyond a room
count in the demo panel. Ranking is [§3d](#3d-hybrid-search--three-signals-one-sort)
and reading them is [§5b](#5b-the-metadata-overlay).

**The sidecar in `assets/corpus-sample/` is placeholder text**, generated to
exercise the search path before the real generator output lands — 26 rooms, 41
distinct keywords across the four categories, a distinct story each. It describes
nothing about the images it is attached to and is meant to be replaced. The unit
tests do not read it, per the convention that fixtures are synthesised rather
than committed; it exists so `npm run demo` demonstrates a search that does
something.

---

## 3d. Hybrid search — three signals, one sort

Three signals rank the same corpus, and the whole corpus is sorted by their
blend. Not tiers: an exact-match bucket sorted ahead of a CLIP bucket would let
a room with one weak partial keyword beat a room CLIP is certain about, and the
map's whole read is that *everything* rearranged, best in the middle, worst at
the edge.

```
score(room) = w_keyword · keywordScore + w_story · storyScore + w_clip · clipScore
```

The three weights are the "relative priorities of the three search types" and
live in config ([§3e](#3e-configuration)). Intended ordering, per the design:
keyword above story above CLIP, with an exact keyword match outweighing anything
CLIP can say.

**Every term must be normalised to [0, 1] first, and the CLIP term is the one
that makes this non-obvious.** Cosine similarity is nominally [-1, 1], but on a
corpus of near-identical library walls the scores for a given query cluster into
a narrow band — the images differ far less than CLIP's range allows. Blend the
raw cosine and there is no weight that works: large enough to matter and it is
still swamped by any keyword bonus, small enough to be balanced against one and
it is lost in its own noise. So `clipScore` is the raw cosine min-max normalised
**across the corpus for that query** — one extra pass over an array we have just
scored, which spends nothing and makes the weights mean what they say.

### Keyword scoring

Fold case and diacritics, tokenise the query, and for each query token take the
best match across the room's three keywords:

- **exact** token = keyword → `1.0`
- **partial** → `matched length / keyword length`, so `art` against
  `art nouveau` scores 3/11 and against `art` scores 1.0. That is "weighted
  based on match length", and dividing by the *keyword* length is what makes a
  short query matching a long keyword worth less than one matching it whole.
- below a minimum token length (3 is the obvious floor, and belongs in config) →
  no match, or `a` matches everything.

The room's `keywordScore` is the **mean over query tokens** of those bests. Mean
rather than sum: it stays in [0, 1] without clamping, and it rewards matching
more *of the query* rather than rewarding long queries.

### Story scoring

Same shape, one deliberate difference: normalise by the **query**, not by the
text. Dividing a match by the length of the story would mean a longer story
always scores lower for the same hit, which is backwards. So: the fraction of
query tokens present in the story, each token weighted by its own length, so
matching `cartographer` counts for more than matching `the`. Stopwords out.

### Where it runs

In the browser, in `packages/map/scoring.js`. For 5,000 rooms this is three
keywords and a paragraph each — string work measured in milliseconds, nowhere
near the frame the int8 dot products already fit inside, and keeping it
client-side is what preserves "a re-rank costs no round trip". `/api/search` is
unchanged: it still runs only the text tower and returns a vector.

Two implementation details worth calling out:

- **The index is built once, not per query.** Folding and tokenising 5,000
  stories on every search is about a megabyte and a half of string work;
  `buildSearchIndex()` does it when the metadata arrives and leaves each query as
  set lookups. Rooms without metadata stay null, so the array is still indexed by
  room id.
- **`embeddingScores()` was split out of `rankByEmbedding()`.** The blend needs
  the raw cosines to normalise, and the CLIP-only ordering is now built on top of
  the same function, so the dot product has one implementation.

### What this does to the stub

Better than it sounds. Keyword and story matching are **real search that needs no
model**, so a corpus with metadata and no `embeddings.bin` gets a genuine ranking
rather than the deterministic pseudo-ranking. The stub survives only for the case
it was written for — no metadata *and* no blob.

The panel reports which signals actually *found* something, not which were
available: a corpus full of keywords that this query missed must not claim to
have been ranked by keywords. So `ranked by keywords + CLIP`, or `ranked by
story`, or — when the text signals are silent and there is no CLIP to fall back
on — `nothing matched — showing index order`, which is what a corpus of all-zero
scores honestly becomes. CLIP alone says nothing, being the ordinary case.

This is not hypothetical: with the text tower unable to reach its model, the demo
falls back to text-only ranking against the sidecar and says so, which is exactly
the degradation the three states exist to describe.


## 3e. Configuration

**One surface for everything tuned by feel.** Those values used to be spread
across module scope in `camera.js` and `useState` defaults in `main.jsx`, which
is fine until the interesting ones need changing together.

`packages/config/config.mjs` holds `DEFAULTS` — every value with the reasoning
that justifies it beside it, the way `pyramid.js` does — and a `config.json` in
the working directory overrides any subset:

```
camera: { minZoom, maxZoom, defaultZoom, flightMs }   # opening zoom is derived, not configured
map:    { contentRatio, slotSeed, genericVariantSeed }
search: { weights: { keyword, story, clip }, minTokenLength, density: { … } }
```

```sh
npm run demo -- --config path/to/config.json     # defaults to ./config.json
```

**No `config.json` is committed, and that is the point.** One spelling out every
value would quietly become the real tuning surface, and editing the documented
defaults would stop having any effect — two statements of one fact, with the
undocumented one winning. The overlay is partial and optional; `DEFAULTS` stays
the single statement of every default. `map` and `search` are read by the demo's
sliders now and by [§3c](#3c-room-metadata--keywords-and-stories) and
[§3d](#3d-hybrid-search--three-signals-one-sort) when they land.

It reaches the client on the manifest rather than through an endpoint of its own.
The client already blocks on that fetch before it can render, so a second round
trip for a hundred bytes would only buy a state where the map exists and does not
yet know its own zoom range.

**The pyramid deliberately stays out of it.** `pyramid.js` is the single tuning
surface for the tile's dimensions, the ladder, the per-level budgets, the
hysteresis band and the prefetch ring — every one of those is *derived and
asserted* rather than tuned by feel, and a config file that restated any of them
would be a second statement of a fact that already has one. `CACHE_SCALE` is the
near-miss: a genuine by-feel dial, but it dials a table whose ratios the tests
check, so it belongs where the table is.

### Zoom config narrows, and never widens

This is the rule that makes configuring the camera safe, and it is worth stating
as the load-bearing decision it is.

`pyramid.test.mjs` asserts that every rung of the ladder is reachable within
`ZOOM_LIMITS` — the hard range in `camera.js`. That assertion held for free while
both numbers were source. Once the range could come from a file, the obvious
worry was that a config edit could orphan a rung at *runtime*, where no test is
watching, and the obvious fix was to validate a loaded config against the ladder.

The better answer is to make the question not arise: **config may only tighten
the range.** A value outside `ZOOM_LIMITS` is clamped to it rather than honoured.
Since no configuration can move the range outward, the reachability assertion
still covers every state the app can reach, and the ladder never needs consulting
at load time at all.

What is left — a narrowed range leaving the finest rung or two unreachable — is
**not an error and is not reported**. The cost is a few inactive lines and some
files in a bucket that are never requested; refusing a legitimate narrowing to
avoid that would be the tail wagging the dog.

Three consequences in the code:

- **`ZOOM_LIMITS` in `camera.js` is the hard range**, and the only statement of
  it. `DEFAULTS.camera.minZoom`/`maxZoom` are `null`, meaning "as far as the
  camera allows" — which is why this file does not restate 26 and 900.
- **The range rides on the camera as `limits`**, the same optional-field pattern
  as `aspect`, so every clamp goes through one field and no operation has to
  remember to ask. It carries the same hazard, too: rebuild a camera instead of
  spreading it and the range is lost mid-gesture. Both are asserted.
- **`resolveConfig()` takes the limits as a parameter**, so the whole policy is
  exercisable at limits the app is not using — which is how the tests check
  narrowing without pinning themselves to whatever `camera.js` currently says.

**Nothing throws.** A demo that will not start because of a typo in a tuning file
is worse than one that starts and says what it ignored, so every adjustment lands
in `notes` and the server prints them at startup. The failure mode a config file
actually has is a value that silently did not take effect; that is the one thing
this refuses to do.

---

## 3f. The search density gradient

**The problem.** The generic-room ratio and the search were fighting each other.
At the concept's 80% generic, the top matches are scattered across a wide region
at one room in five, so the rearrangement is real but nearly invisible — the only
way to *see* a search work was to push the slider to 100% unique, which throws
away the wallpaper the map is mostly made of. The feature that makes the library
feel like a library was making search unreadable.

**The fix.** `map.contentRatio` becomes a *baseline* rather than a constant.
Placement already walks candidate cells outward from the centre, handing rank 0
the nearest slot; now the acceptance threshold for the rank being placed is

```
contentRatio + (peak - contentRatio) * certainty[rank]
```

so a rank the search is sure about takes very nearly the first cell it meets, and
a rank it knows nothing about waits for one the baseline hash lets through. A
certainty profile becomes a density profile, and the cluster is dense *relative
to its surroundings* by construction — which means a sparser map now makes a
search **more** legible rather than less. The wallpaper stops being the price of
readable search and starts being the contrast that makes it readable.

Three behaviours fall out of the one formula, none of them special-cased:

| query | certainty | what the map does |
| --- | --- | --- |
| `yuiop`, on a handful of rooms tagged with it | 1 for those, 0 for everything else | a solid block against the centre, then the ordinary scatter — a hard edge |
| `red` | decays smoothly with CLIP's cosine | packing that loosens gradually outward |
| `cghjj` | below the floor everywhere | the uniform map, cell for cell |

### Certainty is a different question from ranking

The blend cannot answer "how sure are we". It min-max normalises CLIP across the
corpus for the query — which is [§3d](#3d-hybrid-search--three-signals-one-sort)'s
whole point, since raw cosines on near-identical library walls sit in a band too
narrow to weight — and normalisation guarantees *some* room scores 1 for any
query at all. A gradient driven by the blend would cluster `cghjj` exactly as
confidently as an exact keyword match.

So certainty is computed alongside the ranking, from the absolute form of each
signal, and combined as a soft OR (`1 - (1-k)(1-s)(1-c)`) so any one signal can
carry it and two weak ones agreeing count for more than either alone:

- **keyword and story ratios are already absolute.** An exact match is 1 because
  it is a match, not because it beat the corpus.
- **CLIP contributes its raw cosine** against a pair of thresholds
  (`search.density.clipLow/clipHigh`). This is the only place the unnormalised
  number is used, and the reason `embeddingScores` now divides the int8
  quantisation back out and returns a real cosine. A nonsense string still
  produces a valid text vector; what marks it as nonsense is that its cosine
  against every image is low in absolute terms, not that the spread vanished.

Two adjustments keep the profile meaning what it claims. Certainty is made
**non-increasing with rank** — the ordering is best-first by definition, so a
rank more certain than the one above it is a contradiction, and the running
minimum is which of the two to believe. And anything under `CERTAINTY_FLOOR`
snaps to *exactly* the baseline rather than slightly above it, so "nothing
matched" and "no search" are the same picture. They should be: the alternative is
a map that says "found it" about noise.

### What it cost

One design commitment, stated plainly: a search now recomputes placement, which
the uniform scheme never did. It is the same O(slots) rebuild the ratio slider
already triggers on every drag, rooms still arrive in rank order from the centre
out, and clearing the box restores the old layout exactly — there is no second
code path, because no profile *is* the uniform map. Re-ranking without a new
search is still a swap of one array.

Placement stays as cheap as it was, which took some care. Sorting every cell a
certain rank *could* take would mean sorting the whole sweep — 380 ms on a
5,000-room corpus at the slider's sparse end, against 38 ms for the uniform
layout. Instead each ring carries a lower bound on the rank the walk must have
reached by the time it gets there (every baseline-admitted cell nearer than it is
taken whatever rank is current), and since the ramp is non-increasing, a lower
bound on the rank is an upper bound on the threshold. The far field is therefore
filtered at the baseline exactly as before, and the extra sweep covers the
cluster rather than the map. Measured across the same worst cases, every
configuration now lands at or below the old uniform cost.

That bound is sound rather than lucky, and it is load-bearing enough to be worth
a test that can actually catch it: `ordering.test.mjs` fuzzes the optimised sweep
against an unpruned walk over 40 random configurations, and it fails on a
one-ring off-by-one in the bound, which nothing else notices.

---

## 4. Architecture

```
babel-index/
  tools/base-image/        # tile geometry, SVG importer               [exists]
  packages/map/            # slot placement, ranking, resistance      [exists]
  docs/                                                              [exists]
  packages/
    config/                # defaults + validation for the by-feel numbers [exists]
    pipeline/              # mips [exists]; embed [exists]; border-drift report
    server/                # Express: manifest, text-embed, generate queue
    web/                   # React: map, search, metadata overlay, centre-room controls
```

**Data: flat files, no database.** SQLite was here to carry scores, tags and
review status through curation; curation is dropped
([§3 phase 2](#phase-2--curation-concept-step-3--dropped)) and everything that
remains is a sidecar next to the images —

```
<dir>/                  the images, level 0
<dir>/<width>/          the pyramid levels        (packages/pipeline)
<dir>/embeddings.bin    int8 image vectors, row-major by room id
<dir>/embeddings.json   model, dim, count, file order
<dir>/metadata.json     keywords + story, keyed on filename   (§3c)
```

— which keeps "a directory of images is the entire data layer" true, and true of
a directory that now carries text as well. Provenance (seed, prompt, model,
ControlNet weights) stays a generation-side sidecar; the map has no use for it
and should not be the reason a database appears.

`config.json` is the exception and lives beside the *server*, not the corpus
([§3e](#3e-configuration)): it describes how to display a library, not
which library, so pointing the demo at a different directory should not change
how the map feels.

```
room: id, file, w, h, bytes, levels[],
      embedding (row in embeddings.bin), keywords[3], story
```

**Hosting**: a static bundle plus one small endpoint. The dominant cost is image
egress, which argues for **Cloudflare R2 + Pages** over GCS — R2 charges no
egress, and this project's cost profile is "serve a lot of images to whoever
wanders in." GCP + Terraform stay the right answer if generate-on-demand grows
into real infrastructure; they're the wrong answer for a static image map.

---

## 5. What the geometry is actually for

Worth being explicit, because it bounds how exact `tile-geometry.json` needs to
be: **per-slot hit-testing is only meaningful on a room whose art we control.**
Inpainting doesn't preserve shelf counts or book positions — the test corpus has
variants with four shelves, six shelves, vertical dividers, and books stacked on
the floor. So:

- The **centre room** needs exact geometry. It carries the search box and the
  hidden controls, and its art is ours. It sits at map cell (0, 0), which
  `packages/map` reserves and never assigns a corpus room.
- **Every other room** needs only its bounding box. Clicking one means "focus
  this room", not "click this book".

That's consistent with the concept, which puts the controls in one specific
room. It also means the provisional proportions are only blocking phase 5.

---

## 5a. Why the map knows the cell shape

`packages/map` is otherwise shape-blind — it deals in cells and has no idea what
one looks like. It takes exactly one parameter that breaks that, `aspect`, and
the reason is worth writing down because the simpler alternative looks fine
right up until the tile stops being square.

Every distance in that module is `cellDistance(x, y, aspect)` —
`hypot(x, y * aspect)` — which is the offset in units of cell **widths**, i.e.
proportional to what lands on screen. With a square cell it is plain `hypot` and
nothing changes.

**Why not just measure in cells.** The boundary is a navigation affordance: it
decides how far you may travel before the map resists. Measured in raw cells it
is a circle in the index, which is an ellipse on screen as soon as the cell is
not square — so the edge arrives sooner going down than going across, for no
reason the reader can see. Uniform bounds are worth one injected parameter.

**Why placement uses the same metric.** It has to. If only the boundary were
screen-circular and placement stayed cell-circular, the rooms would spread into
an ellipse inside a circular bound, and the difference would be free panning
over empty generic space at the top and bottom. A circle with nothing in it is
worse than an honest ellipse. One metric, both jobs.

Measured on a 16:9 cell at 400 rooms: the occupied region is 16 cells wide and
29 cells tall — and 16.0 by 16.3 in cell widths, i.e. round to within 2%. The
tests assert both halves, because they fail differently: dropping the aspect from
the metric entirely leaves the region 22×12.4 on screen, and keeping it in the
resistance but not in placement leaves it 22×12.4 as well while the boundary
stays circular, which is the specific bad state described above.

The cost is real and worth naming: `aspect` defaults to 1, so the module still
imports nothing and a caller with no opinion gets the old behaviour, but a
*changed* aspect reshuffles slot assignment. That is fine — changing the tile
changes the map — and the property that matters, that growing the corpus keeps
existing slots at a fixed aspect, is asserted at every shape.

---

## 5b. The metadata overlay

Keywords and a story per room are worth nothing unread, so the map needs a way to
open one. Three things constrain the design before taste does.

**The gesture cannot be a left click.** [§5](#5-what-the-geometry-is-actually-for)
reserves that for "focus this room", and a map whose primary button opens a modal
is a map you cannot explore. So: **right-click on desktop, long-press on mobile**
— which is also what the user's own instinct said, and it is right.

**The long-press has to lose to a pan.** This is the only fiddly part. A press
that becomes a drag must cancel the timer, so the press lives on the same pointer
stream `useMapCamera.js` already owns: start a ~500 ms timer on `pointerdown`,
cancel it the moment movement exceeds a slop radius or the pointer lifts. Get
this wrong and every attempt to pan on a phone opens a panel.

**Per-book hit-testing is impossible here, and structurally so.** Inpainting does
not preserve shelf counts — the test corpus has rooms with four shelves, six, and
books on the floor — so only the centre room knows where its books are. Any
design that needs "which book did you click" is dead on arrival for corpus rooms.

### What was built

A closable card, styled as a catalogue slip rather than a tooltip:

- **The three keywords as chips**, each one a live search. Clicking `art nouveau`
  runs that query and the library rearranges around it — free once
  [§3d](#3d-hybrid-search--three-signals-one-sort) existed, and it turns
  reading a room into a way of moving through the library rather than a dead
  end. The card closes as the chip fires, because the map is about to rearrange
  underneath it and it would then be describing a cell that no longer holds that
  room.
- **The story text**, and the room's id and filename.
- Escape, click-outside and an explicit close. Click-outside listens on
  `pointerdown` rather than `click`, or the canvas starts a pan under the
  dismissing press and the map lurches as the card vanishes.

Three things the implementation settled:

- **`picking.js` is the pure half**, and it is what makes any of this testable
  without a browser: screen point plus camera plus layout gives the room, with
  the centre and generic cells returning null. It floors rather than rounds,
  since cells are addressed by their lower corner — rounding shifts every pick
  half a cell up and left, which is invisible dead centre and wrong everywhere
  else.
- **The card is anchored where the gesture happened, not to the tile**, and
  clamped against its *measured* height. A guessed height is wrong for exactly
  the long stories most likely to run off a short viewport; measuring in
  `useLayoutEffect` means the correction lands before the browser paints.
- **The gesture lives in `useMapCamera.js`** because it has to lose to a pan, and
  that means watching the same pointer stream the drag does. The slop radius is
  8px: cancelling on the first pixel of jitter would make long-press unreachable
  on exactly the touch devices it exists for.

Freed by the death of curation: `scoreSortSpines` in `tile-geometry.json` — shelf
3, all books — has nothing left to sort by, and is the natural home for the
centre room's keyword affordances when phase 5 comes to bind it.

### The book-pull, and the trick that makes it affordable

Pulling a book off the shelf and opening it would be the best version of this,
and the impossibility above is only *half* an obstacle. The insight is that the
animation does not need to know which real book it came from: sample a
spine-shaped rectangle from the tile's own pixels, using a plausible spine rect
from the centre room's measured geometry scaled onto the target tile, and animate
*that* sliding out and rotating flat into the panel. On an inpainted room it will
land on a real spine perhaps half the time — and at the zoom where anyone opens
this, the other half reads as a book being pulled from a shelf that happens to be
painted differently.

That is a stretch, not the MVP, and it is written down here so the trick does not
have to be re-derived. Ship the overlay; earn the book.

---

## 6. Decisions made

The settled decisions, in the order they were made. Decisions that were later
reversed are in [`design-history.md`](design-history.md).

1. **Tile = one shelved wall, shallow perspective.** The unrolled-hexagon
   elevation is gone, along with the straddle-band and corner machinery it
   needed. Faithful 3D Library reconstructions already exist; this isn't that.
2. **The Blender render is the source of truth.**
3. **Seam accuracy is not enforced.** Inpainting from a shared base with an
   edge-clear mask makes it structural. `verify-seams` and the seam-mask assets
   are deleted. Border drift survives only as a pipeline report.
4. **No canonical inpainting mask in the repo.** Masks are a pipeline concern
   and will change between runs; encoding one would freeze a false constraint.
5. **Synthetic corpus** — 512 images, SD inference cheap enough that the
   placeholder-driven bootstrap was unnecessary.
6. **Corpus size and generic ratio are runtime-tweakable**, in `packages/map`.
7. **Generate-on-demand is a stretch goal**, selectively enabled.
8. **Geometry comes from an Inkscape trace, not the `.blend`.** Five minutes of
   human effort beats a parser; the `.blend` is in the repo as the source of
   truth but nothing reads it.
9. **Offline first.** A directory of images is the whole data layer. Hosting is
   deferred until there is something worth hosting.
10. **`sharp` for resizing.** Small wrapper over prebuilt libvips, faster than
    ImageMagick and assumes nothing is installed on the machine. A devDependency,
    so it never reaches the browser. See [§3b](#3b-the-pyramid-generator).
11. **The cell is the world's base unit, and is not assumed square.** World
    coordinates are in cells; the tile's aspect is applied only when mapping to
    the screen, and `BASE_TILE` is the one place the shape is stated. `zoom` is
    pixels per cell width.
12. **The library is round on screen, not round in the index.** Navigation bounds
    should be uniform — the edge the same distance away whichever way you set off
    — which a circle in cell space is not once the cell stops being square. So
    `packages/map` takes the aspect and measures in cell widths. It is the one
    place that module is not shape-blind, and it is a deliberate trade:
    [§5a](#5a-why-the-map-knows-the-cell-shape).
13. **The tile is 1024×768.** 4:3 gives the books room without changing what a
    tile *is*; `BASE_TILE` is the only place the shape is stated and nothing
    downstream assumes it. Whether 4:3 is final is an art call. (It was 1024²;
    see [`design-history.md`](design-history.md#the-tile-1024--1024768).)
14. **Manual curation is dropped.** No scores, no tags, no review tool, no
    SQLite. Boring variants are discarded at generation time, and the three
    retrieval signals cover what tagging was for. Border drift survives as a
    pipeline report because it measures a defect rather than taste. Supersedes
    concept step 3, and the "sort by my scores and tags" control in step 6.
    See [§3 phase 2](#phase-2--curation-concept-step-3--dropped).
15. **Every room carries three stylistic keywords and a short story**, generated
    upstream with the image. Both are search signals and both are readable.
    [§3c](#3c-room-metadata--keywords-and-stories).
16. **Search blends three signals into one sort, rather than tiering them.**
    Keyword above story above CLIP, weights in config, every term normalised to
    [0, 1] — including CLIP, whose raw cosines cluster too tightly on this corpus
    to be blended unnormalised. The whole corpus is sorted by the blend; nothing
    is spliced to the front. [§3d](#3d-hybrid-search--three-signals-one-sort).
17. **Metadata is keyed on filename, embeddings on row order**, and the
    difference is deliberate: a positional blob has to be rejected wholesale when
    it goes stale, a filename-keyed map degrades per room and tolerates a miss.
    [§3c](#3c-room-metadata--keywords-and-stories).
18. **One config surface for what is tuned by feel; the pyramid stays out of it.**
    Zoom range, default zoom, search weights, slot seeds and the demo's default
    generic ratio live in `packages/config`; the ladder, `BASE_TILE`, the budgets
    and the hysteresis band do not — they are derived and asserted, not tuned.
    **Config narrows the zoom range and never widens it**, which is what
    keeps the ladder's reachability assertion true at runtime without consulting
    it at load time. A narrowing that orphans a rung is fine and silent — the
    cost is inactive code and unrequested files. Nothing throws; everything
    adjusted is reported. [§3e](#3e-configuration).
19. **The generic room becomes a small set of alternates**, chosen per cell by a
    seeded hash with the seed in config. They tile by construction, like
    everything else inpainted from the base. Prerequisite: pinning stops being
    unbounded. [§3 phase 3](#alternate-generic-rooms).
20. **Reordering is a sliding-tile illusion: whole lines rotate, and nothing
    crosses anything.** The generic room is a wall, not a gap, so a room may not
    glide over it; a row or column moving as one piece is the only way a room
    travels without the grid ceasing to be a space. Legality is structural —
    rotations anywhere, swaps only off camera. Reverses an earlier cross-fade;
    [§3 phase 3](#the-reorder-animation) and
    [`design-history.md`](design-history.md#rearrangement-cross-fade--sliding-tile-illusion).
21. **The metadata overlay opens on right-click / long-press, not left-click.**
    Left-click is reserved for "focus this room", and the long-press must lose to
    a pan. Per-book hit-testing is impossible on inpainted rooms, so the
    book-pull animation — if it happens — samples a spine rather than identifying
    one. [§5b](#5b-the-metadata-overlay).
22. **Camera moves ease rather than teleport, and zoom eases geometrically.**
    Smoothstep, interrupted by `pointerdown` or the wheel, and stepped on the
    loop the glide already runs, so a flight and the pull back inside the region
    can never overlap. **The duration is `camera.flightMs` in config**, defaulting
    to 450 ms. It belongs in config because it derives from nothing and no test
    pins its value — the rule that keeps things *out* is being derived and
    asserted, not being independent of the corpus. (`WHEEL_ZOOM_RATE`,
    `LONG_PRESS_MS` and `PRESS_SLOP_PX` remain in source only because they predate
    `packages/config`.) [§3 phase 3](#camera-movement),
    [`design-history.md`](design-history.md#flight-duration-source-constant--config).

## 7. Still open

1. **Wiring the base render up as the generic room.** The renders are in the
   repo now — `assets/blender/base_render.png` and the inpainted, tiling
   `assets/base.cell.png`, both 1024×768 — but nothing references either, so the
   demo still falls back to corpus image `000.jpg`. That is the asset the map
   leans on hardest — it is ~80% of every screen.
2. **Corpus hosting.** Settled in principle: a sample stays in the repo
   (`assets/corpus-sample/`, 26 rooms, 2.0 MB), the rest lives elsewhere. The
   server takes `--images <dir>` today; swapping in a bucket later means
   changing `scan.mjs` and nothing else.
3. **Do vertical neighbours mean anything?** With tiles as walls rather than
   rooms, up/down no longer implies a floor above. The grid may be purely
   abstract now, which is simpler and probably fine.
4. **One lamp per tile is four per gallery**, where the story says two. Nobody
   will notice; noting it so it's a choice rather than a slip.
5. **The dark side returns read as heavy columns when tiled.** Two abutting
   tiles put their frames side by side, so the grid reads as separated boxes
   rather than one continuous wall. Faithful to the render; whether it is wanted
   is an art call. Visible in the demo at any zoom.
6. **What the search weights should actually be.** [§3d](#3d-hybrid-search--three-signals-one-sort)
   fixes the ordering — keyword, then story, then CLIP — and the normalisation
   that makes the weights comparable, but the numbers themselves are a by-feel
   call that needs the real corpus and real queries. That is the argument for
   them being config rather than constants.
   The same goes double for `search.density.clipLow/clipHigh`
   ([§3f](#3f-the-search-density-gradient)): unlike the weights those are
   a *measurement* rather than a preference — the cosine at which CLIP starts
   saying something about a wall of books, and the one at which it is as sure as
   it gets. The defaults (0.18–0.30) are read off what ViT-B/32 typically does on
   natural images, narrowed at the bottom because a corpus of near-identical
   library walls sits higher than a corpus of arbitrary photographs. Getting them
   wrong is visible rather than silent, which helps: too low and every query
   clusters, too high and only keyword hits ever do. Worth an afternoon with the
   real corpus, plotting cosine histograms for a handful of queries that should
   match and a handful that should not.
7. **Whether keyword `type` is recorded.** Cheap if the generator already knows
   which of material / movement / technique / artist a keyword came from; it buys
   labelled chips in the overlay and leaves room for weighting an artist match
   differently later. Not worth authoring by hand if it does not.
8. **Whether a rearrangement should be reachable from anywhere but the opening
   zoom.** It parks the camera on the centre at `defaultZoom` and plans against
   exactly those cells, which sidesteps the old cross-fade's zoom problem
   entirely — one level for the whole animation, and a region small enough that
   the working set never approaches a budget. The open question is whether being
   returned home is worth it every time, or whether a search from far out should
   rearrange without the animation. Related: overlapping the runs, which is what
   would make the trip cheap enough not to mind.
   **Partly settled:** the history spines needed the map to *open* framed on the
   bookshelf, which would have flattened the rearrangement if the two shared a
   zoom. So the opening zoom (now derived from the display, `fitZoom`) and the
   return-to-centre zoom (`defaultZoom`, 220) are separate, and the rearrangement
   parks at the wider `defaultZoom` — the wave is intact. What remains open is the
   original question: whether a search from *far out* should rearrange in place
   rather than always being flown home first.
9. **How many generic alternates.** Enough that the wallpaper stops reading as
   one image, few enough that pinning them all at the fallback level stays
   cheap — each is 12 KB decoded at level 4, so the constraint is loose and the
   answer is probably an art call about how much variety reads as *variety*
   rather than as noise.
10. **The side returns, ceiling and cornice are still eyeballed**, and the
   overlay now says so plainly: against the real render the red side-return
   trapezoids converge on the tile's corners while the render's side walls are
   near-vertical bands. It affects the placeholder's looks and nothing else — no
   hit-testing depends on them — but they are the obvious next thing to trace if
   the placeholder is ever meant to pass for the render.
11. **Check the in-tile search field on an actual iOS device.** Its font size
   is whatever `.centre-search input` inherits (13px, the app's body size),
   well under the ~16px that keeps iOS Safari from auto-zooming the viewport
   on focus. The page's `maximum-scale=1, user-scalable=no` viewport meta
   likely suppresses that already, but it was never verified against this
   field specifically, and a real device is the only way to know — same
   caveat as every other touch behaviour in this doc.

---

## 8. Next session

Already landed and folded into the phase sections: configuration
([§3e](#3e-configuration)), room metadata end to end
([§3c](#3c-room-metadata--keywords-and-stories)), hybrid ranking
([§3d](#3d-hybrid-search--three-signals-one-sort)), the metadata overlay
([§5b](#5b-the-metadata-overlay)), animated camera moves
([§camera movement](#camera-movement)), the reorder animation
([§the reorder animation](#the-reorder-animation)), the base tile with its
wallpaper variants ([§3 phase 3](#alternate-generic-rooms)) and the centre
room's history spines ([§phase 5](#the-history-spines--landed)) — the first
control bound to the tile geometry. The opening view now frames itself on the
bookshelf (derived from the display, not a config number), and manual zoom
reaches 2x the tile's native width so a spine can be enlarged past 1:1 to read.

The queue, in dependency order — shortest path to a demo that survives a real
corpus:

1. **Give the base variants a resolution pyramid.** They are served flat (level 0
   only) and drawn full-res at every zoom, which is bounded — the cache keys on id,
   so a far-out screen holds only the handful of distinct base images — but it is
   the wrong *shape* on the wire: a variant is a 1024×768 download where the pinned
   generic used to be 12 KB. Running `generate:mips` over `base_variations/` and
   `base.tile.png`, then teaching `rooms.js` a base level ladder rather than "level
   0 only", is the fix. Until then, `main.jsx` pins each base id at level 0, which
   is a real budget question the moment there are many variants: N pinned level-0
   entries against a budget of 240.
2. **Re-check the budgets against a real corpus at level 0.** The ladder's
   worst-case table is computed for each level's own zoom band; what is not yet
   measured is a long session wandering at high zoom, where level 0's budget of
   240 is doing the "hold rather than refetch" work on its own.
3. **Make the centre-room spine titles legible (typography). Partly settled.**
   Raising the zoom cap to 2x native helped the physical size, but composited
   text on story-accurate spines was still a handful of illegible pixels — so
   the centre tile itself was redrawn with fewer, wider books (see the "Update"
   under [§phase 5](#the-history-spines--landed)), which is the bigger lever the
   options below were compensating for the lack of. Still open: the gilt fights
   the painted spine tone at small sizes, and font choice was explored with
   `tools/font-lab/` but is not yet reflected in the shipped composite. Options
   to weigh: a hover/near-cursor state that enlarges the book under the pointer;
   a tooltip or floating label for the hovered spine; a heavier plate or gilt
   band behind the text. Distinct from the base-tile *art* being upscaled
   (item 4) — the composited text is canvas `fillText`, resolution-independent
   and already crisp.
4. **An ultra-res LOD rung for the centre tile (crisp zoom past 1:1).** The base
   tiles are served flat at native width, so zooming a reader past 1x (up to the
   new 2x cap) upscales the flat art and it softens — the composited spine text
   stays sharp, but the shelf *behind* it blurs. The fix is a finer-than-level-0
   rung for the centre tile specifically: a pre-generated high-res render swapped
   in by semantic zoom as the reader comes in past 1:1. **Pre-generated, not
   dynamic upscaling** — a static asset the pyramid selects, the same LOD
   machinery as item 1 but pointing *up* the resolution ladder rather than down.
   Lands naturally alongside item 1 (base assets earn a pyramid); the opening cap
   at native width in `main.jsx` can then rise. Cosmetic backdrop polish — gate on
   whether the blur past 1x actually bothers a reader before investing.
5. **Accessibility: a keyboard interface and an accessible reading of the map.**
   **Every phase has landed — see [`accessibility-plan.md`](accessibility-plan.md).**
   The map has a real keyboard interface: a cursor at the cell under the
   camera centre, arrow keys that pan it, ctrl+arrow that jumps room to room,
   Enter/Escape/Home/PgUp/PgDn/`/`/`?`, a live region that announces moves, and
   a visible ring once a key has been pressed. Keyboard moves ease rather than
   snap (`camera.keyboardMoveMs`), are damped by the same pan resistance a drag
   feels so a held key cannot outrun what a hand can reach, and land
   cell-centred in bounds so a trip past the boundary cannot leave the map
   permanently off-grid. The centre room's forty book spines are real buttons
   (one tab stop, arrows within), a rearrangement says what it did and what is
   now under the cursor, and a room may carry an optional `alt` caption from
   the sidecar.

   **Not to be read as finished.** Nobody has run any of it against a real
   screen reader — the plan's stated top risk, unchanged, and now carrying the
   whole cursor model, the `role="application"` commitment and the shelf's
   roving toolbar on top of it. Two smaller things stay open in that document's
   §8: what the far-out announcement should actually say, and how far
   ctrl+arrow should look before giving up. The wallpaper variants still have
   no descriptions of their own, deliberately — the art is placeholder meant to
   be swapped for real inpainting output.

   What it settled going in, in short:

   - It is **not** a parallel interface. One DOM tree with two orderings over it
     — the map's cursor and a ranked listbox — sharing the handlers and the
     naming module, so there is no second view to keep in sync.
   - **There is no DOM grid at all — the map is a cursor, not a mirror.** A
     browsable DOM grid needs the screen reader in browse mode; arrow keys that
     pan need focus mode. No node budget buys both, so a single cursor at the
     cell under the camera centre replaces the mirror — about 110 nodes against
     ~33,000 for the board. Arrows pan, the cursor rides along and is announced,
     and ctrl+arrow jumps to the next room the way ctrl+arrow jumps a word.
   - **The ranked listbox ships first, and has.** `describeCell` (in
     `packages/map`) names both the search results list and the room card; the
     list is a plain `<ul>` of buttons, not `role="listbox"` — arrow-key roving
     needs the keyboard model phase C brings, and a listbox without it is a
     broken widget. It is the half that works with no arrow keys at all —
     every touch device, every VoiceOver user — and it needs no
     `role="application"` commitment, so it can be lived with before anything
     riskier is built on it. Whether that role survives contact with a real
     screen reader is the plan's stated highest-risk assumption.
   - **Alt text is not generated at runtime.** Every described room already
     carries keywords and a story; a short description is an optional `alt` in
     the sidecar, captioned once offline with the room's own story passed in as
     context so the two accounts cannot diverge.
   - **A dense/linear view is deferred as its own subproject** — a real toggle
     for everyone rather than an accessibility path. Worth knowing before anyone
     builds it: a wallpaper-free map is already `contentRatio: 1`, a runtime
     parameter rather than a second layout. **That subproject now has a plan of
     its own — [`catalog-plan.md`](catalog-plan.md), item 6 below.**

   Phase A of that plan is a set of existing conformance bugs — page zoom
   disabled by the viewport meta, a card unreachable by keyboard and unmanaged
   once open, reduced motion honoured for the camera flight but not for the
   rearrangement — each small and isolated. (The unlabelled panel sliders are
   already fixed; they are becoming a dev-only control, so that was tidiness
   rather than an investment.) Consult `docs/design-history.md` before
   re-treading the "it's all one canvas" decision, or the alternatives that plan
   rejected.

6. **The catalog — the map's other reading.** Planned in
   [`catalog-plan.md`](catalog-plan.md); nothing built yet. The same corpus as
   one scrolling list in search order, every tile unique, story and tags beside
   each row, and the full score breakdown under each one while a search is
   running — on a toggle the reader controls, so they decide how much they care
   to explore against how much they care to query.

   Not a dependency of anything above, and it does not block them. It sits here
   because it is the first feature since the pyramid to touch more than one
   package: a `describeRoom` primitive under `describeCell`, per-signal
   components out of `rankHybrid` (which is what makes the score breakdown
   possible at all, and what finally makes the *certainty is absolute, ranking
   is relative* rule visible to a reader rather than only written down), and a
   preparatory extraction of `MapView` out of a `main.jsx` that is 1581 lines.

   Two things the plan settles that are worth knowing without reading it. **The
   map is never unmounted** — catalog mode hides it and stops its render loop,
   so the camera, the tile cache and the pyramid's LRU are exactly as they were
   left, which is what dissolves design-history's "modes carry state, and state
   desyncs" objection structurally rather than by discipline. And **this is not
   the accessibility mode**: nothing detects a screen reader, nothing defaults
   into it, the panel's ranked listbox stays where it is, and
   `role="application"` stays scoped to the canvas. `accessibility-plan.md`
   §3.7 rejected a linear list as an accommodation and left it open as a control
   for everyone; that distinction is the plan's §7 and is not negotiable.
