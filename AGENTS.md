# AGENTS.md

Notes for coding agents working in this repo. Human-facing docs are
[`README.md`](README.md) (how to run it), [`concept.md`](concept.md) (what it is
meant to become), and [`docs/implementation-plan.md`](docs/implementation-plan.md)
(how it gets there, and what is next).

## What this is

An AI art experiment based on the Library of Babel: a pannable, zoomable map of
generated library rooms. One tile is **one shelved wall** — 5 shelves × 32 books
= 160 books, four tiles to a gallery's 640. Variant images come from an external
inpainting pipeline that is out of scope for this repo; what lives here is the
map, the tile geometry, and an offline demo that needs nothing but a directory of
images.

## Commands

```sh
npm install
npm run demo                       # http://localhost:5173, against assets/corpus-sample/
npm run demo -- --images <dir> [--base base.jpg] [--port 5173]
npm test                           # node --test, ~1s, no browser and no network
npm run test:e2e                   # browser smoke test; needs `npx playwright install chromium` once
npm run generate:mips -- --images <dir>    # write the resolution pyramid, in place
npm run generate:tile -- --base <image>   # draw the measured geometry over a real image
npm run generate:figures                  # regenerate docs/figures/
node tools/cost-model/report.mjs          # hosting cost model; see docs/hosting-costs.md
node tools/base-image/import-shelf-svg.mjs tools/base-image/shelf_geometry.svg
```

There is no build step, no bundler config and no linter. The demo server bundles
the client with esbuild in-process at startup (`packages/server/index.mjs`), so
editing web sources means restarting `npm run demo` — except `index.html`, which
is read per request.

## Layout

| | |
| --- | --- |
| `packages/server/` | demo server: `index.mjs` is the CLI, `app.mjs` the four routes, `scan.mjs` the directory scan |
| `packages/web/` | React + canvas map; `camera.js` is pure maths, `useMapCamera.js` the pointer plumbing, `tiles.js` the image cache, `pyramid.js` the resolution policy |
| `packages/map/ordering.js` | slot placement, ranking, pan resistance — no DOM, no imports |
| `packages/pipeline/` | the pyramid generator: `index.mjs` is the CLI, `mips.mjs` the resizing |
| `tools/base-image/` | tile geometry, the SVG importer, the placeholder renderer, the overlay |
| `tools/cost-model/` | what hosting costs: replays camera paths, counts requests |
| `assets/base-tile/` | generated geometry + placeholder art |
| `assets/corpus-sample/` | 25 rooms + a generic, so the demo needs no setup |
| `assets/blender/` | the base render source; nothing reads it |
| `docs/borges-parameters.md` | every number from the story, with the passage it comes from |

## Conventions

- **ESM everywhere** (`"type": "module"`). `.mjs` for anything Node runs directly
  (servers, tools, tests), `.js` for modules the browser bundles, `.jsx` for
  React. Node built-ins are imported with the `node:` prefix.
- **Node 20 is the floor** (`engines`), and CI runs 20/22/24. No TypeScript, and
  no dependency should be added without a reason that survives the question "can
  this be twenty lines instead?" — the dependency list is deliberately short.
- **Tests sit next to the code** as `*.test.mjs` and use `node:test` +
  `node:assert/strict`. `node --test` discovers them, so a new file needs no
  wiring. The e2e file is `*.e2e.mjs` precisely so it stays outside that pattern.
- **Fixtures are synthesised, not committed.** `packages/server/image-fixtures.mjs`
  builds PNG/JPEG/WebP headers byte by byte. Don't make tests depend on
  `assets/corpus-sample/` staying exactly what it is.
- **Comments explain why, not what.** Files open with a block comment saying what
  the file is for and which decision it embodies. Prose comments use ASCII
  hyphens; markdown uses em dashes. Match the surrounding density rather than
  adding a comment per line.
- Two-space indent, semicolons, single quotes, trailing commas in multi-line
  literals. Just follow the file you're in.

## Things that will bite you

- **`tools/base-image/lib/measured.js` is generated.** Never hand-edit it. Change
  the Blender render, re-trace in Inkscape, re-run `import-shelf-svg.mjs`, then
  `npm run generate:tile` and `npm test`. The importer fails loudly if the trace
  stops agreeing with the story (wrong shelf count, uneven book counts, spines
  outside every bay).
- **Changing the tile's aspect is two edits, not one.** `BASE_TILE` and the
  `viewBox` of `shelf_geometry.svg` are two statements of the same fact, and
  measured coords are normalised against the traced width and height separately —
  so if they disagree, every rect is stretched onto art it no longer matches and
  the books stop landing on the books. The trace now records its own aspect and
  `geometry.test.mjs` asserts the two agree, so doing one and forgetting the
  other fails the suite with both numbers in the message. Re-trace, re-import,
  then update `BASE_TILE`.
- **The lamp is a circle and stays one.** It is the single thing in
  `geometry.js` deliberately not stretched with the tile: one scalar radius
  scaled by *width* on both axes, never an `rx`/`ry` pair. Everything else is
  part of the wall and does follow the tile's shape. Both halves are asserted.
- **Don't pin art choices in tests.** Shelf spacing, book width and how much of a
  board shows are free to move. What the tests assert is the story's invariants
  (5 × 32 = 160, books inside the opening, books resting on their board) — keep
  it that way.
- **Corpus size and generic ratio are runtime parameters**, arguments to
  `createLayout()`, not build-time settings. Growing the corpus must keep
  existing slots where they are and append further out; that property is what
  makes the sliders usable and it is asserted in `ordering.test.mjs`.
- **Re-ranking swaps one array.** Slot positions never move, so a search reads as
  the library rearranging itself. Don't recompute placement on search.
- **The map is virtualized canvas.** Do not mount thousands of DOM nodes.
- **Every pyramid number lives in `packages/web/src/pyramid.js`** — the tile's
  dimensions, the ladder, per-level cache budgets, the hysteresis band, the
  prefetch ring. Don't reintroduce one as a literal in `tiles.js` or the render
  loop; those read the policy, they don't restate it. The three rules it exists
  to serve, in the order they win: a cell never fails to display, cells load
  slightly before they are needed, hold rather than refetch. Per-level LRU is
  load-bearing for the first — one global LRU lets a zoom-in evict the coarse
  field the fallback depends on.
- **The tile size and shape are not settled.** `BASE_TILE` is the only place
  either is stated and the ladder is divisors of it, so every size, byte cost and
  level choice is derived — don't compute one from a literal, and don't assume
  square. The tests run the policy at four aspects and will tell you what a new
  shape breaks (a rung outside the camera's clamp, a budget below one screen).
- **The world's base unit is the cell, and a cell is not square.** World
  coordinates are in cells; `zoom` is pixels per cell *width* and `pxPerCell()`
  in `camera.js` is the only place the height is derived from it. Never write
  `zoom` for both axes — that is the bug this replaced. Cameras carry an optional
  `aspect`, so anything constructing one must spread the old camera rather than
  rebuilding `{x, y, zoom}` from scratch, or the shape is lost mid-gesture.
- **`packages/map` measures distance as it looks, not as it indexes.** It is
  shape-blind except for one injected `aspect`, and every distance in it is
  `cellDistance()` — `hypot(x, y * aspect)`, i.e. cell *widths*. That makes the
  library round on screen and the edge the same distance away whichever way you
  drag. Placement uses the same metric and has to: a circular boundary around an
  elliptical spread of rooms is a circle with nothing in the top and bottom of
  it. If you add a distance anywhere in that file, it goes through
  `cellDistance` — a raw `Math.hypot(x, y)` is the bug. `aspect` defaults to 1,
  so the module still needs no imports and a square cell behaves exactly as
  before.
- **The centre room is cell (0, 0)** and is reserved — `packages/map` never
  assigns a corpus room there. Only that room needs exact per-book geometry;
  every other room needs only a bounding box, because inpainting doesn't preserve
  shelf counts.
- **e2e is not a merge gate.** `ci.yml` runs `npm test` on every push and PR to
  `main` and is the single required check; `e2e.yml` is manual dispatch only. Run
  the smoke test yourself when the map itself changed.
- A green e2e test that cannot fail is worse than none. If you change it, break
  the app on purpose and confirm it fails.

## Next up

`docs/implementation-plan.md` §8 holds the ordered queue, and §7 the open
questions. Keep both current: when a step lands, move it out of §8 and fold what
was learned into the relevant phase section, so the plan stays the thing you can
read to know where the project is.
