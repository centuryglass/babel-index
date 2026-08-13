# The Indexing of Babel — implementation plan

A sketch of how to get from [`concept.md`](../concept.md) to a working thing.
Revised after the first round of review; the decisions that were open are now
recorded in [§6](#6-decisions-made).

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
| `tools/base-image/` | tile geometry, SVG importer, placeholder, overlay |
| `assets/blender/babel_shelf.blend` | the base render source |
| `assets/corpus-sample/` | 26 rooms + a generic, so the demo needs no setup |
| `docs/borges-parameters.md` | the story's numbers, with sources |

### The demo

```sh
npm install && npm run demo        # http://localhost:5173
npm run demo -- --images <dir>     # against a full corpus
```

A directory of images is the entire data layer. Corpus size and generic ratio
are sliders, not settings. Search is stubbed (a deterministic pseudo-ranking) so
the reorder mechanic works without a model, and the UI says so.

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

Still eyeballed, and affecting the placeholder's appearance only: the side
returns, the ceiling strip and the cornice.

#### Changing the geometry

The proportions have moved once already — the tile went 1024² → 1024×768 to
uncramp the shelf — and may move again. The trace is the interface, so a change
is a three-step loop and touches no code:

```sh
# 1. adjust the render in Blender, re-trace in Inkscape
# 2. re-import
node tools/base-image/import-shelf-svg.mjs tools/base-image/shelf_geometry.svg
# 3. check it against a real image
npm run generate:tile -- --base <new-render.png>
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

### Phase 1 — variant generation *(concept step 2)* — **you have this working**

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

### Phase 2 — curation *(concept step 3)*

Local-only, keyboard-driven: `1`–`5` to score, free-text tags, `x` to reject.
Writes to SQLite.

Add two automatic sort keys so review time goes where it matters:

- **Border drift** (mean + peak deviation from the corpus mean frame). Not a
  gate — a sort key, so the handful of frame-breakers surface first instead of
  being found by accident on the map.
- **Perceptual-hash clusters**, so near-duplicates are reviewed once.

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

##### What the thrashing actually looked like, and the half of it now fixed

Found by panning at full zoom-out against a large corpus: rooms that were
already on screen blinked out and came back as new tiles loaded. Measured by
replaying the render loop headlessly against the real layout and the real cache
— at `MIN_ZOOM` on a 1600×900 viewport a screen holds ~3100 cells wanting **~800
distinct room images against a budget of 240**, and a brisk pan was evicting and
refetching **~90 tiles per frame that had never left the viewport**.

Two separate faults, and only one of them is the budget:

- **The cache is smaller than a screen.** Unfixable without the pyramid: 800
  full-resolution rooms is 2.4 GB decoded. This is the ceiling described above,
  and it is what the ladder exists to lower.
- **Eviction picked the wrong victims.** The renderer walks cells row by row, so
  within a frame the tiles it has *already drawn* are the least recently used
  entries in the cache. A miss half way down the screen evicted the rows above
  it. That is a plain bug, independent of the budget, and it is what turned "the
  cache is too small" into "tiles flicker".

`tiles.js` now stamps each entry with the frame it was drawn in and refuses to
evict anything touched by the current frame or the one before it — the previous
frame included because a pan moves the viewport by a cell or two, so last
frame's working set is very nearly this frame's. Refetches went to **zero**, and
peak cache size barely moved (815 → 804 entries), because the old code was
already blowing through its budget by skipping in-flight entries; it was just
doing so while also thrashing. When a screen genuinely does not fit, the cache
now holds it and `overBudget()` reports the overage in the HUD rather than
pretending.

Rule 1's third layer landed with it: a cell whose room has not arrived draws the
**pinned generic room** instead of the flat `#15120f`, so a miss is a wall
rather than a hole. At the zooms where this happens a cell is ~26px wide and the
substitution is invisible; the hole was not.

None of this makes the pyramid unnecessary. It makes the map usable at
zoom-out today, and it removes a bug that would still have been there afterwards
— per-level budgets would not have saved a frame from evicting its own rows.

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
tile actually covers. Picking on CSS pixels ships half-resolution art to every
retina display. The chosen level is the smallest tile not smaller than the
demand, so a tile is never upscaled while a big enough one is available.

Two corrections to the earlier draft of this table, both caught by writing the
selection down as testable code:

- It keyed on raw `zoom`, not device pixels — the retina bug above.
- Its bottom level was used at "zoom < 24", but
  [`camera.js`](../packages/web/src/camera.js) clamps `MIN_ZOOM = 26`, so that
  level could never be selected at all. A level nothing can reach is dead weight
  in the pipeline and a lie in the table, so `pyramid.test.mjs` now asserts that
  every level is reachable by some zoom within the camera's own clamp. That test
  couples the ladder to `MIN_ZOOM`/`MAX_ZOOM`: change the clamp and it will tell
  you the ladder needs a rung added or dropped.

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
  16 KB buys a last-resort fill for any cell whose own room has nothing yet, so
  the floor is a real image rather than the flat `#15120f` the renderer paints
  today.
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

##### How it is wired, end to end — **done**

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
- Bandwidth follows the same curve: the far-out view costs ~16 KB per room
  instead of ~50 KB, which matters more than the decode ceiling once this is
  hosted.

#### Camera movement

"Centre" teleports today, which loses the reader's sense of where they were.
Camera moves should animate: ease position and zoom together over ~450 ms,
interruptible the moment a drag starts, so a mid-flight grab takes over instead
of fighting. The same helper serves "fly to the best match" after a search,
which is the case where the movement is carrying meaning — it shows the top
result's location relative to where you were standing.

### Phase 4 — search *(concept step 5)*

The CLIP backend is mostly not a cost question, because the expensive half
precomputes:

- **Image embeddings computed offline**, shipped as one blob. 5,000 rooms × 512
  dims × int8 = **2.5 MB**.
- **Ranking runs in the browser** — `rankByEmbedding()` in `packages/map`. A few
  million multiply-adds, well under a frame.
- **Only the text tower runs at request time.** A tiny stateless endpoint, or
  `transformers.js` in-browser if the model download is acceptable.

No CLIP service to pay for in steady state.

### Phase 5 — the controls in the centre room *(concept step 6)*

Bind to the anchors in `tile-geometry.json`: `searchField`, `submitButton`,
`historySpines`, `scoreSortSpines`, `shuffleSpine`. Transparent hit regions
positioned by the same transform that draws the centre tile, with the visible
affordance painted into the art.

Search-term spines need text composited onto spine rectangles at runtime — a
small canvas overlay per spine.

### Phase 6 — generate-on-demand *(stretch)*

Selectively enabled for short periods, so it needs a kill switch and a queue but
not autoscaling. Keep it behind a flag.

---

## 3a. Testing

165 tests (`npm test`), in a couple of seconds, with no browser and no network.
`node --test` discovers `*.test.mjs` on its own, so a new file needs no wiring.

| | |
| --- | --- |
| `packages/map/ordering.test.mjs` | slot placement, stability under re-ranking, resistance, roundness at any cell shape |
| `packages/server/scan.test.mjs` | header parsers, directory rules |
| `packages/server/app.test.mjs` | the four endpoints, against a live socket |
| `packages/web/src/camera.test.mjs` | the pan/zoom invariants |
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
pan, zoom, both sliders, a search, and a check that nothing reached the console.
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

Each of those was checked by breaking the app on purpose and confirming the
test failed: no `drawImage`, a discarded search order, an ignored
`contentRatio`, and a stray `console.error`. A green e2e test that cannot fail
is worse than none, because it is believed.

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

## 4. Architecture

```
babel-index/
  tools/base-image/        # tile geometry, placeholder, overlay      [exists]
  packages/map/            # slot placement, ranking, resistance      [exists]
  assets/base-tile/        # generated geometry + placeholder         [exists]
  docs/                                                              [exists]
  packages/
    pipeline/              # mips [exists]; dedup, embed, border-drift score
    curate/                # local-only review tool
    server/                # Express: manifest, text-embed, generate queue
    web/                   # React: map, search, centre-room controls
```

**Data**: SQLite through the pipeline and curation phases — one file, no
service, trivially backed up. The web app never talks to it; it consumes a
static `manifest.json` plus `embeddings.bin`.

```
room: id, path, w, h, seed, prompt, model, controlnet, created_at,
      phash, score (0-5), tags[], status (pending|kept|rejected),
      embedding (blob), border_drift (mean, peak)
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

## 6. Decisions made

Recorded from review, with what changed:

1. **Tile = one shelved wall, shallow perspective.** The unrolled-hexagon
   elevation is gone, along with the straddle-band and corner machinery it
   needed. Faithful 3D Library reconstructions already exist; this isn't that.
2. **The Blender render is the source of truth.** Built; needs to land in the
   repo.
3. **Seam accuracy is not enforced.** Inpainting from a shared base with an
   edge-clear mask makes it structural. `verify-seams` and the seam-mask assets
   are deleted. Border drift survives only as a curation sort key.
4. **No canonical inpainting mask in the repo.** Masks are a pipeline concern
   and will change between runs; encoding one would freeze a false constraint.
5. **Synthetic corpus: done** — 512 images, SD inference is cheap enough that
   the placeholder-driven bootstrap was unnecessary.
6. **Corpus size and generic ratio are runtime-tweakable.** Implemented and
   tested in `packages/map`.
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
13. **The tile is 1024×768.** The square shelf felt cramped, which was the last
    entry in §7; 4:3 gives the books room without changing what a tile *is*. The
    render, the trace and `BASE_TILE` moved together, and the only knock-on in
    code was the coarsest cache budget — a shorter tile fits more rows, so the
    worst-case screen went 5700 → 7500 cells and the budget 7000 → 8200. Whether
    4:3 is final is an art call; nothing downstream assumes it.

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
6. **The side returns, ceiling and cornice are still eyeballed**, and the
   overlay now says so plainly: against the real render the red side-return
   trapezoids converge on the tile's corners while the render's side walls are
   near-vertical bands. It affects the placeholder's looks and nothing else — no
   hit-testing depends on them — but they are the obvious next thing to trace if
   the placeholder is ever meant to pass for the render.

---

## 8. Next session

In dependency order, shortest path to a demo that survives a real corpus:

1. **Animated camera moves.** The maths is extracted and tested now, so this is
   an easing function over `camera.js` plus an interruptible rAF loop in the
   hook; `flyTo` is the seam.
2. **Serve `assets/base.cell.png` as the generic room**, replacing `000.jpg`.
   The asset is in the repo and is the right shape; what is missing is a way for
   the demo to reach a base image that lives outside `--images <dir>`, since
   `scan.mjs` only looks for `base.*` inside the corpus directory.
3. **Give the pinned generic its own budget.** It is pinned at every level it is
   asked for, which is correct and currently free — it is one room. If anything
   else ever gets pinned, pinning needs to stop being unbounded.
4. **Re-check the budgets against a real corpus at level 0.** The ladder's
   worst-case table is computed for each level's own zoom band; what is not yet
   measured is a long session wandering at high zoom, where level 0's budget of
   240 is doing the "hold rather than refetch" work on its own.
