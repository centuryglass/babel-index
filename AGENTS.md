# AGENTS.md

Notes for coding agents working in this repo. Human-facing docs are
[`README.md`](README.md) (how to run it), [`concept.md`](concept.md) (what it is
meant to become), and [`docs/implementation-plan.md`](docs/implementation-plan.md)
(how it gets there, and what is next).

## What this is

An AI art experiment loosely based on the Library of Babel: a pannable,
zoomable map of generated library rooms. One tile is **one shelved wall**.
Tile variations are generated via an external inpainting pipeline, and paired
with style keywords used for generation and a brief story text based on the
image and keywords.

Tiles can be searched, with CLIP embeddings, keyword matching, and story
matching used to calculate ranking and match certainty for all tiles. A set of
generic "default" tiles are mixed in with the unique ones, with their
distribution adjusted during searches so they serve as way to visibly gauge
search certainty. Diegetic controls for the search interface are embedded into
the center tile, placed using geometry calculated from a reference SVG.

An alternate catalog interface can be used to maximize discoverability. This
interface swaps the map and  diegetic interface for a more conventional web
search UI and linear tile list.

## Commands

```sh
npm run demo                       # http://localhost:5173, against assets/corpus-sample/
npm run demo -- --images <dir> [--center center.jpg] [--shared-dir assets] [--port 5173] [--config config.json] [--base-path /babel-index/]
npm test                           # node --test, ~1s, no browser and no network
npm run test:e2e                   # browser smoke test; needs `npx playwright install chromium` once
npm run lint                       # config in eslint.config.js
npm run typecheck                  # tsc --noEmit -p jsconfig.json, checkJs over the JSDoc
npm run generate:mips -- --images <dir>    # write the resolution pyramid in place
node tools/center-placement/import-shelf-svg.ts tools/center-placement/shelf_geometry.svg  # Recalculate diegetic control bounds
```

No compiled output ever hits disk. The demo server bundles the client with
esbuild in-process at startup (`packages/server/index.ts`), so editing web
sources means restarting `npm run demo`. Demo run will fail if its port is in
use.

Every `npm run` script that invokes `node` directly passes
`--import ./build/register.mjs` (see `build/ts-loader.mjs`) so `.ts`/`.tsx`
sources run exactly like `.mjs`/`.jsx` - no separate compile step, no `dist/`
to keep in sync with the tree Layout describes below. It hooks Node's ESM
loader and runs every `.ts`/`.tsx` module through `esbuild`'s `transform` in
memory, once per process per module - this is what makes a full TypeScript
migration possible on the Node 20 floor (`engines`), which cannot run `.ts`
natively (type-stripping is Node 22.6+ experimental, 23.6+ default). Calling a
script directly with plain `node` instead of through `npm run` skips the hook
and fails to import any `.ts` file with `ERR_UNKNOWN_FILE_EXTENSION`.

Linting is minimal:
- The usual recommended JS rules
- Browser globals scoped to `packages/web/src/**/*.{js,jsx}
- Node globals scoped to `**/*.mjs`
- From `eslint-plugin-react-hooks`, only `rules-of-hooks`, `exhaustive-deps`,
  as recommended rules bundled in v7 disagree with how we use refs.

## Layout
**This map is part of the change.** A file added, removed or renamed here is
not done until this list says so - the list is how anyone (or anything) finds
its way around the tree, and one silently missing entry is how a module gets
written twice.

Tests and test helpers not listed, assume each appropriate file is paired with
a corresponding {name}.test.mjs within the same directory. Playwright tests
are in `packages/web/e2e`. Anything under `reference` is only used with the
inpainting pipeline, and isn't touched anywhere else in the project.

### Build:
- `build`: the Node-side TypeScript hook (see Commands above) - not a bundler,
           nothing here touches `packages/web`'s client bundle
  * `register.mjs`: what every `node`-invoking npm script passes to `--import`
  * `ts-loader.mjs`: the ESM `load` hook that runs `.ts`/`.tsx` through
                     esbuild's `transform` in memory

### Client/Server code:
- `packages/server`: the demo server
  * `index.ts`: CLI
  * `app.ts`: Express setup, manifest/rescan/search/images endpoints
  * `scan.ts`: Image tile directory loading
  * `remote.ts`: Reading a corpus manifest from a remote host (R2/Cloudflare)
                 instead of a local directory
  * `port.ts`: portInUse helper function
  * `search-cache.ts`: LRU cache and concurrency limiter backing `/api/search`'s
                        CLIP text tower calls
  * `image-fixtures.ts`: Synthetic image headers for testing scan.ts's parsers
  * `base-path.ts`: Normalizes `--base-path`, for a subpath deployment behind
                    a prefix-stripping reverse proxy (`server-nginx.conf`)
- `packages/web`: browser-side code (only place DOM is expected). `src/` is laid
  out by React convention - components, hooks, and everything else (`lib/`) -
  rather than by feature area; a hook and the `lib/` module it wraps often
  belong to the same subsystem (`useMapCamera.ts` / `lib/camera.ts`,
  `useRearrangement.ts` / `lib/slide.ts`) without living in the same directory.
    * `index.html`: HTML entry point, static page structure
    * `src/main.tsx`: React entry point - loads the corpus, derives the layout
                      from the search, wires the hooks below together, renders
                      the map and catalog views. The only file at `src/` top level.
    * `src/assets.d.ts`: Declares the `.svg` import shape esbuild's
                         `loader: { '.svg': 'text' }` produces, for `.ts`/`.tsx`
                         files that import one as raw markup
  - `src/components/`: presentational React components
    * `MapView.tsx`: The 2D map canvas view
    * `CatalogView.tsx`: Alternate catalog list view
    * `RoomCard.tsx`: RoomDetails popup, shown on right-click/long press
    * `RoomOverlay.tsx`: Modal showing full-size room image along with story content
    * `RoomDetails.tsx`: Show room tile keywords, story text, search ranking info, alt. text(eventually)
    * `SearchForm.tsx`: Shared search box component
    * `SearchIcon.tsx`: The search badge's glyph and orbiting arrow
    * `HelpDialog.tsx`: The "READ ME" book's dialog
    * `ArtistStatementOverlay.tsx`: The artist's statement dialog, reached by
                                    the open book traced into the center
                                    tile's shelf gap (`CENTER_BOOK_PATH` in
                                    `lib/center.ts`). Ships with placeholder
                                    content; the dialog machinery is what
                                    landed first.
    * `BabelBookOverlay.tsx`: Shows a random book from the Library of Babel, paged.
                             Meant as an easter egg for the (not yet existing)
                             artist statement page, not wired in yet
  - `src/hooks/`: the subsystems `main.tsx` wires together - see
                 `docs/state-architecture-plan.md` §3 for why each exists and
                 what it hides
    * `useCorpus.ts`: Load the metadata sidecar and embedding blob, build the search index
    * `useSearch.ts`: The query box, the `/api/search` fetch, blending the
                      reply into one ranking, the highlight range-finders
    * `useMapCamera.ts`: React hook for camera changes, inputs entangled with
                         camera controls
    * `useMapRenderer.ts`: Map frame loop/redraw hook
    * `useMapCursor.ts`: The keyboard cursor - where it is, what a reader
                         hears about it, and every key over the map
    * `useCenterShelf.ts`: The center room's bookshelf - titles, roving
                           tabindex focus, and what a tap or arrow key does
    * `useModeTransition.ts`: Switching between the map and catalog readings,
                              the FLIP animation between them
    * `useRearrangement.ts`: The sliding-tile rearrangement animation - whether
                             a layout/order change animates, and what gets said
                             once it lands
  - `src/lib/`: pure/DOM-adjacent logic with no JSX - state management,
               geometry, and rendering
    * `center.ts`: Geometry and content management for the center tile interface
    * `camera.ts`: Pure-math mapping functions for the map camera
    * `render.ts`: Render a single map frame
    * `slide.ts`: Room rearrangement animation renderer
    * `picking.ts`: Defines the roomAtPoint function
    * `catalog.ts`: Catalog pagination and geometry helpers
    * `pyramid.ts`: Manage room tile resolution options and cache budgets
    * `tiles.ts`: Load, cache, and unload room images
    * `rooms.js`: Map room data in the manifest to image URLs
    * `persist.js`: Persistent data management (search history, pagination settings)
    * `touchDebug.js`: View touch event stream if `?touchdebug` set
    * `debug.js`: Gates the dev panel behind `?debug`
- `packages/config`: Central definition for numbers tuned by feel
  * `config.ts`: Defaults and validation (no fs)
  * `load.ts`: Load an optional config.json
- `packages/map`: Map and room data handling
  * `ordering.ts`: Room placement, search density gradient, rank by embedding, pan resistance
  * `nextRoom.ts`: Find the next non-default room on the map in a given direction
  * `metadata.ts`: Normalizing and joining per-room keyword/story data
  * `manifest.ts`: The corpus manifest's type contract (`Manifest`,
                   `Room`, `SharedAssets`, `LevelInfo`, ...), type-only
  * `moves.ts`: The rearrangement animation's type contract (`Move` and its
               `shiftRow`/`shiftCol`/`swap` variants, `Board`, `Rearrangement`,
               ...), type-only, shared by `illusion.ts`, `board.ts` and
               `packages/web/src/lib/slide.ts`
  * `scoring.ts`: Find room rank and match certainty for a search, searh tokenization
  * `illusion.ts`: Build a convincing sliding-tile animation for `packages/web/src/lib/slide.ts`
  * `board.ts`: Sliding animation illusion's board data structure
  * `describe.ts`: Build screen reader messages
- `packages/pipeline`: Generates the pyramid of tile images at smaller resolutions for use when zoomed-out
  * `index.ts`: CLI
  * `mips.ts`: Generate+fill alternate image size directories
  * `layout.ts`: Import resolution steps from pyramid.ts, define expected directory structure
  
### Associated tools:
- `tools/center-placement`: Calculate center tile geometry for the diegetic interface
                            from an svg.
  * `import-shelf-svg.ts`: Import Inkscape tile tracing into exact geometry.
  * `shelf_geometry.svg`: Center tile geometry.
  * `lib/geometry.ts`: Book and search box placement structure
  * `lib/measured.ts`: Auto-generated svg geometry data
  * `lib/prng.ts`: RNG utility function currently only used by web/src/lib/center.ts,
                   should probably be moved elsewhere.
  * `lib/svg.ts`: Minimal SVG element builder; currently unused elsewhere.
- `tools/embed/embed.ts`: Compute and store CLIP image embeddings for all rooms.
- `tools/embed/cosine-range.ts`: Measure CLIP's raw cosine range against a real
                                 corpus - the source of `CLIP_CERTAINTY`/
                                 `search.density.clipCentre/clipHigh/clipLow`'s
                                 calibration and of `docs/search_rules.md`'s
                                 thresholds. `--universal`/`--irrelevant` probe
                                 lists measure the high/low extremes;
                                 `--nonsense` validates the centre.
  * `cosine-stats.ts`: Percentile/summary arithmetic and the clipLow/clipHigh
                       and universal-keyword calibration suggestions - pure,
                       unit-tested without a model or a corpus.
- `tools/upload`: Sync a corpus (images, pyramid levels, metadata, embeddings,
                  shared tiles) to Cloudflare R2, incrementally by content hash.
  * `upload-r2.ts`: CLI, credentials from env.
  * `lib.ts`: Pure upload-list/diff logic, no filesystem or network.
- `tools/font-lab`: Ad hoc design-exploration lab for the center shelf's spine
                    titles - not wired into any npm script, not covered by
                    tests. Run directly, e.g.
                    `node --import ./build/register.mjs tools/font-lab/render.ts`.
  * `fonts.ts`: The candidate typefaces and where to fetch them from Google Fonts.
  * `download-fonts.ts`: Fetch each candidate's latin woff2 into `fonts/`.
  * `variants.ts`: The font/settings sweep matrix `render.ts` draws.
  * `render.ts`: Composite each variant onto the real center tile via Playwright
                 Chromium, three zooms to a labelled contact-sheet PNG.
- `tools/curation`: Python/Qt tools for turning a batch of generated tiles
                    into `metadata.json` - keyword extraction, story
                    generation/review, alt text, titles, sensitive-content
                    tagging. Separate ecosystem from the rest of this repo
                    (Python, not Node/TS); has its own nested `AGENTS.md`/
                    `CLAUDE.md` and `README.md` with the real detail - you
                    don't need either unless you're actually working in this
                    directory.

### Infra:
- `infra`: Terraform for the Cloudflare R2 bucket `tools/upload` syncs the
           corpus into, plus abuse-protection (rate limiting, edge caching,
           a billing alert). Applied locally by hand, never from CI -
           credentials live in a gitignored `terraform.tfvars`. See
           `infra/README.md`.

### Assets:
- `assets/center_tile.png`: the center tile at cell (0, 0) containing diegetic
                          search controls.
- `assets/generic`: Non-unique generic "default" tile images.
- `assets/corpus-sample`: Minimal tile set for demo use, with metadata,
                          embeddings, image pyramid, and tag links included.

### Docs:
- `docs/implementation-plan.md`: TODO list, temporary holding place for
                                 ongoing plans
- `docs/accessibility-plan.md`: Keyboard/screen reader plan, mostly complete.
- `docs/state-architecture-plan.md`: How `packages/web/src/main.jsx` gets taken
                                     apart, and what is deliberately left alone.
- `docs/design-history.md`: Record of all the dead ends we went down because
                            of incomplete specifications.
- `docs/search_rules.md`: The full end-state spec of search - parsing, scoring,
                          ranking-vs-certainty, and every reporting rule. The
                          target, not the current code.
- `docs/search-plan.md`: The gap between `search_rules.md` and the code today,
                         and the steps to close it. Delete steps as they land.
  
## Conventions

- **ESM everywhere** (`"type": "module"`). `.mjs` for anything Node runs
  directly, `.js` for modules the browser bundles, `.jsx` for React, `.ts`/
  `.tsx` as the TypeScript equivalent of any of those three (see the
  TypeScript migration note below for how each runs). Import Node built-ins
  with the `node:` prefix, and always give an internal import its real file
  extension (`./port.ts`, not extensionless) - Node's resolver doesn't guess.
- **Node 20 is the floor** (`engines`), and CI runs 20/22/24. Get user
  confirmation before adding dependencies, try to keep dependencies minimal.
- **TypeScript is the default for every new file, full stop.** A new module is
  `.ts`, a new React file is `.tsx`, a new script is a `.ts` run through the
  loader hook (see Commands above) rather than a bare `.mjs` - the same is true
  of new tests (`*.test.ts`, not `*.test.mjs`; the `test` script enumerates both,
  see below). Write `.js`/`.mjs`/`.jsx` only when there is a concrete reason a given
  file can't be `.ts`/`.tsx` yet, not out of habit or to match a neighbor that
  hasn't been converted.

  This is a change from how the migration below started: the file-by-file
  conversion of *existing* code is still exactly as described - no deadline,
  convert something old when you're already in it or it's a good candidate, and
  don't mass-rename working files just to convert them. What's different is new
  code's starting point. `.js`/`.mjs`/`.jsx` and `.ts`/`.tsx` are still expected
  to coexist for a long stretch - the old default doesn't retroactively become
  wrong - but every file added from here on should be TypeScript unless it
  can't be. Two kinds of file so far:
  - **A pure type contract** (`packages/map/manifest.ts`): a `.ts` file
    exporting only `interface`s/`type`s, never imported by a `.js`/`.mjs`/`.jsx`
    file at runtime - only through JSDoc (`@type {import('./manifest.ts').Manifest}`).
    `tsc --noEmit` (`npm run typecheck`) is what checks it.
  - **A real module** (`packages/server/port.ts`): runs at runtime like any
    other source file, through the Node loader hook in `build/` (see
    Commands above) or through esbuild's client bundle in `packages/web`.
    Prefer converting a file outright over leaving new TSDoc-only types on a
    `.js` file once its neighbors are already `.ts` - two type notations for
    one module is the drift this migration exists to remove.

  Good early candidates: files with little duck-typing and a fixed shape
  (`port.ts` was one - one function, two primitive params). Defer files whose
  data is *deliberately* loose until there's a real type worth writing that
  doesn't just paper over the looseness with `any` or a lying assertion. A
  strict type that fights the code's actual tolerance is worse than an honest
  `object`/JSDoc. (`metadata.js`'s sidecar parsing looked like one of these
  until the keyword shape was tightened to `{text, type}` only - dropping the
  plain-string form it used to also accept - at which point `RoomMeta` was
  already a real, fixed shape and converting it cost nothing. `center.ts`'s
  `RUNS` and `slide.ts`'s animation state turned out to be the same story:
  runtime-*computed*, from a traced SVG and a planned move list respectively,
  but not runtime-*loose* - every field they carry is fixed by the code that
  builds them, so both converted cleanly once actually looked at. `scoring.ts`
  was the same story again, and was for a while this bullet's standing example
  of deliberate looseness: `rankHybrid`'s `scored` rows, `breakdown`, `ranks`
  and `ties` only looked duck-typed because nothing had named them, and
  `searchResult.ts` already named every shape crossing the module's boundary
  before the module itself converted.)

  `checkJs` is on (`jsconfig.json`, `npm run typecheck`) as a local signal, not
  yet a CI gate - see `docs/implementation-plan.md` for what it has and hasn't
  caught so far. Writing accurate JSDoc on new `.js`/`.mjs` code is still
  welcome; it's what the next conversion reads from.
- **Tests sit next to the code**, using `node:test` + `node:assert/strict`.
  New tests are `*.test.ts` per the TypeScript-by-default rule above; existing
  `*.test.mjs` files are untouched until something else brings a reason to
  convert them - and converting the module they test to `.ts` is exactly such
  a reason: convert its paired `*.test.mjs` to `*.test.ts` in the same commit
  rather than leaving a `.ts` module with a `.mjs` test beside it. The `test`
  script `find`s both extensions under `packages`/`tools`
  and passes them to `node --test` explicitly: `--test`'s own auto-discovery skips
  `.ts`, and its glob expansion only exists on Node 22+, so on the Node 20 floor a
  bare `'**/*.test.ts'` is taken literally and fails to match. Enumerating the
  files in the shell sidesteps both.
  e2e files are `*.e2e.ts`, intentionally skipping the `*.test.*` pattern.
- **`@huggingface/transformers` is OPTIONAL.** `onnxruntime-node` only supports win32/darwin/linux, testing
  through Android/Termux happens occasionally, and base functionality
  shouldn't require CLIP. Never import it statically, see `tools/embed` and
  `packages/server/app.ts` for dynamic import conventions.
- **`esbuild` is a runtime dependency,** in `dependencies` rather than
  `devDependencies` because `packages/server/index.ts` bundles the client
  at startup (no separate build phase).
- **Fixtures are synthesised, not committed.** `packages/server/image-fixtures.ts`
  builds PNG/JPEG/WebP headers byte by byte. Don't make tests depend on
  `assets/corpus-sample/`.
- **Comments generally explain why, not what.** Files open with a block comment
  saying what the file is for and which decision it embodies. Prose comments use
  ASCII hyphens; markdown uses em dashes. Match the surrounding density rather than
  adding a comment per line. Comments explaining what code is doing might exist
  if human-added, but you should avoid adding them yourself.
- Two-space indent, semicolons, single quotes, trailing commas in multi-line
  literals. Just follow the file you're in.

## Things that will bite you

### Tile geometry

- **`tools/center-placement/lib/measured.ts` is generated.** Never hand-edit it.
  Changes to center-tile geometry are human-managed, parsed with
  `import-shelf-svg.ts`, validated with `npm test`. If tile aspect ratio
  ever changes, the change needs to be applied to `BASE_TILE` in `pyramid.ts`
  and to `shelf_geometry.svg`, then import-shelf-svg should be re-run. 
- **Don't assume tile aspect ratio,** read it from `BASE_TILE`. Aspect ratio
  is unlikely to change often, but if it does, only `BASE_TILE` and the SVG
  should need to be updated.
- **Don't pin art choices in tests.** Shelf spacing, book width, shelf count and
  book count are free to move. Assert only that books stay inside the opening,
  don't overlap, and each shelf has one baseline.
- **Only the center room needs exact geometry.** It is cell (0, 0), reserved by
  `packages/map`, and carries the search box and controls. Other rooms have no
  built-in controls, so they only need bounding boxes.

### The map and its coordinates

- **The world's base unit is the cell, and a cell is not square.** World
  coordinates are in cells; `zoom` is pixels per cell *width* and `pxPerCell()`
  in `camera.ts` is the only place height is derived from it. Never write `zoom`
  for both axes. Cameras carry an optional `aspect`, so anything constructing one
  must spread the old camera rather than rebuilding `{x, y, zoom}`, or the shape
  is lost mid-gesture.
- **`packages/map` measures distance as it looks, not as it indexes.** It is
  shape-blind except for one injected `aspect`, and every distance goes through
  `cellDistance()` — `hypot(x, y * aspect)`, i.e. cell *widths*. That makes the
  library round on screen. A raw `Math.hypot(x, y)` anywhere in that file is the
  bug. Placement uses the same metric and has to: a circular boundary around an
  elliptical spread of rooms is a circle empty at top and bottom. (`aspect`
  defaults to 1, so a square cell behaves as before and the module needs no
  imports. TODO: remove after fixing, square rooms are gone and not coming back.)
- **The center room is cell (0, 0)** and is reserved — `packages/map` never
  assigns a corpus room there.
- **Corpus size and generic ratio are runtime parameters**, arguments to
  `createLayout()`, not build-time settings. Growing the corpus must keep
  existing slots where they are and append further out; that property is what
  makes the sliders usable and is asserted in `ordering.test.mjs`. (TODO:
  I never use the room count slider, I should remove that and update this.)
- **Re-ranking swaps one array; only a search may move slots.** A reorder (the
  shuffle button, a re-sort of the same results) stays a swap of `order` — the
  map rearranges, it does not reload. A search is the one thing allowed to
  rebuild the layout, because its certainty profile is an input to placement;
  that rebuild is the same O(slots) the ratio slider does on every drag. Nothing
  else recomputes placement. (TODO: Do I even want to keep non-search map order?)
- **The map is virtualized canvas.** Do not mount thousands of DOM nodes.

### The center tile and its generic tiles

- **The center and a generic tile are different images, and neither is the
  other.** Cell (0, 0) always draws the blank `center_tile.png` (the `CENTER`
  tile id), reserved for the search box and controls; every generic cell draws
  one of the inpainted generic tiles (`genericId(i)`), never the blank tile.
  `genericId(-1)` is `CENTER`, which is only the fallback for a corpus with no
  generic tiles at all.
- **Which generic tile a cell shows is positional and order-independent, and
  that is load-bearing.** `layout.genericIndexAt(x, y)` is a seeded hash of the
  coordinate alone — a reorder never changes a generic cell's face. That is the
  whole reason `board.ts` and `illusion.ts` still see one interchangeable
  `GENERIC` value and the rearrangement planner did not have to learn about
  individual generic tiles. `roomAt` is unchanged; only the two renderers
  (`render.ts`, `slide.ts`) resolve a cell to a tile id. `slide.ts` reads the
  generic index at each tile's *home* board cell so a sliding line carries its
  own face instead of flipping mid-ride.
- **The shared tiles live outside `--images`.** `scan.mjs` discovers them in
  `--shared-dir` (default `assets/`): the center by name (`center_tile.*`, else
  `center.*`, else `--center`) and the generic tiles as every image in
  `generic/`. They ride in the manifest as `shared: { center, generic }` and
  are served from the `/shared/` mount, not `/images/`. The old "a `center.*`
  inside the corpus dir is a generic tile" behaviour survives only as the
  `sharedDir === imagesDir` case.
- **The shared tiles are served flat (level 0) for now.** `rooms.js` resolves a
  shared id to its url at level 0 only; every coarser request falls back
  through `servableLevel`. Bounded, because the cache keys on id not cell, but
  it means `main.tsx` pins each shared id at level 0 rather than at the
  coarsest rung — so the "12 KB pinned generic" is a full-res download until
  the shared assets get their own pyramid (plan §8). Do not pin a shared id at
  `FALLBACK_LEVEL`; there is no tile there.

### The center room's controls

- **`center.ts` is the pure half, and the geometry comes from the tools tree.**
  The book layout, `assignTitles`, the hit-test and `pickTags` live in
  `packages/web/src/lib/center.ts` and are asserted browser-free in `center.test.ts`
  — the same split as `picking.ts`. Every book is lettered; a book is one
  flat slot id (`BOOK_COUNT` of them), assigned top left to bottom right, so
  there is no (shelf, index) pair to keep in step. A shelf need not be one
  contiguous run - art can break it into more than one, and `center.ts`'s
  `RUNS` (not `GEOMETRY.shelves` directly) is what the hit-test walks, so a gap
  wider than a book resolves to nothing rather than a phantom book. The rects come from
  `layout({ width: 1, height: 1 })` in `tools/center-placement/lib/geometry.ts`, the
  one module the tile trace feeds, so there is no second copy to drift.
- **The fractions are per-axis, and that is load-bearing.** `render.ts` stretches
  the center tile width→`cellPx.x` and height→`cellPx.y` independently, so a
  spine rect is `{x,w}` against the cell width and `{y,h}` against its height —
  `layout({width:1,height:1})` returns exactly that. One divisor for both axes is
  the same silent-stretch bug the tile geometry warns about.
- **Compositing is content, not chrome, and it is zoom-gated.** It draws on the
  center cell whenever `centreSlots` is passed, but `composeSpines` itself draws
  nothing below a legible spine width — so far out it is free. `render.test.mjs`
  never passes `centreSlots`, which is why its recording `fakeCtx` needs no
  `save`/`rotate` and the byte-cost assertions are untouched. Keep it that way.
- **The books are DOM buttons AND painted spines, and there is one `onBook`
  for both.** `center-books` is one absolutely-positioned container matching
  the center cell, written once per frame like `.center-search`, with
  `BOOK_COUNT` buttons inside it in per-axis PERCENTAGES - so a pan costs one
  style assignment, not forty. Writing each button's geometry per frame from
  `bookScreenRects()` is the trap the plan names; don't. The container is
  `pointer-events: none` with no `:focus-within` escape hatch, so the canvas
  keeps every gesture and a sighted click still routes `onTap` ->
  `bookAtPoint` -> `onBook`; a second copy of "what does book i do" written
  inline in either path will drift. The shelf is ONE tab stop (roving
  tabindex, `role="toolbar"`), and where an arrow key goes lives in
  `bookNeighbour` - rows there are SHELVES, not the hit-test's runs, because a
  gap between two runs is somewhere a click can land and not somewhere focus
  should stop. `areSpinesLegible` is the single zoom gate: the buttons exist
  exactly while `composeSpines` draws a title, so a reader never tabs to a book
  nobody can see named.
- **`onTap` must lose to a pan and to a flight.** It fires only on a pointer-up
  that stayed within the slop and did not stop a flight, and a completed
  long-press clears the tap candidate so a press is never also a tap. History is
  session-only React state; it fills the whole wall as one queue, newest search
  first, top left to bottom right, skipping any book an override has claimed.
  Every book history has not reached is a random keyword tag (the pool is
  cycled to letter the whole wall). Assignment order is
  override → history (newest first) → tags, and override books are reserved
  first. Titles read top-to-bottom, as printed spines do.
- **Two opening views, and they are not interchangeable.** The page-load view is
  DERIVED, not configured: `main.tsx` computes it once at mount with `fitZoom`
  (camera.ts), framing the center room's book-bounding box (`GEOMETRY.opening`,
  exported as `CENTRE_SHELF_RECT` from `center.ts`) on the display so the spines are legible,
  centered on the shelf and capped at the tile's NATIVE width so a page never
  loads upscaled. It is passed to `useMapCamera` as `opening` — do not restate it
  as a config number, and do not read the viewport inside the hook. `defaultZoom`
  (220, config) is the return-to-center view, used by the "center" button and the
  rearrangement's park; the split exists precisely so the reorder animation has a
  wall of rooms to slide across rather than the one shelf the opening shows.
  Collapsing them silently breaks whichever view loses.
- **The zoom cap is `MAX_ZOOM_FACTOR` × the tile's native width** (2× = 2048 at
  1024w), derived in `ZOOM_LIMITS` so it tracks the tile, not a literal. Past 1×
  the flat center tile is upscaled and softens; the OPENING view is separately
  capped at 1× in `main.tsx` so a load is never blurry, while a reader may zoom to
  2× by hand to read a spine. Raising the cap breaks the "tile too large to reach"
  example in `pyramid.test.mjs` (its base scales with `MAX_ZOOM_FACTOR`); that is
  the test working, not a regression. Config's `camera.maxZoom` may only narrow
  this, never widen it.
- **`CENTRE_SEARCH_RECT` is traced but not wired up.** The SVG's `search_box`
  rect reserves where the live search field belongs on the center tile, in the
  same cell fractions as `CENTRE_SHELF_RECT`. The DOM search form in `main.tsx`
  does not read it yet - it still lives in the fixed side panel - so a change
  here is reserved space for a future pass, not a live feature.

### Search and the density gradient

- **Search blends three signals into one sort; it does not tier them.** Every
  signal is normalised to [0, 1] before weighting, and the CLIP term is
  min-maxed across the corpus for that query — bucketing keyword hits ahead of
  everything would let one weak partial beat a room CLIP is certain about.
- **Keyword partials divide by the keyword; story matches divide by the query.**
  Opposite on purpose — `art` matched only 3/11 of `art nouveau`, but a hit in a
  long story isn't worth less than the same hit in a short one.
- **The density gradient is one formula** (`contentRatio + (peak - contentRatio)
  * certainty`, walking outward), not three special cases for cluster/falloff/
  no-match. Certainty must stay non-increasing with rank, and anything under
  `CERTAINTY_FLOOR` snaps to the baseline exactly — both asserted.
- **Certainty is absolute; ranking is relative. Don't feed one the other's
  numbers.** The blend min-maxes CLIP across the corpus, so some room scores 1
  for *any* query — driving the gradient off that clusters nonsense as
  confidently as an exact match. `matchCertainty` reads raw cosines against
  absolute bounds (`CLIP_CERTAINTY`, config `search.density.clipLow/High`).
- **`embeddings.bin` is keyed by row order; `metadata.json` by filename.** The
  blob is positional (`scan.mjs` rejects a drifted count); the sidecar is
  joined per file, so a partial match is just partial. `matched: 0` against a
  non-zero `entries` means the keys drifted — from the map that looks exactly
  like having no sidecar, so both numbers go in the manifest and `index.mjs`
  warns.
- **A room's optional `alt` is a caption, not a story.** The card shows it
  above the story as a visibly different thing and it never feeds the search
  index. Don't write one into `assets/corpus-sample/` — a placeholder caption
  is the padded sentence the plan says to omit.
- **`tagLinks.json` is a flat keyword -> url map, not joined to anything.**
  Unlike `metadata.json` it has no per-room coverage to report — `scan.ts`
  only counts its keys (`TagLinksInfo.count`). It is hand-edited, not
  generated, and optional exactly like the sidecar: a corpus without one just
  renders chips with no "more about this" link. `RoomDetails.tsx` takes it as
  a `tagLinks` prop rather than importing it — see `useCorpus.ts`.

### The reorder animation

- **A rearrangement is a sliding-tile illusion; the wallpaper is not a gap.**
  Rooms travel only as part of a whole row or column rotating — `illusion.ts`
  rejects a `swap` (which reads as teleportation) if either end is on camera.
  Don't add a move type that moves one cell.
- **The illusion bounds are the viewport plus one cell.** The planner swaps a
  value into the cell just outside the region and slides it inward; `board.ts`
  refuses a margin under 1 because a tighter one lands that swap somewhere
  visible.
- **The center room is the planner's fixed tile**, holding the same value in
  both boards by construction — locking it is why the map visibly pivots
  around it.
- **The board is finite only because the camera is parked** on the center for
  the whole animation. Anything that moves the camera mid-rearrangement (pan,
  zoom, `flyTo`) must end the animation instead.
- **`board.ts` returning null is a real answer, not a failure.** With the
  rooms-on-the-map slider pulled back, a room the new order wants on camera may
  never have been on the old board; the caller falls back to an instant
  rebuild rather than sliding in a tile that changes face mid-ride.
- **A reserved cell is never a source** (`makeAvailable` skips them) — otherwise
  a copy staged for one slot gets handed back for another and the original
  reservation points at a cell holding something else.
- **A rearrangement announces its outcome after the camera settles, not
  before**, which moves the screen-reader cursor without a keypress. Tests
  asserting the canvas `aria-label` must establish their own camera rather
  than assume the page is still where it loaded.
- **Visible cost is the viewport's, not the corpus's** — every move outside
  the region is an invisible swap, so slide count scaling with corpus size is
  the bug, not a tradeoff.

See `illusion.test.mjs` for the staging/batching mechanics (conveyor parking,
cascade-vs-wave overlap) — that's implementation detail recoverable from the
code, not a standing invariant.

### Camera and gestures

- **`flyTo` returns a promise for the landing** — `cam.current` is unchanged
  when it returns (flights ease), and the promise says whether it landed
  (false means a hand hit the map mid-flight). An interrupted flight must fall
  back to the instant rebuild rather than rearranging under someone who just
  grabbed the map.
- **A keyboard handler chaining a second move off the first must read
  `flightTarget()` (`flight.current?.to ?? cam.current`), never `cam.current`.**
  `cam.current` is the flight's interpolated position, not its target — two
  key-repeat presses in the same rAF tick both reading it compute the same
  target and cancel each other instead of compounding. The same rule applies
  anywhere else a handler chains off camera state (e.g. the cursor cell).
- **Keyboard panning and pointer panning share `damp` but not its curve.**
  `panByPixels` floors its scale so a drag never feels frozen; a held arrow key
  has no such bound (the browser auto-repeats `keydown`), so the same floor
  there is a constant outward velocity that never stops. `panByCells` scales
  straight from `damp` with no floor, and inside the content region (`damp ===
  1`) snaps the camera cell-centered rather than adding a raw delta, so a
  boundary trip doesn't leave the grid permanently offset.
- **The edge glide applies to keyboard input exactly as it does to a pointer —
  don't exempt it.** The boundary pushback is an affordance (walk past the
  last ranked room, feel the library pull you back), and it must fire without
  any pointer ever touching the map. `glideToRest` runs the same step function
  to convergence for `prefers-reduced-motion` rather than inventing a closed-
  form endpoint — there isn't one.
- **While flying home to start a rearrangement, the map still draws the OLD
  arrangement** until the camera lands (`anim.current.before` holds it) — skip
  that hold and the map shows the new library, flies to it, then slides in
  from the one it already replaced.
- **A flight interpolates zoom geometrically, position linearly**, sharing the
  glide's rAF loop — don't start a second loop. `pointerdown`/`wheel` each drop
  an in-flight animation.
- **Pointer capture is best-effort, never load-bearing.** `setPointerCapture`/
  `releasePointerCapture` can throw `NotFoundError` for an uncapturable
  pointer (ordinary on touch) — do the `pointers` map bookkeeping before the
  capture call, not gated by it.
- **The overlay opens on right-click or long press, never left-click** (left
  stays "focus this room"), and a long press must lose to a pan — the timer
  lives on the pointer stream so wandering past the slop radius cancels it.

### Config and the pyramid

- **No `config.json` is committed, and config never throws.** A committed file
  spelling out every value would become the real surface; every adjustment
  instead lands in `notes` (printed by the server) because a value silently
  not taking effect is the only failure mode a tuning file has.
- **Consuming files state no fallback defaults** — `slide.ts`/`useMapCamera.ts`
  read durations from config with nothing restated locally, so there's no
  second copy to drift.
- **Zoom config narrows, never widens.** `ZOOM_LIMITS` in `camera.ts` is the
  only statement of the hard range; config may tighten it but a narrowing that
  leaves the finest rung unreachable is silently fine (just unused code).
- **The configured range rides on the camera as `limits`**, same as `aspect` —
  rebuild a camera instead of spreading it and the range is lost mid-gesture.
- **Every pyramid number (tile dimensions, ladder, cache budgets, prefetch
  ring) lives in `packages/web/src/lib/pyramid.ts`.** `tiles.ts` and the render
  loop read the policy, they don't restate it. `BASE_TILE` is the only place
  size/shape is stated — don't assume square or compute a size from a literal.
- **Tile eviction is frame-aware.** The renderer walks cells row by row, so a
  plain LRU would evict the top of the screen to make room for its own bottom.
  `tiles.ts` stamps entries with `beginFrame()`'s counter and won't evict
  anything from the current or previous frame — the render loop must call
  `beginFrame()` once per frame for that to mean anything.

### Deployment and the base path

- **`--base-path` does not change how Express routes anything.** Every route
  in `app.ts` is mounted at its normal unprefixed path regardless of the
  flag. What makes a subpath deployment (`https://centuryglass.us/babel-index/`)
  work is `server-nginx.conf`'s `location /babel-index/ { proxy_pass
  http://localhost:5173/; }` — the trailing slash on both sides strips the
  prefix before the request reaches this process, so from Express's point of
  view every request already looks like it arrived at `/`. Adding a second,
  Express-side mount at the same prefix would double-strip and 404 everything.
- **Every url this server hands the browser is RELATIVE, and that is the
  actual fix.** A root-absolute url (`/bundle.js`, `/api/manifest`,
  `/images/foo.jpg`) resolves against the true origin root — one level above
  the subpath — and never reaches the proxy block that would have stripped
  it. `scan.ts`'s `IMAGES_BASE`/`SHARED_BASE` (`images`, `shared`, no leading
  slash) and the two client-side `fetch()` calls (`main.tsx`, `useSearch.ts`)
  are relative for exactly this reason; a new one added with a leading slash
  is a subpath regression even though it works fine at the root deployment
  this app has always defaulted to.
- **`<base href>` is what makes a relative url mean the right thing**, and it
  has to land before anything that uses one — `app.ts` injects it
  immediately after `<head>`. `base-path.ts`'s `normalizeBasePath` is the one
  place the flag's leading/trailing slash gets decided; every consumer reads
  its output rather than re-deriving its own idea of what `--base-path` looks
  like normalized.
- **A bare visit to the subpath must redirect to add the trailing slash.**
  `server-nginx.conf`'s `location = /babel-index { return 301
  .../babel-index/; }` exists because a relative url resolves against the
  last `/`-terminated segment of the CURRENT document location, not against
  `<base href>`, until the page has actually loaded and set it — the redirect
  is what guarantees the browser is at a trailing-slash URL before that first
  load even starts.
- **Testing this locally without the proxy in front is testing the wrong
  thing.** Hitting `http://localhost:5173/` directly with `--base-path` set
  serves a page whose `<base href>` points at a prefix Express never mounted,
  so every relative fetch 404s — that is expected, not a regression to chase;
  the flag is meaningless without the reverse proxy that strips it.

### The catalog, and the two modes

- **The map is HIDDEN, never unmounted, and that is load-bearing twice over.**
  `.map-view` is `display: contents` shown and `display: none` hidden, and the
  render loop returns early when `mode !== 'map'`. Unmounting it instead looks
  like it would work and does not: `useMapCamera`'s listener effect reads
  `canvasRef.current` once and depends on the ref OBJECT, so a canvas that
  remounts comes back with no pointer listeners bound at all - the camera still
  holds the right numbers, the HUD still reads correctly, and the map silently
  never pans again. `catalog.e2e.ts`'s "the map is where it was left when the
  catalog closes" test drags after a mode switch precisely because every
  cheaper assertion passes under that bug. Hiding also keeps the tile cache
  and the pyramid's LRU warm, so returning is a repaint, not a rebuild.
- **The catalog is not the accessibility mode.** `accessibility-plan.md` §3.7
  rejected a linear list as an accommodation and left it open as a control for
  everyone. So: nothing detects a screen reader, nothing defaults into it, the
  panel's ranked listbox stays exactly where it is, and `role="application"`
  stays scoped to the canvas. The catalog is a `<ul>` - §3.7's argument for a
  `listbox` is about the panel's bare-name results and does not carry to rows
  containing keyword chips.
- **One live region for the whole app, and it lives outside both views.** It
  used to sit in the panel, which is part of the map; a region that unmounts on
  a mode switch is one a screen reader loses. `.note` keeps only the static
  hint, which must never share a node with `role="status"`.
- **Rows are a FIXED height and the spacers are arithmetic, not estimates.**
  `spacerHeight` stands in for unmounted pages exactly, so a recycled page
  cannot move the scroll position under a reader's hands. That is why the story
  is line-clamped, why the score breakdown in a row is the one-line `strip`
  layout rather than the card's `table` (the table was 108px in a 202px row and
  clipped itself), and why `rowHeight` takes the max of the tile and the text
  column - on a narrow display the thumbnail shrinks and the story does not. The
  center room's row is the one exception, allowed to size itself because it sits
  outside the paging arithmetic; its measured height is the scroll conversion's
  `leadPx`.
- **Pagination and infinite scroll are one primitive with a different window.**
  Both slice `pageOf`; pagination passes `windowPages: 0`. Writing them as two
  features would let a room sit at a different position depending on how the
  reader pages. `windowFor` widens the window when a screenful spans more pages
  than the budget mounts, so a tall display cannot scroll into a spacer.
- **Highlighting mirrors the two match rules, including their asymmetry.** A
  keyword matches by SUBSTRING and a story word by PREFIX, so there are two
  range finders in `scoring.ts` beside the two scorers, taking the same folded
  query and tokens the ranking used - a token dropped as a stopword or for being
  too short cannot mark, because it did not score. Do not re-derive "what
  matched" in a component; the drift would be silent.
- **`foldWithMap` exists because folded offsets are not source offsets.** NFD,
  mark-stripping and lowercasing each change length, so a folded index used
  against the original text misplaces every mark on any corpus with an accent in
  it. `fold` is a one-line caller of it; folding is per code point and therefore
  position-independent, which is what an index wants.
- **`rankHybrid` returns the components it sorted on, and the CLIP row must show
  its raw cosine.** `breakdown.clip` is min-maxed for the query, so some room
  scores 1.00 for `cghjj` too. `explainScore` keeps the raw cosine beside it and
  certainty on its own line; printing the relative number alone claims a
  confidence the library does not have. Asserted.
- **Namespace catalog CSS.** `.row` already belonged to the dev panel, and an
  unprefixed rule reached in and turned every slider row into a fixed-height
  flex box. `.chips`, `.story`, `.picture` and `.score` ARE shared on purpose -
  they come from `RoomDetails` and must look the same in a card and in a row.
  The trap runs the other way too: a global `button { flex: 1 }`, written for
  the panel's button rows, stretched the pager's buttons across half the window
  each. The catalog's controls opt out explicitly rather than that rule being
  narrowed under the panel it was written for.
- **A fixed row cannot show everything, so the overlay is not optional.**
  `RoomOverlay` is how a reader sees the tile at full size and the whole story
  without going back to the map, reached from the thumbnail and from the "read
  the rest" a clipped story ends with. Expanding a story IN PLACE was the
  alternative and it breaks the windowing: row heights would vary, and then the
  spacers are estimates. The clamp itself is derived (`storyLines`), not a flat
  two lines - and `STORY_RESERVED_PX` must account for the expand button on
  EVERY row, including the ones that do not show one, or the button is clipped
  out of existence on exactly the narrow displays that need it.
- **The query has a length cap and `search()` is where it is enforced.** The
  input's `maxLength` only covers typing; a keyword chip, a book on the shelf
  and a restored history entry all reach `search()` without passing through a
  box. Scoring is O(tokens x keywords) per room, so a pasted tag list does not
  degrade, it stops.

### Testing and CI

- **In a cloud agent container, running `npm run test:e2e` yourself is slow**
  (the pinned Chromium isn't preinstalled the way it is in CI, and each spec
  launches its own browser). If a change doesn't touch `packages/web/e2e/**`
  or behavior an existing e2e spec exercises, don't run the suite locally —
  `npm test` plus lint is the fast local signal, and `e2e.yml` runs as the PR's
  merge gate regardless. Run it locally anyway when the change is
  behavior-sensitive enough that you want the read before opening the PR (e.g.
  refactors touching the rearrangement/camera/search state machines), or when
  you're editing the e2e specs themselves.
- **e2e is a merge gate.** `ci.yml` runs `npm test` across the Node matrix and
  calls `e2e.yml`; the aggregate `ci` job needs both. A flaky browser test
  blocks merges for everyone, so wait on a condition, never on a duration —
  `settled()` waits out the camera and animation only, not the network, so
  anything asserting on `blank` tiles or the HUD text must poll (bounded)
  rather than trust the first reading after an interaction.
- **Two reads of the same UI separated by a slow call can describe two
  different renders** (e.g. ranking still settling after a CDP round trip).
  Where genuine settling is needed, poll for two *agreeing* reads with a real
  gap between them — two reads taken back to back with nothing elapsed proves
  nothing.
- **Test cleanup belongs in `finally`.** Each `packages/web/e2e/*.e2e.ts`
  file's tests share one `page` across that file; a failed assertion skipping
  cleanup strands slider/camera state for every test after it in the same
  file, turning one flake into several unrelated
  failures. Sabotage-test cleanup itself, not just the assertion it guards.
- **A green e2e test that cannot fail is worse than none.** If you change one,
  break the app on purpose and confirm it fails.
- **Assert on the accessible name, not on raw ARIA attributes** (e.g.
  `aria-valuetext`) — attribute-vs-computed-name behavior differs across
  Chromium versions and CI vs. local can install different pinned builds
  (`BABEL_E2E_CHROMIUM` points the suite at a specific binary). The accname
  algorithm is consistent everywhere; anything a reader must hear belongs in
  the label.
- **An accessibility assertion must dump the node it failed on** — "expected
  /%/, got 26" can't distinguish a missing attribute from an ignored one, and
  the failing run is usually on a machine you can't open a browser on.
- **CDP touch injection bypasses real gesture arbitration.** The touch/pinch
  tests in `packages/web/e2e/map-gestures.e2e.ts` can't see `touch-action`,
  `pointercancel`, or the real capture lifecycle — treat it as a known blind
  spot. Simulate suspected gesture bugs explicitly and confirm on a device
  with `?touchdebug`.

## Next up

See `docs/implementation-plan.md`
