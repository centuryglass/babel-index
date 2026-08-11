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
| `tools/base-image/` | tile geometry, SVG importer, placeholder, overlay |
| `assets/blender/babel_shelf.blend` | the base render source |
| `assets/corpus-sample/` | 25 rooms + a generic, so the demo needs no setup |
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

The proportions are expected to move — the current shelf feels cramped. The
trace is the interface, so a change is a three-step loop and touches no code:

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

Rendering: a virtualized canvas drawing only visible tiles. Do not mount
thousands of DOM nodes.

#### Resolution pyramid — the next thing to build

The demo loads full-resolution images at every zoom, and that is the ceiling it
will hit first. Zoomed out it draws ~1660 visible cells; at 1024², decoded RGBA
is 4 MB per image, so a viewport that holds the whole content region wants
several gigabytes of decoded bitmap. It survives at 511 rooms only because the
cache is capped at 240 entries and the browser discards aggressively — at a
truly absurd corpus it will thrash, then fail.

The fix is a pyramid, generated once in the pipeline:

| Level | Size | ~bytes decoded | Used when |
| --- | --- | --- | --- |
| 0 | 1024 | 4 MB | zoom > 512 px/tile — reading one room |
| 1 | 512 | 1 MB | zoom 192–512 |
| 2 | 256 | 256 KB | zoom 64–192 |
| 3 | 128 | 64 KB | zoom 24–64 |
| 4 | 64 | 16 KB | zoom < 24 — the far-out field |

Picking the level from `zoom` (device-pixel-adjusted, one level of hysteresis so
a slow zoom doesn't oscillate across a boundary) keeps decoded bytes per screen
roughly constant no matter how far out the camera goes — which is the property
that makes corpus size stop mattering for rendering cost.

Consequences to design for now rather than retrofit:

- **The cache key becomes `(id, level)`**, not `url`. `packages/web/src/tiles.js`
  already isolates this; it is the only file that needs to know.
- **Draw the coarse level while a finer one loads.** Holding the already-cached
  coarser tile avoids the blank-cell flash on every zoom step.
- **Offline mode needs a layout convention** — `rooms/<level>/<file>` is enough,
  with `scan.mjs` discovering which levels exist and falling back to whatever it
  finds. That keeps "point it at a directory" true.
- **Generating the pyramid is a pipeline job**, not a server job. A `--mips` flag
  on the ingest tool that writes the smaller levels once.
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

17 tests exist (`npm test`): map ordering, and the measured geometry. That
covers the two places where a silent wrong answer would be expensive — the map
layout, whose bugs look like "the library feels off", and the trace, whose bugs
put hit regions on the wrong books. The gaps are everything else.

What to add, roughly in order of how much grief it saves:

**`scan.mjs` — pure functions over fixtures.** The header parsers are exactly
the kind of code that is silently wrong: a truncated JPEG, a WebP in each of its
three flavours (VP8/VP8L/VP8X), a PNG. Plus the directory rules — base picked by
`--base`, by a file called `base.*`, by falling back to the first file; the base
excluded from the ranked corpus; ids stable across restarts, since the map's
slot assignment is keyed on them; an empty directory failing usefully. Small
committed fixtures, a handful of assertions.

**The server API.** `/api/manifest` shape, `/api/search` determinism (same query
returns the same order, different queries do not), empty query clearing the
order, `/images` refusing to escape the images directory. No browser needed.

**The camera, as pure functions.** `screenToWorld`/`worldToScreen` round-trip;
zoom-at-cursor keeping the point under the pointer fixed — that one has an exact
invariant and is easy to break. Worth extracting from `useMapCamera.js` so it is
testable without a DOM, which is the main reason to do it.

**Tile cache eviction.** That it respects the budget, that it never evicts an
in-flight load, and — once the pyramid lands — that it keys on `(id, level)` and
retains a coarse level while a finer one loads.

**End-to-end, in a browser.** The drive script used to validate this build
should become a committed Playwright test rather than living in a scratch
directory: load, pan, zoom, move both sliders and assert the boundary radius
responds, run a search, assert no console errors. It is the only layer that
catches "the canvas renders nothing" — which no unit test will.

Two things worth doing regardless of coverage:

- **A test for the render loop's cost**, not just its correctness: assert that a
  zoomed-out frame requests no more than N images. That is the regression that
  the resolution pyramid exists to prevent, and it will silently come back.
- **Fixtures over the real corpus.** Tests should not depend on
  `assets/corpus-sample/` staying exactly 25 images; generate throwaway images
  in a temp directory instead.

Not worth testing: the placeholder renderer's appearance, and anything that
pins an art choice rather than an invariant.

---

## 4. Architecture

```
babel-index/
  tools/base-image/        # tile geometry, placeholder, overlay      [exists]
  packages/map/            # slot placement, ranking, resistance      [exists]
  assets/base-tile/        # generated geometry + placeholder         [exists]
  docs/                                                              [exists]
  packages/
    pipeline/              # ingest, dedup, embed, border-drift score
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

## 7. Still open

1. **The Blender base render as an image file.** The `.blend` is in the repo but
   a render is not, so the demo currently uses corpus image `000.jpg` as the
   generic room. That is the asset the map leans on hardest — it is ~80% of
   every screen.
2. **Corpus hosting.** Settled in principle: a sample stays in the repo
   (`assets/corpus-sample/`, 25 rooms, 1.4 MB), the rest lives elsewhere. The
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
6. **Shelf proportions feel cramped** and are expected to change. The loop for
   that is in [§2](#changing-the-geometry) and touches no code.

---

## 8. Next session

In dependency order, shortest path to a demo that survives a real corpus:

1. **Resolution pyramid** — pipeline flag to write the levels, `scan.mjs` to
   discover them, `tiles.js` to key on `(id, level)`. The rendering ceiling.
2. **Animated camera moves**, and extract the camera maths so it can be tested.
3. **Test coverage per [§3a](#3a-testing)**, starting with `scan.mjs` fixtures
   and the Playwright smoke test.
4. **Re-trace the geometry** once the shelf proportions are settled.
5. **A real base render** as the generic room, replacing `000.jpg`.
