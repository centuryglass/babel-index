# Performance research

A read-through of the render path looking for non-trivial performance wins, with
the dropped frames during the rearrangement's zoom-out and slide as the
motivating case.

**Status: hypotheses, not measurements.** Every finding below comes from reading
the code and computing what it must cost, not from a profile. Several are
arithmetic certainties (a 48 MB decode is a 48 MB decode); others are educated
guesses whose real magnitude depends on the machine. Nothing here should be
implemented on faith — §2 is the instrumentation that would rank them for real,
and it is deliberately the first section after the framing.

Numbers assume the current corpus (~2048 rooms), `BASE_TILE` 1024x768, the
`LEVELS` ladder in `packages/web/src/lib/pyramid.ts`, and `SHEETS` packing
levels 2-5 at 16x16 rooms per sheet.

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

**Significance.** High, and the best fit for the symptom. It is per-transition
rather than per-cell, which matches an animation that drops frames at
particular moments rather than running uniformly slow. It also explains why the
existing off-thread decode work helped without fixing it.

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
- *Shrink level 2's sheets.* Halving the grid to 8x8 would make them 2048x1536
  (12 MB) at the cost of 4x the sheet count and 4x the requests, which is
  exactly the tradeoff `SHEETS`' docblock says sheets exist to avoid
  (Cloudflare per-IP rate limiting — `infra/README.md`,
  `docs/design-history.md`). A middle option is a smaller grid *only* at
  level 2, where the per-sheet cost is pathological and the number of distinct
  rooms visible at that zoom is lowest.
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

## 6. Suggested order

If the measurements in §2 come back inconclusive and something has to be picked
on reasoning alone:

1. **§3.3 forced layout** — small, safe, verifiable in seconds, pays back on
   every frame the app ever draws.
2. **§3.2 spine memoization** — small, well-bounded, and the best fit for "the
   zoom-out specifically stutters".
3. **§3.1 sheet preloading plus a forced first upload** — the prime suspect,
   and cheap at this corpus size because `sheetBudget` already never evicts.
   Do §2.3 first; this one is worth confirming before spending 510 MB on it.
4. **§3.1 alternative: pin the level for the duration of a flight** — possibly
   better than preloading, since it removes the transitions rather than paying
   for them faster. Try both.
5. **§4.1 and §4.2 memoization** — mostly the zoomed-out story, but they are
   the largest wins available there, they are mechanical, and at ~96 cells they
   are not nothing during a rearrangement on a phone either.
6. Everything else as appetite allows.

§3.5 (dpr during motion) is the wildcard: potentially the biggest single win for
the exact symptom, but it interacts with level selection (§3.1) in a way that
wants both designed together, so it is not a good first move.

**If the dropped frames are reported on a phone rather than a desktop, reorder
this list.** §1's table shows a portrait phone drawing ~96 cells during a
rearrangement against a desktop's ~48 — twice the per-cell work on a fraction of
the CPU and memory bandwidth, and with the tightest limits on the 48 MB textures
§3.1 is about. On that hardware §4's per-cell family and §3.5's fill-rate
argument both move up sharply, and §3.1's preloading option moves *down* (510 MB
resident is a far worse trade on a phone than on a desktop). Establishing which
device the symptom is on is therefore worth doing before anything in §2.
