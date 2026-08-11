# The Indexing of Babel — implementation plan

A sketch of how to get from [`concept.md`](../concept.md) to a working thing,
with the decisions that have to be made early called out as decisions.

---

## 1. The load-bearing idea

The whole project rests on one constraint that is easy to state and easy to
violate: **any room must abut any other room, in all four directions, with no
visible join.** Everything else — the variant corpus, the curation pass, the
pan-and-zoom map, the CLIP re-ordering — is ordinary work. Seamlessness across
thousands of independently generated images is not, and it gets harder, not
easier, the later it is addressed. A corpus of five thousand beautiful rooms
that don't quite line up is unsalvageable.

So the first thing built is not the base image. It is the *contract* the base
image and all its variants have to satisfy.

### The contract

The tile carries a border band that every room reproduces exactly. Inside that
band, a room may be anything. The band is authored as a **straddle**: the
hallway is drawn once at its full width in its own coordinate space, then
painted onto the tile in two halves with the halves swapped — the band's right
half goes on the tile's left edge, its left half on the tile's right edge. When
two tiles meet, those halves reassemble into the single corridor that was
originally drawn. Continuity is then automatic for *any* content the band
happens to contain, rather than being something an artist has to hit by eye.

The floor/ceiling slab works the same way on the vertical axis. The four
corners, where the two bands would contradict each other, are a flat constant
fill.

This is the part worth being fussy about, and it is machine-checked:

```
$ npm run verify:seams
  ok  hallway band reassembles across a vertical join (149248 px)
  ok  slab band reassembles across a horizontal join (149248 px)
  ok  corners are constant fill
all seam invariants hold
```

The verifier rasterizes the tile and asserts that its edge strips are
pixel-identical to the independently rendered band. It should stay in CI, and it
should be extended to run over generated variants, where it becomes the gate
that decides whether a Stable Diffusion output is admissible at all.

---

## 2. What exists now

A **placeholder** base room, generated programmatically, carrying the numbers
from the story exactly: 4 shelved sides × 5 shelves × 32 books = 640 books, two
lamps transversally placed, the central air shaft with its low railing, and the
hallway with its mirror, its two closets and its spiral stairway.

![the hexagon, unrolled](figures/hexagon-plan.svg)

```
npm install
npm run generate:base -- --size 1024 --seed 1941
npm run verify:seams
```

Output in `assets/base-room/`:

| File | What it is for |
| --- | --- |
| `base-room.png` / `.svg` | The placeholder itself |
| `base-room-lineart.png` | ControlNet structure conditioning (canny/lineart/scribble) |
| `base-room-depth.png` | ControlNet depth conditioning |
| `seam-mask.png` | White = must not change. The inpainting "keep" mask |
| `band-hallway.png`, `band-slab.png` | The two straddle bands, as authored |
| `tiled-3x3.png` | Nine copies, for looking at the joins |
| `room-geometry.json` | Every rectangle, normalised 0–1, for the web app |

`room-geometry.json` is the interesting one. It carries all 640 book slots
addressable as bay/shelf/index, plus named UI anchors. That is what step 6 of
the concept needs: putting a previous search term on a book spine means writing
to `bays[1].shelves[2].slots[n]`, and making it clickable means hit-testing the
same rectangle. The image and the interaction layer stay in sync because they
are generated from one source.

**The placeholder is a diagram, not art.** It is a flat unrolled elevation, and
it looks like one. Its job is to let phases 3–6 be built and the seam contract
be proven before a single diffusion model is loaded.

---

## 3. Phases

### Phase 0 — the real base image *(concept step 1)*

Replace the placeholder with the photorealistic room, conforming to the same
seam geometry. The practical route:

1. Model the gallery in Blender (an afternoon's work — it is six flat walls,
   shelving, two spheres and a stair) and render it with the same projection the
   placeholder uses.
2. Render the seam bands as separate passes so they can be composited in
   straddle form, guaranteeing the contract rather than hoping for it.
3. Run `verify:seams` against the result.

Blender is the recommendation over "generate the base with SD and hope": the
base room is the one image in the project that has to be geometrically exact,
and it is the one image that gets used tens of thousands of times.

### Phase 0.5 — a synthetic corpus *(no equivalent in concept.md, and that is the point)*

Before generating anything real, extend the generator with palette and
proportion variation and emit ~500 procedurally distinct rooms. They will be
ugly. They will also be enough to build and profile the entire display
application, and to find the map bugs while the fix is still cheap. Throw them
away afterwards.

### Phase 1 — variant generation *(concept step 2)*

Out of scope for this repo per `concept.md`, but the interface is in scope:

- **Conditioning**: `base-room-lineart.png` and `base-room-depth.png` into
  ControlNet; `seam-mask.png` as the inpaint keep-mask so the bands survive.
- **Inpainting over img2img.** Masked inpainting with the seam locked is the
  only approach that makes the contract structural. img2img at any meaningful
  denoise strength will drift the borders.
- **Admission gate**: every output runs through `verify:seams` with a small
  per-pixel tolerance (JPEG/VAE round-tripping will not be bit-exact — a
  tolerance of ~2/255 is realistic). Anything that fails is regenerated, not
  hand-fixed.
- **Provenance**: each room writes a sidecar record — prompt, seed, model hash,
  ControlNet weights, timestamp. Ten thousand rooms with no provenance is an
  unnavigable pile.

### Phase 2 — curation *(concept step 3)*

A local-only review tool, not part of the public app: keyboard-driven, one room
at a time, `1–5` to score, free-text tags, `x` to reject. Writes to the same
SQLite database the pipeline writes to. Budget roughly 2–3 seconds per room;
five thousand rooms is a few evenings, which is the real reason to be ruthless
about corpus size.

Add perceptual-hash dedup before review — diffusion corpora contain more
near-duplicates than expected, and reviewing them twice is wasted time.

### Phase 3 — the display map *(concept step 4)*

The heart of the app.

- **Rendering**: a virtualized canvas drawing only visible tiles. At 1024px
  rooms and a 1920×1080 viewport, that is 4–12 tiles at any moment. Plain
  Canvas2D is sufficient; WebGL/Pixi is available if zoom-out reveals it isn't.
  Do *not* mount thousands of DOM nodes.
- **Levels of detail**: ship each room at 256 / 512 / 1024. Zoomed out, the
  256px mips are what load, and they are ~15 KB each.
- **Ordering**: a pure function `(rank, seed) → grid cell`. Reserve a scattered
  ~20% of cells as *content slots* (chosen by a seeded hash of the coordinate,
  so it is stable and needs no storage); every other cell is the base room.
  Sort content slots by distance from the origin and fill them in rank order.
  Re-ordering after a search is then a re-index, not a data reload.
- **Edge resistance**: rubber-band damping on pan velocity beyond a radius
  derived from the content-slot count, so the user is discouraged rather than
  walled. Hard clamping would break the illusion the resistance exists to
  protect.

### Phase 4 — search *(concept step 5)*

The concept treats the CLIP backend as an open cost question. It mostly isn't
one, because the expensive half can be precomputed:

- **Image embeddings are computed offline**, once, during phase 1, and shipped
  as a binary blob. Five thousand rooms × 512 dims × int8 = **2.5 MB**,
  quantized from float32 with negligible ranking loss.
- **Ranking runs in the browser**: one dot product per room against the query
  vector. Five thousand of them is well under a frame.
- **Only the text tower needs to run at request time**, on a text string.
  That's a tiny stateless endpoint (or `transformers.js` in-browser if the model
  download is acceptable).

So there is no CLIP *service* to pay for in steady state — just an occasional
text-encode call. That materially changes the hosting question in phase 6.

### Phase 5 — the controls in the centre room *(concept step 6)*

All of these bind to anchors already present in `room-geometry.json`:
`searchField`, `submitButton`, `generateButton`, `shuffleLamp`,
`historySpines`, `scoreSortSpines`. Implement as transparent hit regions
positioned by the same transform that draws the centre tile, with the visible
affordance painted into the room art.

Search-term spines need text composited onto the spine rectangles at runtime —
a small canvas overlay per spine, rotated to the spine's angle.

The "generate a new room from this term" button is the one with a real cost
attached and the only part of the app that can be abused; it needs a rate limit
and a queue before it is exposed publicly, and it should probably stay behind a
flag until the rest is stable.

---

## 4. Architecture

Following `concept.md`'s stated preference for Node + Express + React.

```
babel-index/
  tools/base-image/        # generator + seam verifier            [exists]
  assets/base-room/        # generated placeholder assets         [exists]
  docs/                    # this, and the story parameters       [exists]
  packages/
    geometry/              # room-geometry.json consumer, shared by app + tools
    pipeline/              # ingest, dedup, embed, admission gate
    curate/                # local-only review tool
    server/                # Express: manifest, text-embed proxy, generate queue
    web/                   # React: map, search, centre-room controls
```

**Data**: SQLite through the pipeline and curation phases — single file, no
service, trivially backed up, and it holds a corpus of this size without
complaint. It only needs to become Postgres if the generate-on-demand feature
goes public with real traffic. The web app never talks to it; it consumes a
static `manifest.json` plus `embeddings.bin`.

```
room: id, path, w, h, seed, prompt, model, controlnet, created_at,
      phash, score (0-5), tags[], status (pending|kept|rejected),
      embedding (blob), seam_check (pass|fail|tolerance)
```

**Hosting**: the app is a static bundle plus one small endpoint. The dominant
cost is image egress, not compute, which argues for **Cloudflare R2 + Pages**
over GCS — R2 charges no egress, and this is a project whose entire cost profile
is "serve a lot of images to whoever wanders in." GCP + Terraform remain the
right answer if the generate-on-demand queue grows into real infrastructure;
they are the wrong answer for a static image map. Worth revisiting once corpus
size is known.

---

## 5. Sequencing

The dependency that matters is that phases 3–6 need *a* corpus but not the
*real* corpus. Build against the synthetic one, and phase 1's expensive GPU time
overlaps with app development instead of blocking it.

| Order | Phase | Blocked by |
| --- | --- | --- |
| 1 | Seam contract + placeholder | — *(done)* |
| 2 | Synthetic corpus (0.5) | placeholder |
| 3 | Display map (3) | synthetic corpus |
| 4 | Real base image (0) | seam contract |
| 5 | Variant pipeline (1) | real base image |
| 6 | Curation (2) | variant pipeline |
| 7 | Search (4) | display map + any corpus |
| 8 | Centre-room controls (5) | search |

---

## 6. Open questions

These are decisions, not unknowns — they need an answer more than they need
research, and the first one is worth answering before anything else is built on
top of it.

1. **Is the unrolled elevation the right projection?** It is what the
   placeholder implements: the hexagon cut open and laid flat, which makes
   tiling tractable but reads as a diagram rather than a place. The alternative
   is a one-point perspective interior — far more evocative, far more
   photorealistic, and much harder to tile, because a perspective view's edges
   are not a simple repeating band. A middle option is a shallow perspective
   with flattened side walls. **This choice propagates into every other phase**,
   and changing it after the corpus exists means regenerating the corpus.
2. **Square grid or hex grid?** Galleries are hexagonal; the map is currently
   square. A hex grid would be more faithful and would let each gallery have six
   real neighbours, at the cost of a more complicated tile shape and pan model.
3. **How much of each image is locked?** Currently 8.6% per edge. Thicker is
   safer for tiling and leaves less room for a variant to be interesting;
   thinner is the reverse.
4. **Corpus size, and the duplicate ratio.** The concept suggests 80% generic.
   That ratio and the total room count together determine the size of the
   traversable region, the curation effort, and the bandwidth bill.
5. **Does the vertical axis mean "floor above", or just more galleries?** The
   placeholder assumes floors, which is why the slab band is a floor/ceiling
   assembly. Treating vertical neighbours as ordinary galleries would simplify
   the slab into a wall.
6. **Does the generate-on-demand button ship publicly?** It is the only
   unbounded cost in the project.
