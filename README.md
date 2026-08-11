# babel-index

An AI art experiment based around the Library of Babel.

See [`concept.md`](concept.md) for what this is meant to become, and
[`docs/implementation-plan.md`](docs/implementation-plan.md) for how it gets
there.

## What a tile is

One tile is **one shelved wall** in shallow perspective — not a whole room.
Built to Borges' numbers: 5 shelves × 32 books = 160 books per tile, four tiles
to a gallery's 640.

![what a tile is](docs/figures/hexagon-plan.svg)

Tiling needs no special machinery: every variant is inpainted from the same base
render with an edge-clear mask, so the frame is common to all of them by
construction.

## Current state

```sh
npm install
npm run generate:tile      # placeholder tile + tile-geometry.json
npm test                   # map ordering
```

| | |
| --- | --- |
| `packages/map/ordering.js` | slot placement, ranking, pan resistance — corpus size and generic ratio are runtime parameters |
| `tools/base-image/` | tile geometry, placeholder renderer, geometry overlay |
| `assets/base-tile/tile-geometry.json` | shelf and book-slot rectangles, UI anchors |
| `docs/borges-parameters.md` | every number, with the passage it comes from |

### Checking the geometry against the real render

The proportions in `tools/base-image/lib/geometry.js` were measured by eye off
the Blender render and are provisional. To correct them:

```sh
npm run generate:tile -- --base path/to/base-render.png
```

This draws the frame, case, shelf boards and all 32 book slots per shelf over
the real image, so misalignment is visible. Only the centre room — the one
carrying the search box and hidden controls — needs these to be exact.
