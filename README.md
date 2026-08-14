# babel-index

An AI art experiment based around the Library of Babel.

See [`concept.md`](concept.md) for what this is meant to become, and
[`docs/implementation-plan.md`](docs/implementation-plan.md) for how it gets
there.

## The demo

```sh
npm install
npm run demo
```

Then open <http://localhost:5173>. It runs against the 26-room sample in
`assets/corpus-sample/` with no further setup. Point it at a bigger corpus with:

```sh
npm run demo -- --images /path/to/rooms [--base base.jpg] [--port 5173]
```

Offline mode is just a directory of images — no database, no bucket, no upload
step. Drag to pan, scroll to zoom, and the edge of the content region resists.

**Rooms on the map** and **non-generic %** are live controls: both re-derive the
layout without reloading any image data, so the feel of the thing can be tuned
by dragging a slider. Growing the corpus keeps existing rooms where they are and
adds further out, so the map doesn't reshuffle underneath you.

Search is real when the corpus has an embedding blob. `tools/embed` runs the
CLIP image tower over the rooms once, offline; the demo server runs only the
text tower per query and returns a vector, and the browser ranks against the
blob (so a re-rank costs no round trip). The sample corpus ships with a blob, so
`npm run demo` searches for real. Point it at a directory that has never been
embedded and search falls back to a deterministic pseudo-ranking — the mechanic
(type a term, watch the library rearrange around the centre) still works, and
the UI says so rather than implying the results mean anything.

## What a tile is

One tile is **one shelved wall** in shallow perspective — not a whole room. 5
shelves × 32 books = 160 books per tile, four tiles to a gallery's 640.

![what a tile is](docs/figures/hexagon-plan.svg)

Tiling needs no special machinery: every variant is inpainted from the same base
render with an edge-clear mask, so the frame is common to all of them by
construction.

## Tile geometry

The opening, the case uprights, all five shelf boards, **all 160 book
rectangles** and the lamp are traced off the Blender render in Inkscape and
imported:

```sh
node tools/base-image/import-shelf-svg.mjs tools/base-image/shelf_geometry.svg
```

That writes `tools/base-image/lib/measured.js`, and the importer fails loudly if
the trace stops agreeing with the story — wrong shelf count, uneven book counts,
spines outside every bay. If the tile's aspect changes, the trace changes with
it: the SVG's `viewBox` and `BASE_TILE` are two statements of one fact, and the
tests fail if they drift apart. To check the result against a real image:

```sh
npm run generate:tile -- --base assets/blender/base_render.png
```

which draws every measured rectangle over it, and writes the result to
`assets/base-tile/`. The committed `geometry-overlay.png` is that command's
output against the render the trace was taken from, so it is the picture to look
at to see whether the geometry still lands on the art.

## The resolution pyramid

Zoomed out the map draws thousands of cells, so it does not draw them at full
resolution. Smaller levels are generated once, offline:

```sh
npm run generate:mips -- --images <dir>          # in place
npm run generate:mips -- --images <dir> --out <dir>
```

That writes `<dir>/<width>/<file>` for every level below the source, leaving the
originals where they are as level 0 — so running it on a corpus adds the smaller
levels and changes nothing that was already there. The ladder, the cache budgets
and the level-picking policy all live in
[`packages/web/src/pyramid.js`](packages/web/src/pyramid.js), which is the file
to edit to tune any of it.

The map uses them: the server reports which levels a corpus actually has, the
cache keys on `(room, level)` with a budget per level, and each frame picks the
smallest tile that is not smaller than the cell it covers. Zoomed right out that
is a 64×48 thumbnail, so a screen of thousands of rooms costs tens of megabytes
instead of tens of gigabytes. A cell never draws nothing: whatever level of that
room is resident stands in until the right one arrives, and the generic room is
pinned as the floor beneath that. **A flat directory still works** — a corpus
with no `<width>/` directories simply has one level, and everything resolves to
it.

`assets/corpus-sample/` ships with all five levels generated, so the demo shows
this without setup.

The tile is 1024×768 today, and neither the size nor the shape is fixed.
`BASE_TILE` is the only place either is stated; everything else derives from it,
and the tests will tell you what a new shape breaks. The library stays **round
on screen** at any cell shape rather than round in the index, so the edge is the
same distance away whichever way you drag.

| | |
| --- | --- |
| `packages/server/` | offline demo server: scans a directory, serves a manifest |
| `packages/web/` | canvas map — pan, zoom, live layout controls |
| `packages/map/ordering.js` | slot placement, ranking, pan resistance |
| `packages/pipeline/` | the resolution-pyramid generator |
| `tools/base-image/` | tile geometry, importer, placeholder, overlay |
| `assets/blender/` | the base render source |
| `docs/borges-parameters.md` | every number, with the passage it comes from |

```sh
npm test    # 165 tests, no browser and no network
```

`node --test` discovers `*.test.mjs`, so a new test file needs no wiring.
Covered: the map layout, the measured geometry, the directory scan and its
level discovery, the server API, the camera maths, the tile cache, the render
loop (including what a zoomed-out frame costs in bytes), the resolution-pyramid
policy and the pyramid generator. Image fixtures are
synthesised per test, so nothing depends on `assets/corpus-sample/` staying
exactly what it is. The camera, the pyramid and the map layout are each
exercised at several tile shapes, so none of them assumes a square.

Every push and every pull request to `main` runs the suite on Node 20, 22 and 24
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)); `ci` is the single
check to require for merging.

The canvas is covered separately, by a browser smoke test that drives the real
demo server — load, pan, zoom, both sliders, a search, no console errors, and
that the canvas is actually painted rather than merely present:

```sh
npx playwright install chromium   # once
npm run test:e2e
```

It is not in `npm test` and not in the pull-request job: a browser is more
machinery than every push deserves. Run it when the map itself changed, or from
the Actions tab — [`e2e.yml`](.github/workflows/e2e.yml) is manual-dispatch only
and uploads the last frame as an artifact. See
[the testing section](docs/implementation-plan.md#3a-testing) for what each
layer is for.
