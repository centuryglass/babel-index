# babel-index

An AI art experiment based around the Library of Babel.

See [`concept.md`](concept.md) for what this is meant to become, and
[`docs/implementation-plan.md`](docs/implementation-plan.md) for how it gets
there.

## Current state

A programmatically generated **placeholder base room**, built to the parameters
Borges actually specifies (640 books over 20 shelves, two lamps, the hallway
with its mirror, closets and spiral stairway, the central air shaft), and the
machine-checked seam contract that lets any room tile against any other.

```sh
npm install
npm run generate:base      # writes assets/base-room/
npm run verify:seams       # asserts the tiling is seamless
```

| | |
| --- | --- |
| `assets/base-room/base-room.png` | the placeholder |
| `assets/base-room/tiled-3x3.png` | nine copies, to inspect the joins |
| `assets/base-room/seam-mask.png` | the region variant rooms must not repaint |
| `assets/base-room/room-geometry.json` | every rectangle, for the web app |

Options: `npm run generate:base -- --size 2048 --seed 1941 --out assets/base-room`

The placeholder is a diagram, not art — it exists so the display application and
the generation pipeline can be built and validated before any diffusion model is
involved. See [`docs/borges-parameters.md`](docs/borges-parameters.md) for the
source passages behind every number in it.
