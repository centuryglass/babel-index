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

Then open <http://localhost:5173>. It runs against the 25-room sample in
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

Search is stubbed offline — it returns a deterministic pseudo-ranking so the
mechanic (type a term, watch the library rearrange around the centre) works
without a model. The UI says so rather than implying the results mean anything.

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
spines outside every bay. To check the result against a real image:

```sh
npm run generate:tile -- --base assets/corpus-sample/000.jpg
```

which draws every measured rectangle over it.

| | |
| --- | --- |
| `packages/server/` | offline demo server: scans a directory, serves a manifest |
| `packages/web/` | canvas map — pan, zoom, live layout controls |
| `packages/map/ordering.js` | slot placement, ranking, pan resistance |
| `tools/base-image/` | tile geometry, importer, placeholder, overlay |
| `assets/blender/` | the base render source |
| `docs/borges-parameters.md` | every number, with the passage it comes from |

```sh
npm test    # 99 tests, no browser and no network
```

`node --test` discovers `*.test.mjs`, so a new test file needs no wiring.
Covered: the map layout, the measured geometry, the directory scan and its
header parsers, the server API, the camera maths, the tile cache and the
resolution-pyramid policy. Image fixtures are synthesised per test, so nothing
depends on `assets/corpus-sample/` staying exactly what it is, and the pyramid's
rules are checked at four tile shapes so none of them assumes a square.

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
