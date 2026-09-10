# Performance research

A read-through of the render path looking for non-trivial performance wins, with
the dropped frames during the rearrangement's zoom-out and slide as the
motivating case.

**Status: §1-§7 are hypotheses; §9 is measured.** §1-§7 come from reading the
code and computing what each cost must be, not from a profile — several are
arithmetic certainties (a 48 MB decode is a 48 MB decode), others educated
guesses whose magnitude depends on the machine. §2 is the instrumentation
(`packages/web/src/lib/perfProbe.ts`) that ranks them for real, and §9 is its
output across four browser/device captures. Read §9 before trusting §8's
ranking; it reprioritizes in a couple of places.

Numbers assume the current corpus (~2048 rooms), `BASE_TILE` 1024x768, and the
`LEVELS` ladder in `packages/web/src/lib/pyramid.ts`. Most of this was measured
while `SHEETS` still packed levels 2-5; level 2 has since moved back to
per-file (§6), so any number below quoting a level-2 sheet is describing a
mechanism that no longer exists at that level.

---

## 1. What actually happens during the two animations

This matters more than it looks, because it rules out a whole family of
plausible-sounding culprits.

A rearrangement has two phases:

1. **The zoom-out flight.** `startRearrangement`
   (`packages/web/src/hooks/useRearrangement.ts:144-177`) eases the camera to
   `min(currentZoom, overviewZoom(canvas, config.camera.minVisibleCells, cam))`.
   `minVisibleCells` is **5** (`packages/config/config.ts:161`), and
   `overviewZoom` passes it to `fitZoom` as a 5x5 cell target
   (`packages/web/src/lib/camera.ts`). During this phase the ordinary renderer
   draws the *old* arrangement from the live, interpolating camera.
2. **The slide.** The camera is parked; `slide.ts` draws a finite board every
   frame at one fixed level.

A *cell* here is one grid square of the map — the slot that holds exactly one
tile, whether that is a corpus room, a generic wallpaper tile, or the center
room. It is the world's base unit, and it is **not square**: `zoom` is pixels
per cell *width* and `pxPerCell` derives the height as `zoom * CELL_ASPECT`
(0.75, from `BASE_TILE`'s 4:3).

`minVisibleCells: 5` is easy to misread — it fits 5 cells on the **binding**
axis (whichever runs out first), not 5 cells in total. The other axis shows
more, and which axis binds flips with the viewport's shape. Running the real
`overviewZoom` and `render.ts`'s own bounds arithmetic:

| viewport | zoom | cell px | grid | cells |
|----------|------|---------|------|-------|
| 1920x1080 desktop | 288 | 288x216 | 8x6 | 48 |
| 2560x1440 desktop | 384 | 384x288 | 8x6 | 48 |
| 1440x900 laptop | 240 | 240x180 | 8x6 | 48 |
| 844x390 phone landscape | 104 | 104x78 | 10x6 | 60 |
| **390x844 phone portrait** | 78 | 78x59 | **6x16** | **96** |

So: **roughly 50 cells on a desktop, and about 96 on a portrait phone** — the
binding axis there is width, so the tall viewport fills with rows and the phone
draws *twice* the cells a desktop does. That inverts the usual assumption that
the small screen is doing less work, and it puts the highest cell count on the
weakest hardware.

The consequence, with that correction in hand: the cell count during a
rearrangement is **two orders of magnitude below** the ~7500-cell worst case the
pyramid's budgets are sized against, but it is not trivially small either,
particularly on a phone.

So per-cell costs — the allocation churn in `roomAt`, `locateTile`, the
favorite badge, generic tiles drawn at full resolution — are unlikely to be the
*dominant* term during a rearrangement, and they dominate a different scenario
(a reader manually zooming or panning far out), which is why they are filed
separately in §4. But at ~96 cells with roughly a dozen allocations each, that
is still on the order of a thousand allocations per frame plus ~96 `locateTile`
chains, on phone-class hardware. Secondary, not negligible — and §4's items get
*more* attractive, not less, once you notice the phone is the worst case for
both cell count and CPU.

What is left, and what scales with frame count rather than cell count:

- whatever the frame does per *level transition* (§3.1),
- whatever the frame does per *frame* regardless of content (§3.2, §3.3),
- how many times per frame the app decides to draw at all (§3.4),
- how many destination pixels get filled (§3.5, §3.6).

That is the shape of the problem, and §3 is ordered by how strongly each
candidate fits it.

---

## 2. Measure first

Ranked by what would most change the plan below.

**2.1 — Which phase drops frames.** Wrap the two draw calls in
`useMapRenderer.ts:333` with `performance.now()` deltas and record them into a
ring buffer alongside `running?.board ? 'slide' : 'flight'`. Dump percentiles at
the end of the animation. If the flight is clean and the slide is not (or vice
versa) that alone eliminates half of §3.

**2.2 — Long tasks and their attribution.** A `PerformanceObserver` on
`longtask` plus `event` timing, logged with the animation phase. If drops
correlate with `longtask` entries that have no script attribution, that points
at decode/upload or GC rather than at our own JS.

**2.3 — Whether it is the sheets.** Instrument `requestSheet`
(`packages/web/src/lib/tiles.ts:408`) with the url, the level, and the
wall-clock gap between `img.src = url` and `onload`, then a second timestamp on
the first frame that actually draws from it. A frame drop landing on that first
draw is the GPU-upload hypothesis (§3.1) confirmed. This is the single highest
value measurement here.

**2.4 — Whether it is the spines.** Comment out the `composeSpines` call
(`render.ts:320-323`) and re-run the flight. If the drops vanish, §3.2 is the
answer and it is cheap to fix properly.

**2.5 — Forced layout.** Chrome DevTools' performance panel flags "Forced
reflow" directly, and §3.3 predicts one per frame, every frame. This one is
verifiable in about thirty seconds and does not need instrumentation.

**2.6 — Fill rate.** Run the same animation with the canvas backing store
forced to `dpr = 1`. If drops vanish on a retina display, the bottleneck is
pixels, not logic, and §3.5 becomes the top item.

A caution the repo already documents (`AGENTS.md`, "Testing and CI"): two reads
separated by a slow call can describe two different renders. Any harness added
for the above should record raw samples and aggregate afterwards rather than
asserting on a single reading.

---

## 3. Candidates that fit the rearrangement's actual shape

### 3.1 Sheet decode and first-draw GPU upload at level transitions

**What it is.** Crossing a pyramid level boundary mid-zoom triggers a fetch and
decode of that level's sheet, and the first `drawImage` from the resulting
`ImageBitmap` forces a GPU texture upload. The sheets are enormous.

**How it works.** `render.ts:237` recomputes `pickLevel` every frame from the
live camera. Because the flight's zoom changes continuously, the demand width
sweeps across the ladder's thresholds and each crossing asks the cache for a
level it has not got, which lands in `requestSheet` (`tiles.ts:408`). Measured
from `assets/corpus-sample`:

| level | sheet dimensions | encoded | decoded RGBA |
|-------|------------------|---------|--------------|
| 2 | 4096x3072 | 299 KB | **48.0 MB** |
| 3 | 2048x1536 | 84 KB | 12.0 MB |
| 4 | 1024x768 | 25 KB | 3.0 MB |
| 5 | 512x384 | 7 KB | 0.8 MB |

`tiles.ts` already moved decoding off the render thread (`decodeInWorker`,
`tiles.ts:251-298`) precisely because of this — its own docblock records ~1.5 s
of main-thread decode in a zoom capture. But decoding off-thread does not move
the **upload**. `createImageBitmap` produces a bitmap in memory; the driver
allocates and uploads the texture on first use, synchronously, on the thread
that calls `drawImage`. A 4096x3072 texture is ~48 MB across the bus, and
4096 is at or near the maximum texture dimension on a good deal of integrated
and mobile hardware, where the 2D canvas backend may tile or fall back rather
than take it in one piece.

**Significance — narrower than it looks, and which levels the rearrangement
actually reaches is what narrows it.** Running the real `openingZoom`,
`overviewZoom` and `idealLevel` over the flight's geometric zoom sweep:

| viewport | opening | overview | levels traversed |
|----------|---------|----------|------------------|
| 1920x1080 @1x | L0 (zoom 1024) | L1 (zoom 288) | 0, 1 |
| 1920x1080 @2x | L0 | L0 (zoom 288) | **0 only** |
| 2560x1440 @2x | L0 | L0 (zoom 384) | **0 only** |
| 390x844 phone @2x | L0 (zoom 421) | L2 (zoom 78) | 0, 1, 2 |

Levels 0 and 1 are **per-file, not sheet-packed** (`SHEETS.fromLevel` is 2). So
on a retina desktop the rearrangement never leaves level 0 — there is no level
transition at all, and no sheet is touched at any point. On a non-retina desktop
it crosses only into level 1, also per-file. **A sheet is reached only on a
phone.**

This kills the sheet hypothesis for desktop outright, and it points at a
different and better one. At overview zoom on a desktop, every visible cell is
drawing a **full-resolution 1024x768 tile — 3 MB decoded each, one HTTP request
each**. A search-triggered rearrangement is precisely the case where the rooms
sliding in were not previously on camera (the new `order` puts different ids
there), so the animation is fetching, decoding and uploading on the order of
48 brand-new full-resolution room images *while it runs*. Same mechanism as
this section describes — decode plus first-draw upload — but at level 0 and
per-file, not at level 2 and packed.

That reframes the fix. Preloading sheets does nothing for a desktop
rearrangement. What would help is warming the level-0 tiles for the incoming
arrangement *before* the slide starts: the new `order` is known at
`startRearrangement` time, and the zoom-out flight is several hundred
milliseconds of otherwise idle network. `slide.ts:513-516` already prefetches a
2-cell ring, but only once the slide is underway and only at the level it is
drawing.

**Trade-offs and options.**

- *Eagerly load all sheets at startup.* At 2048 rooms that is `ceil(2048/256) =
  8` sheets per level across four sheet levels — 32 sheets, ~510 MB decoded,
  ~22 MB encoded. Note that `SHEETS.cacheBudget` is **64**
  (`pyramid.ts:253`), so 32 sheets never trip `evictSheets`
  (`tiles.ts:612-624`) — sheets already accumulate and are never evicted at this
  corpus size. Preloading therefore does not change the memory ceiling a
  thorough browsing session already reaches; it front-loads it. The change is
  small: request each distinct sheet url at startup rather than waiting for a
  camera position to ask. Cost is ~22 MB of startup bandwidth and ~510 MB of
  resident memory from the first second, which is comfortable on desktop and
  much less so on a phone.
- *Force the upload off the critical path.* Preloading alone does not prevent
  the first-draw upload stall; it only moves *when* the decode happens. Pair it
  with a one-pixel `drawImage` of each freshly decoded sheet into a scratch
  canvas at load time, so the texture is resident before any animation needs it.
  Unverified across browsers — worth testing, since some drivers may not retain
  the upload.
- *Unpack the finest sheet level back to per-file.* The strongest option, and
  it gets its own treatment in §7 — the packing economics invert across the
  ladder and level 2 is on the wrong side of the crossover.
- *Skip intermediate levels during a flight.* The flight knows its destination
  zoom before it starts. It could pin the level to the destination's for the
  whole flight (drawing a coarser-than-ideal or finer-than-ideal field during
  the transit, which is what `bestAvailable`'s substitution already does
  gracefully) rather than sweeping the ladder and paying every threshold on the
  way. This is arguably the cheapest real fix: it eliminates the transitions
  instead of making them faster. Trade-off is a visibly soft or overly sharp
  field for the ~400 ms of the flight, and it needs `render.ts`'s `level`
  closure to accept an override without breaking the hysteresis it exists for.

### 3.2 The center shelf refits every spine's font on every frame

**What it is.** `composeSpines` (`center.ts:683-761`) re-derives the font size
and the truncated string for all `BOOK_COUNT` spines every frame, using
`measureText`, even though the titles have not changed and only the scale has.

**How it works.** Per book, per frame:

- `fitFontSize` (`center.ts:770-793`) binary-searches the size range, assigning
  `ctx.font` and calling `measureText` on each iteration — about 6 of each for a
  typical range.
- `fitText` (`center.ts:796-801`) then shrinks the string one character at a
  time, calling `measureText` per character, for any title that does not fit.
- `bookScreenRects` (`center.ts`) allocates a fresh array of `BOOK_COUNT` rect
  objects.
- Each spine gets `save`/`translate`/`rotate`/`strokeText`/`fillText`/`restore`.

`ctx.font =` is not a field assignment; it parses a CSS font shorthand and
re-resolves the font. Assigning it several hundred times per frame and calling
`measureText` at least as often is a well-known way to lose a frame budget.

**Significance.** High *for the zoom-out flight specifically*, which is the
phase least explained by anything else. The flight **starts at the opening
view, which is framed on the shelf** — so spines are legible, and this runs at
full cost, for the opening stretch of every rearrangement. It stops when
`areSpinesLegible` goes false (`center.ts:296-298`, `MIN_SPINE_PX = 5`), i.e.
partway through the zoom out. That is a cost profile that turns itself off
mid-animation, which would look exactly like "the first half of the zoom stutters
and then it smooths out."

**Trade-offs.** Memoizing on `(text, quantized spine width)` is
straightforward and low-risk; the cache is bounded by `BOOK_COUNT` entries and
invalidates naturally when titles change. Two caveats: web fonts finishing
loading after the first fit would leave stale sizes (listen on
`document.fonts.ready` and clear), and quantizing width means the font size
steps rather than scaling continuously during a zoom — visually a non-issue at
integer font sizes, which is what `fitFontSize` already returns. A more
aggressive version renders the whole shelf to an offscreen canvas and blits it,
which also removes the per-frame `rotate`/`strokeText` work, at the cost of a
re-render whenever the scale changes enough to matter.

### 3.3 A forced synchronous layout on every frame

**What it is.** The render function writes inline styles to up to four DOM
elements and then, in the same callback, reads `getBoundingClientRect()` twice.
That is the textbook write-then-read layout thrash, and it happens every frame.

**How it works.** `useMapRenderer.ts:230-278` assigns
`style.display/left/top/width/height` on `searchEl`, `booksEl`, `bookEl` and
`controlsEl`, invalidating layout. Then `useMapRenderer.ts:289-290`:

```
const badge = arrowEl.getBoundingClientRect();
const root = canvas.getBoundingClientRect();
```

Reading either one forces the browser to flush the style and layout work the
writes just queued, synchronously, before the frame's canvas drawing has even
started. `SearchOrbitArrow` is unconditionally rendered
(`MapView.tsx:461`), so `arrowEl` is never null and this is never skipped.

**Significance.** Medium to high, and — unlike most items here — completely
independent of cell count, zoom, and phase. It is a fixed tax on every frame
the map ever draws. Whether it costs 0.2 ms or 4 ms depends on how much of the
page's layout is dirty, which is why §2.5 is worth doing before §3.1.

**Trade-offs.** Almost none. The canvas rect and the badge rect change only on
resize, scroll, or a CSS/layout change — cache both, refresh them from a
`ResizeObserver` on the canvas plus the existing resize listener. The only
subtlety is that the badge's position depends on CSS that could change without
a resize event; a `ResizeObserver` on the badge itself covers that. Also worth
folding in: `document.getElementById('hud')` runs every frame
(`useMapRenderer.ts:335`) and can be hoisted into the effect — the HUD only
exists under `?debug` (`MapView.tsx:611`), so this is a lookup that returns
null 60 times a second in production.

### 3.4 Three independent rAF loops, and a one-frame lag

**What it is.** During a rearrangement, up to three requestAnimationFrame loops
run concurrently, and the one that moves the camera schedules the draw rather
than performing it.

**How it works.**

- `useMapCamera.ts:613-639` runs a permanent loop stepping flights and glides,
  calling `onChange` (which is `requestDraw`).
- `useRearrangement.ts:205-225` runs the slideshow's own `tick`, also calling
  `requestDraw`.
- `useDistillMode.ts` runs a third for the generic fade.

`requestDraw` sets `pending = requestAnimationFrame(render)`
(`useMapRenderer.ts:368-371`). Called from *inside* a rAF callback, that
schedules `render` for the **following** frame. So the camera advances in frame
N and the map is painted for that position in frame N+1. It is consistent
rather than jittery, so it reads as latency rather than as dropped frames, but
it also means the real per-frame work is spread across two callbacks with
scheduling in between.

**Significance.** Medium. This is more likely to be felt as softness or lag than
as a dropped frame, and consolidating it is a genuine refactor rather than a
tweak. Worth knowing about before attributing a measurement to something else.

**Trade-offs.** One driver loop that steps every animator and then draws once,
in order, would remove the lag and the redundant scheduling. But the current
separation is a deliberate architectural property — each subsystem owns its own
motion and `useMapRenderer` deliberately does not own the frame request (its
docblock explains why: the tile cache is constructed with `onLoad: requestDraw`
and would otherwise have to exist before the thing it depends on). Consolidating
means threading a scheduler through all of it. Also note the always-on loop
never idles: it runs 60 times a second forever, including in catalog mode,
and calls `matchMedia('(prefers-reduced-motion: reduce)')` on **every tick**
(`useMapCamera.ts:627`, via `prefersReducedMotion`). Hoisting that
`MediaQueryList` and listening for changes is free and strictly better; gating
the loop on "is anything actually moving" is a small win in CPU and battery
with a small risk of missing a wake-up.

### 3.5 Device pixel ratio during motion

**What it is.** The canvas backing store is sized at `min(2, devicePixelRatio)`
(`useMapRenderer.ts:212`) at all times. On a retina display that is 4x the
pixels of a `dpr = 1` frame.

**How it works.** At 2560x1440 css pixels and dpr 2, every frame clears and
fills 5120x2880 = **14.7 M pixels**. Dropping to dpr 1 during motion cuts that
to 3.7 M. Because the tiles being drawn are also being scaled, the per-pixel
cost is a filtered sample, not a copy — `SMOOTHING_MAX_DOWNSCALE`
(`render.ts:103`) already exists to turn bilinear filtering off once the
downscale is hard enough, which is real evidence that fill cost has been the
bottleneck before.

**Significance.** Potentially high, and it targets exactly the moments that
drop frames rather than the steady state. Motion is also when reduced resolution
is least perceptible.

**Trade-offs.** Changing `canvas.width`/`height` reallocates the backing store,
which is itself not free and can flash if mistimed — it must happen once at the
start of the animation and once at the end, never per frame. The transition
back to full resolution on settle is visible if the animation ends abruptly. And
it interacts with the smoothing gate: a lower dpr lowers the demand width, which
changes `pickLevel`'s answer, which could trigger exactly the level transition
§3.1 is trying to avoid. These two want designing together, not separately.

### 3.6 The full-screen clear is redundant overdraw

**What it is.** Both renderers begin with a full-viewport `fillRect`
(`render.ts:220-221`, `slide.ts:415-416`), then draw cells that cover the entire
viewport anyway.

**How it works.** The cell bounds are computed with `Math.floor`/`Math.ceil` of
the visible range (`render.ts:229-232`), so the drawn grid always covers the
viewport completely. In `slide.ts` the still field skips moving rows and columns
but then draws them, extended by their travel — also full coverage. The clear is
therefore one extra full-screen fill per frame, ~14.7 M pixels at dpr 2.

**Significance.** Low to medium on its own — a solid fill is the cheapest thing
a GPU does — but it is free to remove and it compounds with §3.5.

**Trade-offs.** It stops being redundant the moment a cell fails to draw, and
the "blank" path already fills its own rect (`render.ts:287-288`), so coverage
is genuinely total. The risk is a future change that leaves a gap and gets a
garbage-filled hole instead of a background-coloured one. Keeping the clear
under `DEBUG`, or asserting coverage in a test, would buy back the safety.

---

### 3.7 The planner blocks the main thread between the flight and the slide

**What it is.** `buildRearrangement` + `planMoves` run synchronously, and at the
current settings they take **~20-25 ms** — one to two dropped frames, at the
exact seam between the zoom-out landing and the slide starting, on every single
rearrangement.

**How it works.** `useRearrangement.ts:188-199` awaits the flight, then builds
the board and plans the moves inline before the first slide frame. Measured on
a 2048-room corpus, 1920x1080, median of 7 runs (Node, so treat as an order of
magnitude rather than a browser number):

| minVisibleCells | build | plan | total | moves | of which visible shifts |
|---|---|---|---|---|---|
| **5 (current)** | 3.3 ms | **21.6 ms** | 24.9 ms | 8122 | 72 (1%) |
| 16 | 1.4 ms | 21.6 ms | 23.0 ms | 7537 | 512 (7%) |
| 32 | 1.6 ms | 60.1 ms | 61.7 ms | 7545 | 1714 (23%) |
| 64 | 3.2 ms | 252.8 ms | 256.0 ms | 12960 | 5152 (40%) |

Note what dominates: `planMoves`, not `buildRearrangement`. And note that 99% of
the moves at the current setting are invisible off-camera swaps — the planner is
spending its time on board repair, not on anything the reader sees.

**Significance.** Medium-high, and it is a *current* cost, not a hypothetical
one. A 20-25 ms synchronous block lands precisely at the transition the eye is
already tracking. It is also the single cheapest thing here to confirm: wrap the
two calls in `performance.now()` and read the number.

**Trade-offs.**

- *Plan during the flight instead of after it.* The flight's destination is
  fully determined before it starts — `flyTo(cam.current.x - 0.5,
  cam.current.y - 0.5, target)` (`useRearrangement.ts:164`) — so the parked
  camera, the view rect and therefore the whole plan are all knowable in
  advance. The comment above that line says the plan "cannot be made until the
  camera has stopped moving", which is true of *reading `cam.current`* but not
  of the plan itself. Planning optimistically against the target and discarding
  it if the flight is interrupted (a case already handled) moves the stall off
  the seam. It does not remove it — a 20 ms block mid-flight is still a 20 ms
  block, and arguably more visible while the camera is moving.
- *Move it to a worker.* `board.ts` and `illusion.ts` are pure, DOM-free modules
  operating on plain arrays, which makes this unusually tractable — the board is
  a flat `BoardValue[]` that could be a transferable typed array. This is the
  real fix, and it composes with the item above: plan in a worker during the
  flight and the stall disappears entirely rather than moving.
- *Make the planner cheaper.* 99% of its moves being invisible repair suggests
  there may be headroom, but that is `illusion.ts`'s staging logic, which
  `AGENTS.md` flags as subtle (the independence guarantees a `wave` stage
  makes). Not a first move.

---

## 4. Candidates that matter when zoomed out, not during a rearrangement

Everything here scales with visible cell count, so it is secondary during a
rearrangement (~48 cells on a desktop, ~96 on a portrait phone — see §1) and
dominant when a reader zooms all the way out and pans. Treat the phone figure as
the reason not to dismiss this section on the strength of the desktop one. At
the coarsest
zoom the pyramid's own table puts the worst case at ~7500 visible cells, of
which `contentRatio` 0.25 (`config.ts:202`) makes roughly 1875 real rooms.

### 4.1 `locateTile` allocates on every call, and `get()` calls it every frame per cell

**What it is.** The cache asks "does this level exist for this room" on every
visible cell every frame — including cache hits — and answering allocates
strings and objects each time, for a fact that never changes.

**How it works.** `get()` (`tiles.ts:509-516`) unconditionally calls
`servableLevel(id, want)`, which calls `locateTile`. For a sheet-packed level,
`createTileLocator`'s returned function (`rooms.ts:83-93`) does
`sheetPosition()` (allocates an object), `sheetFileName()` (`String(n)
.padStart(4,'0')` plus a template literal — two strings), a url template
literal, and a fresh `rect` object. Five allocations per call, per cell, per
frame.

Worse for the wallpaper: a shared id resolves only at level 0
(`rooms.ts:78`), so for every generic cell `servableLevel`
(`tiles.ts:487-496`) walks the ladder forward and then backward, calling
`locateTile` up to eleven times to rediscover that generics live at level 0.
At ~5600 generic cells that is tens of thousands of Map lookups per frame to
answer a constant.

**Significance.** High at coarse zoom. This is likely the largest pure-JS cost
in a zoomed-out frame and a major GC pressure source.

**Trade-offs.** Memoize both `locateTile` and `servableLevel` per `(id, level)`
— the answers are immutable for a given manifest. Memory is trivial (2048 rooms
x 6 levels of small objects, and the shared ids are a handful). Two cautions:
the returned `TileLocation`/`rect` objects become shared rather than
per-call, so no caller may mutate them (freeze them in development, or document
it); and the cache must be rebuilt when the manifest changes, which
`useMemo`'s existing `[manifest]` dependency already expresses.

### 4.2 `roomAt` builds a string key and allocates a result object per cell

**What it is.** The map's cell lookup allocates twice per cell per frame, once
for a `"x,y"` Map key and once for the result.

**How it works.** `rankOf` (`ordering.ts:320-323`) does
`rankAt.get(key(x, y))` where `key = (x, y) => \`${x},${y}\``
(`ordering.ts:490`). `roomAt` (`ordering.ts:326-331`) then returns a fresh
object literal. Both `render.ts`'s visible pass and its prefetch ring call it,
so at coarse zoom that is on the order of 12,500 template-literal strings and
12,500 objects per frame — each string also hashed by the Map.

**Significance.** High at coarse zoom, for the same reason as 4.1.

**Trade-offs.** A numeric key removes the string (pack two 16-bit signed
coordinates into one integer, or nest two Maps), but the map is infinite in
principle, so any packing needs an explicit, tested range and a documented
fallback outside it. Removing the *result* allocation is the harder half:
`RoomAtResult` is a tidy discriminated union used well beyond the render loop.
Options are a second scalar-returning API for the hot path (`rankAt(x, y)`
returning `-1` for generic, which is most of what the renderers actually want)
or a reused mutable result object, which is a genuine footgun — anything that
retains it across iterations silently breaks. The scalar API is the safer
change and does not disturb existing callers.

### 4.3 The favorite badge is drawn at every zoom, ungated

**What it is.** Every non-center, non-generic cell gets a full badge draw —
a cache lookup, a rect computation and a `drawImage` — with no zoom gate at all,
including at zooms where the badge is a fraction of a pixel.

**How it works.** `render.ts:298-303` calls `drawFavoriteBadge` for every real
room; `drawFavoriteBadge` (`render.ts:457-485`) does its own `cache.get(id, 0)`
and `favoriteIconScreenRect`. `slide.ts:479-480` does the same during the
animation. The badge is scaled by `cellPx.x / BASE_TILE.w`
(`favoriteBadge.ts:96`), so at a cell width of 10 px the icon is drawn at about
1% of its native size — thousands of draw calls per frame producing nothing a
reader can see.

Worth flagging separately, since it turned up while checking this: the tap test
is **not** size-gated either. `favoriteHitRect` (`favoriteBadge.ts:132-150`)
returns null only when the trace has no bbox at all; otherwise it hands back the
scaled bounds, padded for touch. `main.tsx:1012-1013` hit-tests against that
directly with no minimum. So at coarse zoom the badge is a sub-pixel target that
still toggles a favorite when hit — invisible and live, rather than invisible and
inert. (`AGENTS.md`'s "the tap hit-test only enables once the scaled hit bounds
clear `MIN_FAVORITE_HIT` (24px desktop, 48px `(pointer: coarse)` mobile)"
describes something the code does not currently do; the only related constant is
`MIN_FAVORITE_HIT_TOUCH = 20`, which pads rather than gates. Either the doc or
the code is stale — worth resolving on its own merits, not as part of a
performance pass.)

**Significance.** High at coarse zoom, and it is close to a free fix: roughly
doubles the draw calls and cache lookups of a zoomed-out frame for no visible
output.

**Trade-offs.** Gate drawing and hitting on one shared threshold, so "visible"
and "usable" become the same statement — the center tile's controls already do
exactly this via `areSpinesLegible` (`render.ts:329`), and it fixes the live
sub-pixel target above at the same time. The
consequence is that badges fade out when zoomed out, which is a design change,
not just an optimization: a reader loses the at-a-glance sense of which rooms
are favorited across a wide view. If that view matters, the honest fix is a
cheaper *representation* at coarse zoom (a solid quad in the corner rather than
a scaled PNG), not silence.

### 4.4 The generic tiles have no pyramid

**What it is.** Every wallpaper cell — about 80% of a zoomed-out field — draws a
full-resolution 1024x768 source image scaled into a few pixels.

**How it works.** `rooms.ts:78` resolves a shared id at level 0 only, so
`servableLevel` always falls back there, and `main.tsx:355-358` pins the generics
at level 0 accordingly. `AGENTS.md` already flags this ("The shared tiles are
served flat (level 0) for now", plan §8). Memory is fine — the cache keys on id,
so a screenful of thousands of generic cells holds a handful of images — but
*drawing* is not: a filtered downscale from a 1024x768 source into a 10x8
destination is far more expensive per destination pixel than drawing the 32x24
mip the pyramid would have provided, and it is paid on the majority of cells.

**Significance.** High at coarse zoom, and it is likely the single largest
`drawImage` cost multiplier there. `SMOOTHING_MAX_DOWNSCALE` mitigates it by
turning off bilinear filtering when the ratio gets extreme, which is exactly why
that gate exists — but nearest-neighbour sampling of a 1024x768 source is still
sampling a 1024x768 source, with the cache and bandwidth behaviour that implies.

**Trade-offs.** Giving the shared assets their own pyramid is pipeline work plus
a manifest change plus making `rooms.ts`'s shared-id resolution non-flat, and it
invalidates the "shared tiles are served flat" invariant that several call sites
currently rely on. `AGENTS.md` explicitly warns not to pin a shared id at
`FALLBACK_LEVEL` because there is no tile there — that warning becomes obsolete
with this change and must be updated in the same pass, or it will mislead. The
cheaper interim is to generate just two or three coarse sizes for the generics
rather than the full ladder.

### 4.5 Prefetch work is paid even when the queue is already full

**What it is.** The prefetch ring computes what to prefetch for every ring cell
before discovering there is no room in the queue, and the warm pass iterates
every visible id even though the vast majority are duplicates.

**How it works.** `render.ts:343-350` walks the ring — at coarse zoom with
`marginRatio` 0.15 that is roughly 1.7x the visible area, several thousand extra
cells — calling `layout.roomAt()` and `idOf()` (with all the allocation of 4.2)
for each, *then* calling `cache.prefetch`, which early-returns the moment
`queue.length >= QUEUE_LIMIT` (256) (`tiles.ts:531`). Everything computed after
the queue fills is discarded. Separately, `render.ts:355-356` iterates the whole
`visible` array per warm level; at coarse zoom ~80% of its thousands of entries
are one of a handful of generic ids, so the same few ids are offered for
prefetch thousands of times.

**Significance.** Medium to high at coarse zoom, and unusual in that it is
*pure* waste — the work has no effect at all once the queue is saturated.

**Trade-offs.** Checking remaining queue capacity before computing the id is
trivial. Deduplicating the warm pass (walk distinct ids, not cells) is trivial.
The subtle part is that bailing early makes prefetch coverage order-dependent —
the ring is walked in a fixed raster order, so a queue that always fills at the
same point would always warm the same corner. Rotating the start point per
frame, or widening `QUEUE_LIMIT` when cells are cheap, avoids trading a
performance bug for a correctness-of-coverage one.

### 4.6 `genericId` builds a string per generic cell per frame

**What it is.** `genericId(i)` returns `` `generic:${i}` `` (`tiles.ts:81`),
allocating a string every call, and it is called for every generic cell every
frame from `idOf` (`render.ts:89-90`) and from `slide.ts`'s `idFor`.

**Significance.** Low individually, but it is thousands of allocations per frame
at coarse zoom and the fix is three lines — intern the ids in an array at module
load, since `genericCount` is small and known.

**Trade-offs.** None worth the words, beyond keeping `genericId(-1) === CENTER`
intact, which the array can express directly.

---

## 5. Structural changes

Larger swings, listed because the question was what is *possible*, not what is
advisable tonight.

### 5.1 Cache the still field to an offscreen canvas

**What it is.** During a slide, the non-moving field is redrawn in full every
frame even though, by construction, it does not change. Draw it once to an
offscreen canvas, blit it, and draw only the moving lines on top.

**How it works.** `slide.ts:492-496` paints every cell not in a moving row or
column, every frame. The board only changes when a step is absorbed. The same
idea generalizes to panning in `render.ts`: a pan could blit the previous frame
shifted and draw only the newly exposed strips.

**Significance.** Potentially very high for the slide, and it grows with cell
count, so it is the one item here that helps both the rearrangement and the
zoomed-out case. It also composes with everything in §4 by simply not doing that
work.

**Trade-offs.** Substantial. Invalidation is the whole problem: a step
absorption, a fade change, a hover, a badge toggle, a newly arrived tile
(`onLoad` fires `requestDraw` at arbitrary times) all dirty the cache, and
getting that wrong produces stale pixels, which is a far worse failure than a
dropped frame. It costs a second full-size backing store at dpr 2. And it
complicates the `DrawContext` abstraction that makes these renderers testable
without a browser — `render.test.mjs`'s recording fake would need to model a
second surface.

### 5.2 A WebGL renderer

**What it is.** Upload the sheets as textures once and draw the whole field as
one instanced draw call.

**Significance.** The highest ceiling by a wide margin — cell count becomes
nearly free, the sheets become explicit long-lived textures with upload timing
under our control (which incidentally solves §3.1 outright), and fill rate stops
being a per-cell JS concern.

**Trade-offs.** A rewrite of the two renderers, and it takes the whole
browser-free testing story with it: `render.test.mjs` and `slide.test.ts`
currently assert real drawing decisions against a recording fake context, which
has no WebGL equivalent that is anywhere near as cheap. It also adds
context-loss handling, shader/precision portability, and a text-rendering
problem for the spines that Canvas2D solves for free. This is a "the project is
about the art, not the renderer" call, and the honest answer is probably no.

### 5.3 Coalesce the pointermove handler

**What it is.** `useMapRenderer.ts:424-514` runs on every `pointermove` event,
unthrottled, doing a `getBoundingClientRect`, three `querySelector` calls, two
polygon point-in-shape tests, and a `roomAtPoint` (which allocates through
`roomAt`) — and calls `draw.current()` up to three times.

**Significance.** Medium, and concentrated during exactly the interaction where
smoothness is most noticeable: a drag. High-rate mice and trackpads fire well
above 60 Hz, so this can run several times per frame to produce one frame's
worth of hover state.

**Trade-offs.** Store the last event and process it once per rAF; cache the
three `querySelector` results in the effect rather than re-querying per event;
share the cached canvas rect from §3.3. The cost is one frame of hover latency,
which is imperceptible, and slightly more state in an effect that already has a
fair amount.

### 5.4 Move search scoring off the main thread

**What it is.** `rankHybrid` (`packages/map/scoring.ts:923`) scores the whole
corpus synchronously — `embeddingScores` over 2048 embeddings plus per-room
tokenization and lemmatization — and it runs immediately before the
rearrangement it triggers.

**Significance.** Medium, and badly timed: whatever it costs lands as a single
stall right at the start of the animation, which is precisely when a dropped
frame is most visible. Worth measuring before assuming it is small.

**Trade-offs.** A worker means transferring or sharing the embeddings blob
(fine — it is a `Float32Array` and transferable) and making the search path
async at a call site that is currently synchronous. The scoring functions are
already pure and browser-free, which is most of the work done. The complication
is that `useSearch` already juggles a server round trip for the CLIP text
tower; adding a second asynchronous boundary needs care about ordering and
cancellation.

---

## 6. Should the finest sheet level go back to per-file?

**Implemented.** `SHEETS.fromLevel` is `3`; level 2 is per-file, at a real-bytes
budget (`LEVELS[2].budget`, `packages/web/src/lib/pyramid.ts`). The analysis
below is kept for the reasoning, not as a thing still to do.

Short answer: **yes, and the argument is stronger than "level 2's sheets are
inconveniently large."** Sheet packing trades requests for bytes, and that trade
inverts as you move down the ladder. Level 2 is on the losing side of it.

### 6.1 The economics, measured

For each sheet-packed level, at the zoom within its band that puts the most
cells on screen (the worst case for that level), with `contentRatio` 0.25 and a
2048-room corpus in 8 sheets per level:

| level | tile | viewport | rooms visible | per-file | sheets |
|-------|------|----------|---------------|----------|--------|
| **2** | 256x192 | 1920x1080 @2x | 20 | 20 req, **3.8 MB** | 7.4 req, **357 MB** |
| **2** | 256x192 | 1440x900 @2x | 12 | 12 req, **2.3 MB** | 6.4 req, **307 MB** |
| 3 | 128x96 | 1920x1080 @2x | 56 | 56 req, 2.6 MB | 8.0 req, 95.9 MB |
| 4 | 64x48 | 1920x1080 @2x | 192 | 192 req, 2.3 MB | 8.0 req, 24.0 MB |
| 5 | 32x24 | 1920x1080 @2x | 713 | 713 req, 2.1 MB | 8.0 req, 6.0 MB |

Read the two ends against each other:

- **At level 5**, sheets turn 713 requests into 8 and cost 4 MB extra. That is
  the trade the feature was built for, and it is an excellent one.
- **At level 2**, sheets save 12 requests and cost **353 MB**. That is a ~94x
  memory amplification to avoid a dozen HTTP requests.

The crossover sits around level 3/4. Level 2 is not merely the largest sheet
level — it is the one where the whole mechanism stops paying for itself.

### 6.2 Why level 2 is so bad: two compounding factors

**Utilization.** A sheet is 256 rooms. At level 2's zoom band only ~12-20 rooms
are on screen, so you fetch 256 rooms' worth of pixels to display 20 — under 8%
utilization. At level 5 hundreds of rooms are visible at once and a sheet is
mostly used.

**No locality, by construction.** Sheet packing assumes co-visible rooms share a
sheet. This app guarantees they do not: the default order is
`shuffledOrder(total, orderSeed)` seeded from `Date.now()`
(`main.tsx:253`) — the map is a *random permutation* of room ids even with no
search, and a search permutes it differently. Sheets are packed by room id, so
20 visible rooms are 20 uniformly random ids landing in an expected
`8 x (1 - (7/8)^20) = 7.4` of the 8 sheets. Nearly every sheet gets pulled in to
show twenty tiles.

That second point is worth dwelling on because it is not a tuning problem: no
choice of grid size fixes it. Any packing keyed on room id is defeated by an
order that is randomized per session. Sheets survive at coarse levels *despite*
this only because there the visible rooms outnumber the sheets anyway.

### 6.3 What it would cost

**The code change is one constant.** `SHEETS.fromLevel: 2` -> `3`
(`pyramid.ts:238`) is the entire switch:

- `packages/pipeline/index.ts:103` filters which levels get packed, and the
  `rm` that deletes a packed level's scratch per-file directory runs only for
  those — so level 2's per-file directory is simply kept.
- `packages/server/scan.ts:136` discovers level 2 as a per-file directory.
- `rooms.ts` needs nothing: its sheet branch keys off `info.sheet` from the
  manifest.

The one test that breaks is the expected kind: `scan.test.ts:351` hardcodes
level 2 as its sheet-packed example and would find level 2 missing (its fixture
has a `256-sheets/` dir but no `256/` one). That test wants rewriting against
level 3, not fixing.

Beyond that: regenerate the pyramid and re-upload the corpus.

**Lower level 2's budget in the same change.** `LEVELS`' budget of 1800 for
level 2 (`pyramid.ts:158`) was set when it counted cheap sheet *pointers*. As a
per-file level it counts real decoded images again, so 1800 becomes a 345 MB
ceiling. Worst-case visible at level 2 is ~84 entries, so something in the
400-600 range (77-115 MB) is the honest number. `pyramid.ts`'s own budget table
and its "treat its rows for 2-4 as budget bytes no longer meaning real memory"
note both need updating — the row for level 2 goes back to meaning real bytes.

**Request cost, against the actual rate limit.** `infra/variables.tf` sets
**200 requests per IP per 10 s**, blocking for 10 s, and crucially
`abuse-protection.tf:38` sets `requests_to_origin = true` — **only cache misses
count**, with a 24 h edge TTL. So:

- A screenful at level 2 is ~12-20 origin requests cold, nothing warm. Fine.
- The risk is sustained panning at level 2 on a cold edge: continuously
  bringing new rooms into view could approach 200 misses in 10 s. Level 2 is a
  fairly zoomed-in band though, so panning crosses few new rooms per second —
  much less exposed than level 5, which is where the original problem was.
- Every repeat visitor, and every visitor after the first through a given
  region, is served from the edge and counts nothing.

**A side benefit:** `SHEETS`' own docblock notes that a sheet re-uploads as a
unit when any room in it changes, so per-file at level 2 shrinks the re-upload
blast radius for the level with the largest files.

### 6.4 What it does *not* fix

Per §3.1's corrected traversal table: **a desktop rearrangement never reaches
level 2**, so this changes nothing about the dropped frames on desktop. It helps
the phone case (which does traverse into level 2, and where trading ~211 MB of
sheets for ~1.1 MB of tiles mid-animation is a large win on the most
memory-constrained device), and it helps the far-zoom-out browsing case
generally.

Worth doing on the memory argument alone — a 94x amplification to save twelve
requests is indefensible once stated plainly — but it should not be expected to
fix the desktop symptom that started this.

### 6.5 Should level 3 go too?

Level 3 is 96 MB of sheets against 2.6 MB per-file, for 56 requests saved. Less
damning than level 2 but still a poor trade; the honest crossover is probably
`fromLevel: 4`. The reason to stop at 3 for now is that level 4 and 5 are where
the request counts get genuinely dangerous (192 and 713 for one screen), and
level 3 sits close enough to that band to be worth keeping packed until there is
a measurement rather than an argument. Move one rung, look at it, decide about
the next.

---

## 7. What if the animation ran zoomed out further?

`minVisibleCells` is 5, and nothing about the animation requires that. Zooming
out further picks a coarser pyramid level, and a coarser level means much
smaller tiles — so the render cost per tile falls sharply even as the number of
tiles rises. That intuition is **correct on the axis it names**, and wrong about
the thing that actually binds.

### 7.1 Everything, measured, at 1920x1080 @2x

`decoded MB` is the visible working set at that level under each `fromLevel`
policy (§6); `plan ms` is §3.7's synchronous block; `duration` is
`buildTimeline`'s own `totalMs` for the resulting plan.

| minVis | zoom | level | tile | cells | rooms | MB @from2 | MB @from3 | plan ms | **duration** | peak lines |
|---|---|---|---|---|---|---|---|---|---|---|
| **5** (now) | 288 | L0 | 1024x768 | 48 | 12 | 36.0 | 36.0 | 21.6 | **0.81 s** | 5 |
| 8 | 180 | L1 | 512x384 | 120 | 30 | 22.5 | 22.5 | 16.4 | **1.43 s** | 7 |
| 12 | 120 | L2 | 256x192 | 252 | 63 | **383.9** | 11.8 | 19.5 | **2.22 s** | 8 |
| 16 | 90 | L2 | 256x192 | 432 | 108 | **384.0** | 20.3 | 21.6 | **3.79 s** | 10 |
| 24 | 60 | L3 | 128x96 | 884 | 221 | 96.0 | 96.0 | 34.6 | **6.22 s** | 13 |
| 32 | 45 | L3 | 128x96 | 1496 | 374 | 96.0 | 96.0 | 60.1 | **10.07 s** | 16 |
| 48 | 30 | L4 | 64x48 | 3300 | 825 | 24.0 | 24.0 | 170.8 | **24.43 s** | 23 |

### 7.2 The render cost does fall, as predicted

From minVis 5 to 16, with level 2 unpacked per §6: the tile drops from 1024x768
to 256x192 (**16x fewer pixels each**), the working set from 36 MB to 20 MB, and
every newly-arriving room costs a ~15 KB fetch and a 192 KB decode instead of a
full-resolution JPEG and a 3 MB decode. That is a direct hit on §3.1's corrected
desktop hypothesis — full-resolution tiles arriving mid-animation — and it is
exactly the effect you predicted.

It also composes with §6 in both directions, which is worth being explicit
about: **minVis 12-16 lands on level 2, so without §6 it walks straight into the
384 MB sheet wall.** The two changes are much better together than either alone.
Zooming out without unpacking level 2 is actively worse than doing nothing.

The board, incidentally, barely moves: it stays 91x119 from minVis 5 through 32
because it is sized by `boundaryRadius` (43.2 cells) rather than by the
viewport, only growing to 121x157 at minVis 48 when the "region under a quarter
of the board" rule finally bites.

### 7.3 What actually binds: the animation gets *long*

**0.81 s at minVis 5, 3.79 s at 16, 10.07 s at 32, 24.43 s at 48.**

This is not a performance cost — no frames are dropped by it — but it is the
constraint that decides the question. A rearrangement fires on every search, and
a four-second one is a different feature from a 0.8-second one. Twenty-four
seconds is not a feature at all.

The cause is structural: zooming out puts more lines across the camera (72
visible shifts at minVis 5, 512 at 16, 5152 at 48), and `buildTimeline`
sequences them with a stagger between wave lanes and a cascade within sequential
ones. More lines, more time.

**Scaling the timings down does not rescue it.** `config.slide`'s docblock notes
that lowering all five proportionally makes the same animation faster, so
holding 0.8 s at minVis 16 means scaling by ~0.21: `base` 80 -> 17 ms,
`perCell` 26 -> 5.5 ms. A ten-cell run would then cross 900 px in 72 ms — about
12,500 px/s, which reads as a flicker, not a slide. The per-line speed is
already near the top of what looks deliberate.

**The lever that would actually work is parallelism.** Peak concurrent motions
only rises from 5 to 10 across that whole range, so the planner is running these
lines mostly in sequence even when far more of them could move at once. If a
zoomed-out rearrangement ran 30-40 lanes concurrently instead of 10, it could
stay near a second while looking considerably richer — arguably better than what
it does now, since a sliding-tile illusion with five lines moving is a sparse
picture. But that means changing which stages `illusion.ts` marks `wave`, and
those marks encode real independence guarantees (`AGENTS.md`: a parking stage's
extraction rotates a line and the swap after it depends on that rotation). Not a
constant to twiddle.

### 7.4 One constant, five call sites

`config.camera.minVisibleCells` is not the animation's setting — it is the
**return-to-center view**, shared by the rearrangement's park
(`useRearrangement.ts:147`), `Home`/`End` (`useMapCursor.ts:334,362`), the
double-tap-back and room navigation (`main.tsx:881,893`), and the center button
(`main.tsx:935`).

Raising it globally would zoom the reader way out every time they press Home,
which is a navigation change nobody asked for. The animation needs its own
constant — `config.slide.zoomOutCells`, say — with `minVisibleCells` left where
it is. `AGENTS.md` already warns that these two views "are not interchangeable"
and that collapsing them "silently breaks whichever view loses"; this would be
splitting one of them further, in the same spirit.

### 7.5 Where this lands

- **minVis 8** is free money: level 1, 4x fewer pixels per tile, working set
  36 -> 22.5 MB, planner slightly *cheaper*, and the animation goes 0.81 -> 1.43 s.
  No dependency on §6. The duration cost is real but modest.
- **minVis 12-16** is the interesting one — level 2, 16x smaller tiles, working
  set down to 12-20 MB — but it **requires §6** (or it is a 384 MB regression),
  and it takes the animation to 2.2-3.8 s, which needs the parallelism work in
  §7.3 before it is acceptable.
- **minVis 24+** is not worth pursuing. Level 3's sheets put the working set
  back up to 96 MB, the planner starts costing more than the frames it saves,
  and the duration is out of the question.

So: a modest step is cheap and worth taking; the bigger step you have in mind is
genuinely better for rendering and blocked on animation *pacing*, not on
rendering cost. That is a more tractable problem than it sounds — the headroom
is sitting in `illusion.ts`'s staging, unused.

---

## 8. Suggested order

§9's measurements reprioritize this list — read it first; it promotes item 3
above item 5 and downgrades item 5. This is the ranking reasoning alone
produced, if the measurements in §2 come back inconclusive and something has to
be picked without them:

1. **§3.3 forced layout** — small, safe, verifiable in seconds, pays back on
   every frame the app ever draws.
2. **§3.2 spine memoization** — small, well-bounded, and the best fit for "the
   zoom-out specifically stutters". The flight *starts* framed on the shelf, so
   this runs at full cost exactly where the symptom is reported.
3. **Warm the incoming arrangement's level-0 tiles during the flight** (§3.1's
   corrected reading). On desktop the rearrangement runs entirely at level 0 and
   the rooms sliding in are new ids, so it is fetching ~48 full-resolution
   images mid-animation. The new `order` is known at `startRearrangement` time
   and the flight is several hundred ms of idle network — prefetch against it
   before the slide begins.
4. **§6 unpack level 2 to per-file** — one constant, one test rewrite, a corpus
   regeneration. Do it for the 94x memory amplification, not for the desktop
   symptom, which it will not touch.
5. **§3.7 plan in a worker, during the flight** — a measured ~20-25 ms
   synchronous block at the seam between the zoom-out and the slide, on every
   rearrangement, today. `board.ts` and `illusion.ts` are pure array code, so
   this is unusually tractable. Confirm it first with two `performance.now()`
   calls; it is the cheapest measurement in this document.
6. **§7.5 raise the animation's zoom to ~8 cells** — behind its own constant,
   not `minVisibleCells` (§7.4). Level 1 instead of level 0 means 4x fewer
   pixels per tile for a 0.81 -> 1.43 s animation. Going further is better for
   rendering but blocked on animation pacing, not on rendering cost.
7. **§4.1 and §4.2 memoization** — mostly the zoomed-out story, but they are
   the largest wins available there, they are mechanical, and at ~96 cells they
   are not nothing during a rearrangement on a phone either.
8. Everything else as appetite allows.

§3.5 (dpr during motion) is the wildcard: potentially the biggest single win for
the exact symptom, and especially attractive because a desktop rearrangement
runs at level 0 — where every cell is a 3 MB tile being downscaled and fill cost
is at its worst. It still interacts with level selection, so design it alongside
item 3.

**The traversal table (§3.1) removes sheet preloading from this list.** A
desktop rearrangement touches no sheet at any point, so ~510 MB of preloading
would buy nothing. Every item here is reasoning about which levels the
animation reaches, not a measurement — treat the ranking as provisional until
§2 has run (and §9 has: it does reorder this).

**If the dropped frames are reported on a phone rather than a desktop, reorder
again.** §1's table shows a portrait phone drawing ~96 cells against a desktop's
~48, and the phone is the *only* configuration that traverses into a sheet
level. There §6 stops being a memory-hygiene change and becomes a direct fix,
and §4's per-cell family and §3.5's fill-rate argument both move up sharply.
Establishing which device the symptom is on is therefore worth doing before
anything in §2.

---

## 9. Measured findings

Four `?perf` captures (§2), same five-action script — search "fire", enable
distill mode, search "ice", clear the search, disable distill mode — against the
real 2048-room corpus (8 sheets per packed level): desktop Chrome, desktop
Firefox, Android Chrome, Android Firefox.

### 9.1 Instrumentation caveats

Two limits, for whoever reuses this instrumentation:

- **Firefox implements no `longtask` observer**, so its captures have only frame
  timing and sheet timestamps. `perfProbe.ts`'s `ensureFrameGapLoop` (the rAF-gap
  fallback) is the only cross-browser stall signal — validated against Chromium
  CPU throttling to match native `longtask` in magnitude and timing, undercounting
  only when two stalls fall inside one frame.
- **A longtask's phase tag can lag one synchronous block.** The observer callback
  runs after the block that produced the entry, by which point the phase variable
  may have advanced — so a seam-timed stall (`planMoves`, at the tail of the
  flight) can read as `'slide'`. The timestamps still pin the moment.

### 9.2 Steady-state draw cost is not the bottleneck

Per-draw-call timings stay well under budget everywhere (desktop p50 ~1ms / p90
2-6ms; Android p50 3-6ms / p90 7-28ms). Dropped frames appear as stalls *between*
frames, not as slow `draw()` calls — a clean negative result for §4's per-cell
allocation candidates *during a rearrangement* (they still matter zoomed out and
panning). Everything below is about stalls, not steady per-frame cost.

### 9.3 The first rearrangement of a session is the worst

The first action (nothing cached) carries a ~1s stall during the flight, larger
than anything later in the session: up to ~995ms on desktop Chrome, ~950-1030ms
on Android Chrome. This is §3.1's corrected reading — level-0 tiles for ~48 rooms
never before on camera, fetched/decoded/uploaded mid-flight — landing as a
visible freeze inside the animation. It is the motivating case for preparing
every tile the animation will show before the camera moves
(`prepareRearrangement`; see `AGENTS.md`, "The reorder animation").

### 9.4 The planner's seam cost is real but lands before motion

Every rearrangement after the first carries one ~75-125ms stall at the
flight/slide seam, consistent with `planMoves` (§3.7). Because it lands *before*
the slide moves, it reads as ordinary loading latency rather than a mid-slide
stutter — which is why moving the planner to a worker stays low priority.
Building the plan during prepare (the landing rectangle is known ahead of a
flight that only changes zoom) removes the seam regardless.

### 9.5 Level-2 sheet substitution is reachable from ordinary browsing

`bestAvailable` draws a coarser *ready* level while a cell's intended art is
mid-fetch. This fires whenever a warmed coarser cache meets a wave of rooms never
before on camera — it is not distill-specific: every frame warms one level
coarser (`warmLevels`), and sheets have no locality (§6.2 — a screenful of ~20
rooms touches ~7.4 of 8 sheets), so any session long enough to warm level 2 hits
it on the next rearrangement. The cost when it fires:

| environment | fetch+decode per sheet | time to first draw |
|---|---|---|
| desktop Chrome | ~110-145ms | 1.5-1.8s |
| Android Chrome | ~450-735ms | 1.3-1.5s |
| desktop Firefox | ~110-530ms | 1.5-7.1s |
| **Android Firefox** | **~1.5-1.8s** | 1.0-1.4s, then **10.3-10.5s for three of eight sheets** |

This is the strongest evidence for §6 (retire level-2 sheet packing): it explains
the worst stall measured and is reachable from a normal desktop session, not only
from a phone. Android Firefox's fetch+decode alone matches the ~1.5s main-thread
decode `tiles.ts` warns about — see §9.6.

### 9.6 Why Firefox serializes decode

`tiles.ts` uses `createImageBitmap()` specifically because the spec allows
calling it from a Worker, which should buy off-main-thread decode. In Gecko it
does not: `ImageBitmap` construction historically went through a Cairo-derived
surface type ([bug 1778394](https://bugzilla.mozilla.org/show_bug.cgi?id=1778394))
that required main-thread manipulation, so the call succeeds but Gecko dispatches
the work back to the content main thread synchronously
(`DecodePool::SyncRunIfPossible`, as `tiles.ts`'s own docblock notes). The Cairo
dependency is gone but the bug to lift the restriction is still open. Firefox's
ordinary `<img>`/CSS-background decode path *is* parallel
([bug 716140](https://bugzilla.mozilla.org/show_bug.cgi?id=716140), 2012) — it is
the `createImageBitmap` route that is pinned.

The one API that decodes off-main-thread in Firefox is WebCodecs `ImageDecoder`,
but it is unsupported in Firefox for Android — the worst-case environment here —
so adopting it would mean a feature-detected third decode path for a win that
misses the platform that hurts. Revisit if Firefox for Android ships it.

### 9.7 What shipped, and what is still open

`prepareRearrangement` fetches every tile the animation will show — the simulated
on-camera set, measured 27-48% larger than the static union of `before`/`after`
viewports — through the render path's concurrency cap, before the camera moves.
On Android Chrome's cold start this holds the slide at ~56 frames with a worst
stall of 127-456ms.

Still open, for a future session:

- **Android Firefox slide-phase stalling.** Even with every tile decoded before
  the flight, its first rearrangement still shows ~1.9s of cumulative slide
  stalling. The working hypothesis is a GPU texture-upload cost paid at the first
  real `drawImage` (decode-ready is not upload-ready); two warm-up designs were
  measured and neither helped on either Android browser, so nothing shipped for
  it. The real mechanism — plausibly compositing/paint scheduling tied to
  visibility rather than to the draw call — is not yet understood, and is worth a
  fresh look rather than another warm-up variant.
