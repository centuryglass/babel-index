# AGENTS.md

Notes for coding agents working in this repo. Human-facing docs are
[`README.md`](README.md) (how to run it),
[`docs/architecture.md`](docs/architecture.md) (a five-minute system
overview), and [`docs/concept.md`](docs/concept.md) (what it is meant to
become). What is still to do lives in
[GitHub issues](https://github.com/centuryglass/babel-index/issues), not a
file in this repo - see "Tracking open work" below.

## What this is

An AI art experiment loosely based on the Library of Babel: a pannable,
zoomable map of generated library rooms. One tile is **one shelved wall**.
Tile variations are generated via an external inpainting pipeline, and paired
with style keywords used for generation and a brief story text based on the
image and keywords.

Tiles can be searched, with CLIP embeddings, keyword matching, and story
matching used to calculate ranking and match strength for all tiles. A set of
generic "default" tiles are mixed in with the unique ones, with their
distribution adjusted during searches so they serve as a way to visibly gauge
search strength. Diegetic controls for the search interface are embedded into
the center tile, placed using geometry calculated from a reference SVG.

An alternate catalog interface can be used to maximize discoverability. This
interface swaps the map and diegetic interface for a more conventional web
search UI and linear tile list.

## Why this repo also has to read as engineering, not just art

This project has two audiences at once, and both are real. It is an art piece
first - the map, the search, the stories are the point, and no engineering
practice here should crowd that out or become the subject of the site itself.
But it is also the maintainer's software engineering portfolio: proof, after
time away from the industry, of being able to build, deploy, and maintain a
non-trivial web app using a modern AI-assisted workflow. That second audience
is a person - a reviewer, a hiring manager, another engineer - skimming the
repo, not a visitor to the site. They will not read this whole file; they will
look for the same signals they'd want in a work sample: CI actually gating
merges (it does), a real deploy path with health verification (it does),
tests that would catch a real regression, and enough surface documentation
(README, an architecture overview, an API contract) that they don't have to
read the source to trust the process that produced it.

Practically, this means: when a change is ambiguous between "what the art
needs" and "what a portfolio needs," default to keeping both in mind rather
than silently picking one - flag the tension instead of quietly resolving it
in the art's favor. Process/documentation gaps that exist purely for
portfolio value (not required by the art itself) get a GitHub issue like any
other open task, not bundled invisibly into unrelated work.

## Commands

```sh
npm run demo                       # http://localhost:5173, against assets/corpus-sample/
npm run demo -- --images <dir> [--center center.jpg] [--shared-dir assets] [--port 5173] [--config config.json] [--base-path /babel-index/]
npm run demo -- --favorites favorites.json [--trust-proxy 1]   # record global favorite counts
npm test                           # node --test, ~1s, no browser and no network
npm run test:e2e                   # browser smoke test; needs `npx playwright install chromium` once
npm run test:parity                # manual Canvas2D-vs-WebGL render parity; real GPU, not a merge gate
npm run lint                       # config in eslint.config.js
npm run typecheck                  # tsc --noEmit -p jsconfig.json, checkJs over the JSDoc
npm run check:file-map             # docs/file_map.md vs the real tree, a required check (see its own header)
npm run check:requirements         # docs/search_requirements.md vs the tests' [SR-nn] tags, a required check
npm run check:requirements -- --list              # ... and print every requirement with the tests covering it
npm run check:requirements -- --update-baseline   # ... lower the allowed-uncovered list once a gap is closed
npm run generate:mips -- --images <dir> [--shared-dir <dir>] [--center <name>]   # write the resolution pyramid in place; --shared-dir also pyramids the center render + generic/ tiles there
npm run generate:embeddings -- --images <dir>   # CLIP image embeddings: embeddings.bin + .json (needs the optional transformers install)
npm run generate:animation                 # pack assets/animation/<cycle>/ frames into sprite sheets + manifest
npm run generate:shelf-geometry     # Recalculate diegetic control bounds from tools/center-placement/shelf_geometry.svg
```

No compiled output ever hits disk. The demo server bundles the client with
esbuild in-process at startup (`packages/server/index.ts`), so editing web
sources means restarting `npm run demo`. Demo run will fail if its port is in
use. The one exception is `packages/web/style.css`, which is not part of the
esbuild bundle - the server re-reads it on every request (like `index.html`
itself), so a margin or color tweak just needs a browser refresh.

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
- The usual recommended JS rules, plus typescript-eslint's non-type-checked
  `recommended` config on every `.ts`/`.tsx` file - no `parserOptions.project`,
  since `npm run typecheck` already owns type correctness and a type-checked
  lint config would just re-run that at lint speed.
- Browser globals scoped to `packages/web/src/**/*.{ts,tsx}`, plus
  `packages/web/e2e/**/*.ts` and the two tools that composite onto a real
  page (`tools/font-lab/render.ts`, `tools/perf-capture/capture.ts`), all
  three of which reference `document`/`window` directly rather than through
  a separate browser-only file.
- Node globals scoped to `**/*.mjs` and every other `.ts` file (`build/`,
  `packages/config`, `packages/map`, `packages/pipeline`, `packages/server`,
  the rest of `tools/`).
- From `eslint-plugin-react-hooks`, only `rules-of-hooks`, `exhaustive-deps`,
  as recommended rules bundled in v7 disagree with how we use refs.

**`typescript-eslint` cannot run against TypeScript 7** (`typescript-eslint/typescript-eslint#10940`
tracks it - months out as of this writing, since ESLint has no async-parser
support and AST/type-info can't yet cross the Go/WASM boundary tsgo runs on).
That's why `typescript` is pinned to `^6.0.3` rather than the `^7.0.2` a
plain `npm install typescript` would grab today - not a deliberate choice
against TS 7's speed, just the version the tooling that lints it can
actually parse. A side-by-side alias (`"ts6-for-eslint":
"npm:typescript@^6.0.3"` alongside a `^7` `typescript`) was tried and
rejected: aliased `typescript` packages still ship a `bin.tsc`/`bin.tsserver`,
and npm resolves the collision by an undocumented rule (empirically,
whichever package name sorts alphabetically last wins the
`node_modules/.bin/tsc` symlink) - not something worth pinning `npm run
typecheck`'s compiler to. Revisit the single-version pin once
typescript-eslint supports TS 7.

## Layout

The full file-by-file map lives in
[`docs/file_map.md`](docs/file_map.md), standalone so it can be loaded
without pulling in every invariant below it. **Read it at the start of a
session before navigating this repo.** It is part of the change the same
way this file is: a file added, removed or renamed is not done until that
list says so - the list is how anyone (or anything) finds its way around
the tree, and one silently missing entry is how a module gets written
twice.

Tests and test helpers not listed there, assume each appropriate file is
paired with a corresponding `{name}.test.ts` (pre-conversion ones are
`{name}.test.mjs`) within the same directory. Playwright tests are in
`packages/web/e2e`. Anything under `reference` is only used with the
inpainting pipeline, and isn't touched anywhere else in the project.

## Conventions

- **ESM everywhere** (`"type": "module"`). `.mjs` for anything Node runs
  directly, `.js` for modules the browser bundles, `.jsx` for React, `.ts`/
  `.tsx` as the TypeScript equivalent of any of those three (see the
  TypeScript convention for how each runs). Import Node built-ins
  with the `node:` prefix, and always give an internal import its real file
  extension (`./port.ts`, not extensionless) - Node's resolver doesn't guess.
- **Node 20 is the floor** (`engines`), and CI runs 20/22/24. Get user
  confirmation before adding dependencies, try to keep dependencies minimal.
- **TypeScript is the default for every new file, full stop.** A new module is
  `.ts`, a new React file is `.tsx`, a new script is a `.ts` run through the
  loader hook (see *Commands*) rather than a bare `.mjs` - the same is true
  of new tests (`*.test.ts`; the `test` script enumerates both extensions).
  Write `.js`/`.mjs`/`.jsx` only when there is a concrete reason a given
  file can't be `.ts`/`.tsx` yet, not out of habit or to match a neighbor that
  hasn't been converted.

  `.js`/`.mjs`/`.jsx` and `.ts`/`.tsx` coexist for a long stretch; existing code
  converts file-by-file, with no deadline - convert something old when you're
  already in it or it's a good candidate, and don't mass-rename working files
  just to convert them. Two kinds of TypeScript file:
  - **A pure type contract** (`packages/map/manifest.ts`): a `.ts` file
    exporting only `interface`s/`type`s, never imported by a `.js`/`.mjs`/`.jsx`
    file at runtime - only through JSDoc (`@type {import('./manifest.ts').Manifest}`).
    `tsc --noEmit` (`npm run typecheck`) is what checks it.
  - **A real module** (`packages/server/port.ts`): runs at runtime like any
    other source file, through the Node loader hook in `build/` (see
    *Commands*) or through esbuild's client bundle in `packages/web`.
    Prefer converting a file outright over leaving new TSDoc-only types on a
    `.js` file once its neighbors are already `.ts` - two type notations for
    one module is the drift this migration exists to remove.

  Convert files with little duck-typing and a fixed shape first. Defer files
  whose data is *deliberately* loose until there's a real type worth writing
  that doesn't just paper over the looseness with `any` or a lying assertion: a
  strict type that fights the code's actual tolerance is worse than an honest
  `object`/JSDoc.

  `checkJs` is on (`jsconfig.json`, `npm run typecheck`) as a local signal, not
  yet a CI gate. Writing accurate JSDoc on new `.js`/`.mjs` code is still
  welcome; it's what the next conversion reads from.
- **Tests sit next to the code**, using `node:test` + `node:assert/strict`.
  New tests are `*.test.ts` per the TypeScript-by-default rule above; existing
  `*.test.mjs` files are untouched until something else brings a reason to
  convert them - and converting the module they test to `.ts` is such
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
- **Comments are reference, not advocacy.** Their job is to tell the next
  reader what is true, quickly - not to defend a design to a skeptic. That
  means the "why" is written for the reader of the code as it stands, never
  as a defense of the change against the version it replaces. The rules
  below serve that, and they apply to this file and the docs too.
  - **Lead with the rule.** Line 1 of a comment is a standalone summary; a
    reader who stops there must lose no invariant.
  - **One fact, one home.** State a fact fully where the thing is defined;
    elsewhere, point or stay silent. A pointer names a symbol or a section
    title, never a position ("see `board.ts`", not "see the comment above"),
    and it must resolve - check a `see X` before committing, because a
    dangling pointer is a confident-looking lie.
  - **Pin to a declaration, not a region.** One comment, one thing below it;
    split a paragraph that describes more than one thing and re-attach each
    piece. A pinned comment moves with its code or visibly goes wrong; a
    region paragraph quietly becomes stale.
  - **Keep hazards, drop ghosts.** A warning that a change here breaks
    something there - "board.ts refuses a margin under 1 because a tighter
    one lands the swap somewhere visible" - is regression armor; keep it, as
    the main clause. An argument against a design the file never had ("not a
    number restated here that would only drift," "rather than folded into X")
    is scaffolding left in the wall: that reasoning is worth doing, but in
    your thinking, not the file - once the change lands, the version it
    argues against exists only in git. The tell is prose about a prior
    implementation rather than the code as it stands. This is not only a
    code-comment habit: a doc section rewritten after a migration ("there is
    no longer a file for this," "X used to live in Y before it moved here")
    has the same tell and the same fix - a reader arriving fresh has no prior
    state to be told they're free of, so describe only the state that exists.
    Keep a history note only where it resolves something a reader would
    otherwise trip on (a redirect, a permanent alias, a link that still
    points at an old name) - not as scene-setting for a change that already
    landed. End a change with a narrow sweep over the lines and sections you
    touched, flagging "used to / instead of / rather than / would only / no
    longer / anymore / was migrated / previously," to catch the residue.
  - **Length tracks risk, and terse has a floor.** A few lines is the
    default; more is earned only where deleting a clause would let a careful
    reader introduce a real bug - in genuinely subtle code (`illusion.ts`,
    `scoring.ts`) long commentary is often correct. Never delete a hazard to
    look terse: relocate or condense it. And if a fact keeps recurring
    across files, it wants a different home - the owning module, or this
    file - not another copy.
  - **Plain declaratives.** No SHOUTING CAPS and no conviction adverbs
    (`exactly`, `really`, `deliberately`, `on purpose`); emphasis comes from
    position and structure. One clause per sentence; real lists for
    list-shaped content. Reference symbols rather than their current values
    ("the buttons `BOOK_COUNT` generates", not "the forty buttons"), and
    don't cite section numbers into ephemeral docs (plans, task lists) - a
    pointer into `docs/search_rules.md` or `docs/keyboard-controls.md`, which
    are kept in sync, is fine.
  - Files open with a block comment saying what the file is for and which
    decision it embodies. Match the surrounding density rather than adding a
    comment per line, and don't narrate what the code is doing (a human may
    have; you should not). Prose comments and markdown use ASCII hyphens,
    not em dashes - match the file you're editing.
- Two-space indent, semicolons, single quotes, trailing commas in multi-line
  literals. Just follow the file you're in.
- **An existing, undocumented bug found while doing unrelated work still gets
  addressed, not filed away for later without action.** Trivial to fix (a
  wrong assertion, an off-by-one, a stale comment) - fix it in the same pass,
  same as any other cleanup a task turns up. Real investigation or design work
  - a race condition whose root cause isn't yet nailed down, a fix that
    touches code you weren't already changing - gets a GitHub issue instead
  (see "Tracking open work"): what was observed, how to reproduce it, and
  what's already been ruled out, so the next pass starts from evidence rather
  than re-discovering the bug from scratch. Either way, the bug does not just
  get silently noticed and left. "Unrelated to what I was asked" is not a
  reason to leave a found bug undocumented and unfixed. "Trivial" is about
  the fix, not the effort spent finding it - if closing it out needs more
  than one e2e run to confirm (a live-instrumented repro, several rounds of
  re-running a browser suite to chase a race), that is a sign it belongs in
  an issue, not a same-pass fix - unless the user has explicitly asked for
  exactly that investigation.
- **`CLAUDE.md` is a symlink to this file.** Edit `AGENTS.md`; `CLAUDE.md`
  exists only so a tool that looks for that filename finds the same content.
- **This file is for facts that cross files, not single-file trivia.**
  Before adding one, ask: is it relevant only within one file; would opening
  that file to make the edit surface it anyway; would a reader be better
  served finding it there instead of here. A yes to any of those means the
  fact belongs in that file's own comment (confirm it is already there, or
  add it) rather than restated here - at most a one-line gist with a pointer,
  the same length-tracks-risk rule "Comments are reference, not advocacy"
  states for code comments. "Things that will bite you" below is the
  legitimate case: a fact that bites someone editing a *different* file than
  the one the invariant lives in.

## Things that will bite you

### Tile geometry

- **`tools/center-placement/lib/measured.ts` is generated.** Never hand-edit
  it; changes to center-tile geometry are human-managed in
  `shelf_geometry.svg`, parsed with `import-shelf-svg.ts`, validated with
  `npm test`.
- **Don't assume the tile aspect ratio; read it from `BASE_TILE`.** If it
  ever changes: update `BASE_TILE` in `pyramid.ts` and `shelf_geometry.svg`
  together and re-run `import-shelf-svg.ts`. Nothing else should need
  updating.
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
  `cellDistance()` - `hypot(x, y * aspect)`, i.e. cell *widths*. That makes the
  library round on screen. A raw `Math.hypot(x, y)` anywhere in that file is the
  bug. Placement uses the same metric and has to: a circular boundary around an
  elliptical spread of rooms is a circle empty at top and bottom.
- **The center room is cell (0, 0)** and is reserved - `packages/map` never
  assigns a corpus room there.
- **Corpus size and generic ratio are runtime parameters**, arguments to
  `createLayout()`, not build-time settings. Growing the corpus must keep
  existing slots where they are and append further out; that property is what
  makes the sliders usable and is asserted in `ordering.test.ts`.
- **A relevance re-sort swaps one array; the shuffle button rebuilds the
  layout too.** A relevance re-sort stays a swap of `order`: the map
  rearranges, it does not reload. The shuffle button is a full reshuffle: it
  rerolls `seed` (which cells are content slots at all, the same scatter
  `rescatter` reruns) alongside `order`. It clears any active search or
  favorite sort first - a reorder that left one of them in place would
  rescatter everything except the thing already pinning the layout.
  A search, or an active favorite sort (`'mine'`/`'count'`), may also rebuild
  the layout: both are placement inputs (the strength claim each makes is
  under *Favorites*). `favoriteSort` (`packages/map/favorites.ts`) composes
  the two rather than letting one override the other. That rebuild is the
  same O(slots) the ratio slider does on every drag. Nothing else recomputes
  placement.
- **The map is virtualized canvas.** Do not mount thousands of DOM nodes.

### The center tile and its generic tiles

- **The center and a generic tile are different images, and neither is the
  other.** Cell (0, 0) always draws the blank `center_tile.png` (the `CENTER`
  tile id), reserved for the search box and controls; every generic cell draws
  one of the inpainted generic tiles (`genericId(i)`), never the blank tile.
  `genericId(-1)` is `CENTER`, which is only the fallback for a corpus with no
  generic tiles at all.
- **Which generic tile a cell shows is positional and order-independent, and
  that is load-bearing.** `layout.genericIndexAt(x, y)` is a seeded hash of
  the coordinate alone: a reorder never changes a generic cell's face.
  Because of that, `board.ts` and `illusion.ts` see one interchangeable
  `GENERIC` value (`roomAt`'s `{ generic: true }`), and the rearrangement
  planner never learns about individual generic tiles. The two renderers
  (`render.ts`, `slide.ts`) are the only places a cell resolves to a tile id.
  `slide.ts` reads the generic
  index at each tile's *home* board cell, so a sliding line carries its own
  face instead of flipping mid-ride.
- **The shared tiles live outside `--images`.** `scan.ts` discovers them in
  `--shared-dir` (default `assets/`): the center by name (`center_tile.*`, else
  `center.*`, else `--center`) and the generic tiles as every image in
  `generic/`. They ride in the manifest as `shared: { center, generic }` and
  are served from the `/shared/` mount, not `/images/`. The one case where a
  `center.*` inside the corpus dir counts as a generic tile is `sharedDir ===
  imagesDir`.
- **The center and the generic tiles have their own pyramid, generated the
  same way the corpus is.** `npm run generate:mips -- --images <dir>
  --shared-dir <dir> [--center <name>]` (`packages/pipeline/shared-mips.ts`)
  writes the same per-file `<width>/<file>` ladder `mips.ts` writes for a
  room, rooted under `--shared-dir` instead - once for the center render,
  once per file in `generic/`. `scan.ts` discovers what each tree actually
  has on disk (`discoverLevels`, same as it does for `manifest.levels`) and
  intersects the two into `manifest.shared.levels`, so a level only counts
  as available where both the center and every generic tile actually have
  it. `rooms.ts` resolves a shared id at a level in `shared.levels` by
  inserting `<width>/` before the asset's filename - the same per-level
  directory `shared-mips.ts` wrote it into. There are no shared sheets: a
  handful of files needs no packing.

  Every OTHER shared id - a generic tile's distill alternate
  (`generic_distill/`, only ever drawn up close), a favorite badge, the
  distill toggle's faces, the "forget searches" overlay - is fixed-size app
  art with no pyramid of its own, and stays flat at level 0, falling back to
  it through `servableLevel` for any coarser request, same as before.
  `main.tsx` pins the center at level 0 (on screen from the first frame) but
  the generic tiles at the coarsest level `shared.levels` actually has -
  never a hardcoded `FALLBACK_LEVEL`, since an older corpus with no shared
  pyramid generated has none but level 0.

### The center room's controls

- **`center.ts` is the pure half, and the geometry comes from the tools tree.**
  The book layout, `assignTitles`, the hit-test and `pickTags` live in
  `packages/web/src/lib/center.ts` and are asserted browser-free in `center.test.ts`
  - the same split as `picking.ts`. Every book is lettered; a book is one
  flat slot id (`BOOK_COUNT` of them), assigned top left to bottom right, so
  there is no (shelf, index) pair to keep in step. A shelf need not be one
  contiguous run - art can break it into more than one, and `center.ts`'s
  `RUNS` (not `GEOMETRY.shelves` directly) is what the hit-test walks, so a gap
  wider than a book resolves to nothing rather than a phantom book. The rects come from
  `layout({ width: 1, height: 1 })` in `tools/center-placement/lib/geometry.ts`, the
  one module the tile trace feeds, so there is no second copy to drift.
- **The fractions are per-axis, and that is load-bearing.** `render.ts` stretches
  the center tile width→`cellPx.x` and height→`cellPx.y` independently, so a
  spine rect is `{x,w}` against the cell width and `{y,h}` against its height -
  `layout({width:1,height:1})` returns exactly that. One divisor for both axes is
  the same silent-stretch bug the tile geometry warns about.
- **Compositing is content, not chrome, and it is zoom-gated.** It draws on the
  center cell whenever `centreSlots` is passed, but `composeSpines` itself draws
  nothing below a legible spine width - so far out it is free. `render.test.ts`
  never passes `centreSlots`, which is why its recording `fakeCtx` needs no
  `save`/`rotate` and the byte-cost assertions are untouched. Keep it that way.
- **The books are DOM buttons and painted spines, and there is one `onBook`
  for both.** `center-books` is one absolutely-positioned container written
  once per frame in per-axis percentages, so a pan costs one style
  assignment, not one per button - don't write each button's geometry per
  frame from `bookScreenRects()`. The container is `pointer-events: none`,
  so a sighted click routes through the canvas's own `onTap` ->
  `bookAtPoint` -> `onBook`; a second copy of "what does book i do" written
  inline in either path will drift. The shelf is one tab stop (roving
  tabindex), arrow-key neighbor logic is `center.ts`'s `bookNeighbour`, and
  `areSpinesLegible` is the single zoom gate keeping a reader from tabbing to
  a book nobody can see named.
- **Every one of those DOM overlays is sized to the whole cell, and the clip
  on `#root` is what keeps that off the page.** `.center-search`,
  `.center-books`, `.center-book` and `.center-controls` are absolutely
  positioned against `#root` at the center cell's screen rect, several
  screens wide at reading zoom - invisible on desktop, but a phone responds
  by shrinking the page scale and growing the layout viewport to fit, which
  drags every dialog and the map's own paint size with it (measured on a
  Pixel 5: 407px of document in a 393px screen at load, 1194x2209 fully
  zoomed in). `#root`'s `overflow: clip` in `style.css` is the fix and its
  comment there carries the full mechanism, including why `clip` and not
  `hidden`. `map-gestures.e2e.ts`'s "zooming in never grows the page past
  the viewport" is the regression guard.
- **`onTap` must lose to a pan and to a flight.** It fires only on a pointer-up
  that stayed within the slop and did not stop a flight, and a completed
  long-press clears the tap candidate so a press is never also a tap. History
  is persisted React state (`persist.ts`'s `KEYS.history`); it fills the whole
  wall as one queue, newest search
  first, top left to bottom right, skipping any book an override has claimed.
  Any book history has not reached is a random keyword tag (the pool is
  cycled to letter the whole wall). Assignment order is
  override → history (newest first) → tags, and override books are reserved
  first. Titles read top-to-bottom, as printed spines do.
- **Two opening views, and they are not interchangeable.** Both derive from
  the live viewport rather than a fixed zoom, but for different targets and
  at different times: the page-load view (`main.tsx`, computed once at mount
  with `fitZoom`) frames the center shelf so its spines are legible, while
  the return-to-center view (`overviewZoom`, recomputed at each call site -
  the "center" button, a room double-tap, the rearrangement's park) frames
  `config.camera.minVisibleCells` whole rows/columns so the reorder
  animation has a wall of rooms to slide across. Collapsing them silently
  breaks whichever view loses. `camera.ts`'s `fitZoom`/`overviewZoom` doc
  comments carry the derivation.
- **The zoom cap is `MAX_ZOOM_FACTOR` × the tile's native width** (2× = 2048 at
  1024w), derived in `ZOOM_LIMITS` so it tracks the tile, not a literal. Past 1×
  the flat center tile is upscaled and softens; the opening view is separately
  capped at 1× (`center.ts`'s `openingZoom`, which `main.tsx` calls) so a load
  is never blurry, while a reader may zoom to
  2× by hand to read a spine. Raising the cap breaks the "tile too large to reach"
  example in `pyramid.test.ts` (its base scales with `MAX_ZOOM_FACTOR`); that is
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
  min-maxed across the corpus for that query - bucketing keyword hits ahead of
  everything would let one weak partial beat a room CLIP is certain about.
- **A query is matched term by term AND as one whole string, and the better
  reading wins.** `rankHybrid` classifies each term against a room's keywords
  and title, then classifies the whole folded query the same way, so a
  multi-word tag typed plainly (`outsider art`) is an exact match without the
  reader quoting it - which matters because a keyword chip searches its text
  unquoted and nearly half a real corpus's keywords are multi-word. An exact
  whole-query match counts as one exact match, never more, so two separate
  exact tags still outrank one matched phrase.
- **Keyword partials divide by the keyword; story matches divide by the query.**
  Opposite on purpose - `art` matched only 3/11 of `art nouveau`, but a hit in a
  long story isn't worth less than the same hit in a short one.
- **The density gradient is one formula** (`contentRatio + (peak - contentRatio)
  * strength`, walking outward), not three special cases for cluster/falloff/
  no-match. Strength must stay non-increasing with rank, and anything under
  `STRENGTH_FLOOR` snaps to the baseline - both asserted.
- **Strength is absolute; ranking is relative. Don't feed one the other's
  numbers.** The blend min-maxes CLIP across the corpus, so some room scores 1
  for *any* query - driving the gradient off that clusters nonsense as
  confidently as an exact match. `matchStrength` reads raw cosines against
  absolute bounds (`CLIP_CERTAINTY`, config `search.density.clipLow/High`).
- **`embeddings.bin` is keyed by row order; `metadata.json` by filename.** The
  blob is positional (`scan.ts` rejects a drifted count); the sidecar is
  joined per file, so a partial match is just partial. `matched: 0` against a
  non-zero `entries` means the keys drifted - from the map that looks
  like having no sidecar, so both numbers go in the manifest and `index.ts`
  warns.
- **A room's optional `alt` is a caption, not a story, and it lives on `<img
  alt>`, not as visible text.** `RoomOverlay` and the catalog thumbnail both
  put it on the real `<img>` tag; it never feeds the search index. The one
  exception is the map canvas's fallback content
  (`RoomDetails`'s `showPicture` prop), which has no `<img>` to hang it on and
  renders it as a paragraph instead - fallback content is never painted, so
  that isn't a second visible copy. Don't write one into
  `assets/corpus-sample/` - a placeholder caption is a padded sentence,
  which is worse than none.
- **`tagLinks.json` is a flat keyword -> url map, not joined to anything.**
  Unlike `metadata.json` it has no per-room coverage to report - `scan.ts`
  only counts its keys (`TagLinksInfo.count`). It is hand-edited, not
  generated, and optional like the sidecar: a corpus without one just
  renders chips with no "more about this" link. `RoomDetails.tsx` takes it as
  a `tagLinks` prop rather than importing it - see `useCorpus.ts`.

### Favorites

- **A count is a set's size, never a counter.** `packages/server/favorites.ts`
  stores, per room, a set of `HMAC(salt, file + NUL + clientId)`. Adding twice
  is one favorite and removing what was never there is nothing, so no endpoint
  can zero a room out or run it up - that property is the whole reason it is a
  set, and a "just increment a number" simplification throws it away.
- **The hash is per room.** The same visitor hashes differently in every
  room's set, so two sets cannot be joined into one person's list. The cost
  is that the store cannot count distinct visitors, which is not something we
  want to be able to do. Hashing is not claimed as a security control; it is
  the shape that makes the stored data useless while still de-duplicating.
- **Identity is a client-generated token, not `req.ip`.** The browser mints a
  random id once (`getOrCreateFavoriteClientId`, `persist.ts`) and sends it as
  `X-Favorite-Client`; `app.ts` rejects a request whose header doesn't match
  `CLIENT_ID_PATTERN` before it reaches the store. An address is a bad proxy
  for "one visitor" in both directions - shared NAT/CGNAT collides real
  visitors into one hash, and a rotating IP hands one visitor a fresh hash
  mid-session - and a client-generated token fixes both. Trivially spoofable
  by regenerating it, same as clearing site data always was, but that only
  ever reverts a visitor to "not yet favorited" - the set semantics above are
  what actually stop a run-up or a zero-out, not how hard the token is to get.
- **Favorites are keyed by filename everywhere - server, `localStorage`, and
  `packages/map/favorites.ts`.** Room ids are positional (`scan.ts` sorts
  filenames and indexes them), so one image added to a corpus renumbers every
  id after it and a stored id silently comes back pointing at a different room.
- **Favorite writes are rate-limited by `req.ip`, deliberately on a
  different key than identity.** `createRateBuckets` (`app.ts`) throttles how
  fast one connection can spend requests. Bucketing on `X-Favorite-Client`
  instead would do nothing, since a script can mint a fresh token on every
  request for free - the address is what actually costs something to change.
  Behind a reverse proxy `req.ip` is the proxy's address, though, so without
  `--trust-proxy` every visitor behind it shares one bucket and one abusive
  visitor can throttle everyone else's favoriting. The flag must stay off by
  default regardless: trusting `X-Forwarded-For` where nothing strips it lets
  a client pick its own address, and here that means its own rate budget,
  once per request. The proxy must send `proxy_set_header X-Forwarded-For
  $proxy_add_x_forwarded_for;` for the flag to mean anything.
- **No store, no feature.** Without `--favorites` the routes are not mounted and
  `manifest.favorites` is null, which every consumer reads as "render no
  favorite control" - distinct from a count of zero.
- **A relevance sort is a re-rank, and the catalog row's toggle is in the
  head.** In `'relevance'` mode sorting swaps `order` (the reorder button's
  path, animation included) and must never rebuild the layout. An active
  favorite sort (`'mine'`/`'count'`) is the exception - it is a placement
  input, exactly as a search is, because "sorted to the front" is itself a
  strength claim; see `packages/map/favorites.ts`'s `favoriteSort`. And a
  catalog row is a fixed height, so the row's favorite control sits beside
  "show on the map" rather than inside `RoomDetails` where the card and the
  overlay put it; in the text column it would have to be reserved for in
  `TEXT_MIN`/`TEXT_CHROME_PX` and would cost two lines of story on every row.
- **The on-map badge is the third favorite control, and it is fixed art, not a
  scanned corpus asset.** `assets/fav_on.png`/`fav_off.png` (`tiles.ts`'s
  `FAV_ON`/`FAV_OFF`) resolve off `manifest.sharedBase` directly rather than
  a manifest listing, since `scan.ts` never discovers them. Drawn by both
  `render.ts` and `slide.ts` on every non-center, non-generic cell -
  `favoriteBadge.ts` is the pure geometry/hit-test half. The tap hit-test
  has no minimum-size gate: `favoriteHitRect` returns the badge's scaled
  traced bounds at any zoom, padded up to `MIN_FAVORITE_HIT_TOUCH` on a
  coarse pointer (`main.tsx` hit-tests that rect directly) - only a trace
  with no region at all is decoration rather than a dead control.

### The reorder animation

- **A rearrangement is a sliding-tile illusion; the wallpaper is not a gap.**
  Rooms travel only as part of a whole row or column rotating - `illusion.ts`
  rejects a `swap` (which reads as teleportation) if either end is on camera.
  Don't add a move type that moves one cell.
- **The illusion bounds are the viewport plus one cell.** The planner swaps a
  value into the cell just outside the region and slides it inward; `board.ts`
  refuses a margin under 1 because a tighter one lands that swap somewhere
  visible.
- **The center room is the planner's fixed tile**, holding the same value in
  both boards by construction - locking it is why the map visibly pivots
  around it. That is a fact about the board's value, unrelated to where the
  camera is parked.
- **The board is finite only because the camera is parked** for the whole
  animation, at whatever position it already had - `startRearrangement`
  (`useRearrangement.ts`) zooms out in place rather than flying home to the
  center, so "parked" does not imply "at the origin." Anything that moves
  the camera mid-rearrangement (pan, zoom, `flyTo`) must end the animation
  instead.
- **While zooming out to start a rearrangement, the map still draws the old
  arrangement** until the camera lands (`anim.current.before` holds it) - skip
  that hold and the map shows the new library, zooms to it, then slides in
  from the one it already replaced.
- **The plan is built and fetched entirely before the flight, not after it
  lands.** `prepareRearrangement` (`useRearrangement.ts`) simulates the
  planned moves to find every room the slide will show - 27-48% more than
  `before`'s and `after`'s static viewport content on a real corpus, since a
  `shiftRow`/`shiftCol` rotates a whole line - fetches all of it, and waits
  up to `config.slide.prepareTimeoutMs` before proceeding with whatever's
  ready. Past that budget, or if the reader interacts mid-prepare, it falls
  back to the instant rebuild rather than blocking indefinitely. See its own
  comment for why computing the landing rectangle from the camera's
  pre-flight x/y is sound here.
- **`board.ts` returning null is a real answer, not a failure.** With the
  rooms-on-the-map slider pulled back, a room the new order wants on camera may
  never have been on the old board; the caller falls back to an instant
  rebuild rather than sliding in a tile that changes face mid-ride. It is
  discovered during prepare, before any flight starts for it - not after
  landing.
- **A reserved cell is never a source** (`makeAvailable` skips them) - otherwise
  a copy staged for one slot gets handed back for another and the original
  reservation points at a cell holding something else.
- **A rearrangement announces its outcome after the camera settles, not
  before**, which moves the screen-reader cursor without a keypress. Tests
  asserting the canvas `aria-label` must establish their own camera rather
  than assume the page is still where it loaded.
- **Visible cost is the viewport's, not the corpus's** - every move outside
  the region is an invisible swap, so slide count scaling with corpus size is
  the bug, not a tradeoff.

See `illusion.test.ts` for the staging/batching mechanics (conveyor parking,
cascade-vs-wave overlap) - that's implementation detail recoverable from the
code, not a standing invariant.

### The loading indicator

- **It fills the preload pause, and the flight waits for it.** `startRearrangement`
  (`useRearrangement.ts`) starts a cycle when `prepareRearrangement` begins and
  holds the zoom+slide until the cycle reaches a boundary with at least one full
  cycle played (`loadingAnimation.ts`'s `finish()`). So even a warm-cache
  rearrangement pauses for one whole cycle - that is deliberate, not a bug to
  optimize away. A cold cache has it playing the whole fetch instead.
- **The center-tile indicator only plays when the center book is on screen to
  show it.** The gate is `overlapsViewport(cellRect, ...) &&
  areSpinesLegible(cellRect)` - the same legibility bar the shelf's own titles
  use. Off that gate, no indicator plays and no cycle-wait is imposed. The
  search badge's ring (`SearchOrbitSpinner`, `SearchIcon.tsx`) is the far-field
  counterpart - it spins over the same preload window regardless of this gate,
  driven by `useRearrangement.ts`'s `onPreparingChange` rather than
  `loadingAnim`, so it is what a reader browsing away from the center actually
  sees during a preload. Nothing else about the rearrangement changes.
- **The controller owns its own rAF loop.** The map's render loop is on-demand
  (`useMapRenderer.ts`'s `draw.current`) and does not repaint during the preload
  wait; the controller calls the `requestDraw` it was handed each tick, and the
  renderer pulls the current frame back through `frame()`. A grab mid-preload
  (`onDown` in both render hooks) calls `cancel()`, which stops the loop AND
  resolves the pending `finish()` so the rearrangement it belonged to ends too.
- **`drawLoadingFrame` is drawn in both renderers, in lockstep.** `render.ts`'s
  `drawLoadingFrame` and the matching block in `glRenderer.ts` place the same
  sheet sub-rect at the same cell-fraction rect - the WebGL-renderer lockstep
  rule applies here as everywhere. The state machine's cycle/boundary math is
  pure and unit-tested (`loadingAnimation.test.ts`); the placement is verified
  by eye and by the render-parity suite's own center-tile coverage.
- **The frames are a build artifact, served like fixed art.** They ride in the
  shared dir (`assets/animation/`, served at `/shared/animation/`), resolved off
  `sharedBase` the way the favorite badges are - `scan.ts` discovers nothing
  here. A missing manifest is "no indicator deployed", read as null
  everywhere, as with a missing favorite store. The e2e suite's
  `--shared-dir` is the
  sample corpus, which has no manifest, so the indicator is cleanly absent there
  and adds nothing to e2e timing.
- **The dev panel's "loop loading animations" checkbox is a standalone preview.**
  It walks every cycle in order forever (`startDebug`) so each can be eyeballed
  in place, and the current cycle name shows in the HUD. It owns the screen while
  on: a rearrangement's `play()` no-ops rather than fighting it.

### Camera and gestures

- **`flyTo` returns a promise for the landing** - `cam.current` is unchanged
  when it returns (flights ease), and the promise says whether it landed
  (false means a hand hit the map mid-flight).
- **A keyboard handler chaining a second move off the first must read
  `flightTarget()` (`flight.current?.to ?? cam.current`), never `cam.current`.**
  `cam.current` is the flight's interpolated position, not its target - two
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
- **The edge glide applies to keyboard input as it does to a pointer -
  don't exempt it.** The boundary pushback is an affordance (walk past the
  last ranked room, feel the library pull you back), and it must fire without
  any pointer ever touching the map. `glideToRest` runs the same step function
  to convergence for `prefers-reduced-motion` rather than inventing a closed-
  form endpoint - there isn't one.
- **A flight interpolates zoom geometrically, position linearly**, sharing the
  glide's rAF loop - don't start a second loop. `pointerdown`/`wheel` each drop
  an in-flight animation.
- **Pointer capture is best-effort, never load-bearing.** `setPointerCapture`/
  `releasePointerCapture` can throw `NotFoundError` for an uncapturable
  pointer (ordinary on touch) - do the `pointers` map bookkeeping before the
  capture call, not gated by it.
- **The overlay opens on right-click or long press, never left-click** (left
  stays "focus this room"), and a long press must lose to a pan - the timer
  lives on the pointer stream so wandering past the slop radius cancels it.

### Config and the pyramid

- **No `config.json` is committed, and config never throws.** A committed file
  spelling out every value would become the real surface; every adjustment
  instead lands in `notes` (printed by the server) because a value silently
  not taking effect is the only failure mode a tuning file has.
- **Consuming files state no fallback defaults** - `slide.ts`/`useMapCamera.ts`
  read durations from config with nothing restated locally, so there's no
  second copy to drift.
- **Zoom config narrows, never widens.** `ZOOM_LIMITS` in `camera.ts` is the
  only statement of the hard range; config may tighten it but a narrowing that
  leaves the finest rung unreachable is silently fine (just unused code).
- **The configured range rides on the camera as `limits`**, same as `aspect` -
  rebuild a camera instead of spreading it and the range is lost mid-gesture.
- **Every pyramid number (tile dimensions, ladder, cache budgets, prefetch
  ring) lives in `packages/web/src/lib/pyramid.ts`.** `tiles.ts` and the render
  loop read the policy, they don't restate it. `BASE_TILE` is the only place
  size/shape is stated - don't assume square or compute a size from a literal.
- **A level is per-file or sheet-packed, and the pipeline leaves only one of
  the two on disk.** `packages/pipeline` writes every level per-file, composites
  the levels at or above `SHEETS.fromLevel` into `<width>-sheets/`, then deletes
  those levels' per-file directories. `scan.ts`'s `discoverLevels` prefers a
  complete sheets directory and falls back to per-file when the sheets are
  missing or incomplete, which after a finished run means a corpus packed before
  sheet packing existed.
- **Tile eviction is frame-aware.** The renderer walks cells row by row, so a
  plain LRU would evict the top of the screen to make room for its own bottom.
  `tiles.ts` stamps entries with `beginFrame()`'s counter and won't evict
  anything from the current or previous frame - the render loop must call
  `beginFrame()` once per frame for that to mean anything.

### Deployment and the base path

- **`--base-path` does not change how Express routes anything.** Every route
  in `app.ts` is mounted at its normal unprefixed path regardless of the
  flag. What makes a subpath deployment (`https://centuryglass.us/babel-index/`)
  work is the VPS's hand-managed nginx config (not in this repo; see
  `deploy/README.md`):
  `location /babel-index/ { proxy_pass
  http://localhost:5173/; }` - the trailing slash on both sides strips the
  prefix before the request reaches this process, so from Express's point of
  view every request already looks like it arrived at `/`. Adding a second,
  Express-side mount at the same prefix would double-strip and 404 everything.
- **Every url this server hands the browser is relative.** A root-absolute
  url (`/bundle.js`, `/api/manifest`,
  `/images/foo.jpg`) resolves against the true origin root - one level above
  the subpath - and never reaches the proxy block that would have stripped
  it. `scan.ts`'s `IMAGES_BASE`/`SHARED_BASE` (`images`, `shared`, no leading
  slash) and the two client-side `fetch()` calls (`main.tsx`, `useSearch.ts`)
  are relative for this reason; a new one added with a leading slash
  is a subpath regression even though it works fine at the root deployment
  this app has always defaulted to.
- **`<base href>` is what makes a relative url mean the right thing**, and it
  has to land before anything that uses one - `app.ts` injects it
  immediately after `<head>`. `base-path.ts`'s `normalizeBasePath` is the one
  place the flag's leading/trailing slash gets decided; every consumer reads
  its output rather than re-deriving its own idea of what `--base-path` looks
  like normalized.
- **A bare visit to the subpath must redirect to add the trailing slash.**
  The VPS config's `location = /babel-index { return 301
  .../babel-index/; }` exists because a relative url resolves against the
  last `/`-terminated segment of the current document location, not against
  `<base href>`, until the page has actually loaded and set it - the redirect
  is what guarantees the browser is at a trailing-slash URL before that first
  load even starts.
- **Testing this locally without the proxy in front is testing the wrong
  thing.** Hitting `http://localhost:5173/` directly with `--base-path` set
  serves a page whose `<base href>` points at a prefix Express never mounted,
  so every relative fetch 404s - that is expected, not a regression to chase;
  the flag is meaningless without the reverse proxy that strips it.

### Deploying to the VPS

Full setup and the rollback path are in `deploy/README.md`. The invariants:

- **A 200 is not a successful deploy, and that is the whole reason
  `/api/health` reports a commit.** The old process surviving a failed
  restart, a unit file pointing at a second checkout, `--images` aimed at a
  directory that moved - every one of those answers 200 with a perfectly
  healthy-looking library. So `health-check.mjs` compares the reported commit
  against the sha being deployed, and a release that comes up on the right
  commit with **zero rooms** fails immediately rather than waiting out the
  timeout: it answered, so retrying cannot change the answer.
- **`version.ts` is read once at startup, never per request.** A running
  process cannot change which revision it is; re-reading `.git` per request
  would report the checkout rather than the code in memory, which is the exact
  lie the health check exists to catch.
- **The deploy key is pinned to `deploy/deploy.sh` as an SSH forced command,
  and the ancestor check is what makes that worth anything.** The requested
  sha arrives in `$SSH_ORIGINAL_COMMAND`, is matched against 40 hex characters
  before it is used at all, and is refused unless it is already an ancestor of
  `origin/main`. Anyone holding the key can redeploy main or roll back to
  something that was main - not a branch, not a fork's commit, not a shell.
  Loosening either check turns a narrow credential back into a login.
- **Both halves of the check run, and they ask different questions.**
  `deploy.sh` checks `127.0.0.1` (did the unit come back on the new code?) and
  the workflow re-checks the public url (can anyone reach it?). A localhost-only
  check cannot tell a working site from a broken reverse proxy in front of a
  working server - which, given *Deployment and the base path*, is a failure
  worth being able to see.
- **A failed deploy is not rolled back.** It stops with the previous sha
  printed, and the workflow's dispatch input takes a sha, so a rollback is a
  button. Rolling back automatically would pair a working-looking site with a
  red workflow, which is the combination most likely to be misread as flaky CI.
- **`deploy.sh` runs as the version of itself that was already on the box**,
  since it checks out the new revision partway through its own run. A change
  to it lands on the deploy *after* the one introducing it - the same
  one-release lag any self-updating deploy script has, and not a bug to chase.

### Release discipline

- **The PR title is the only release input, and that is why it's linted.**
  This repo squash-merges, so a PR's title becomes the commit subject on
  main - the one line `release-please.yml` reads to decide the next version
  and write `CHANGELOG.md`. `pr-title-lint.yml` enforces Conventional
  Commits format (`feat: ...`, `fix: ...`, ...) on every PR title as a
  required check, specifically so a malformed title fails at review time
  rather than silently dropping out of the changelog. A PR's description and
  its individual commits are read by nobody downstream of merge; only the
  title matters, and the PR template says so.
- **Mark a breaking change with `!` on the title, not a footer.** Squashing
  keeps only the PR title as the commit subject - a `BREAKING CHANGE:`
  footer written in the PR description does not survive that and
  release-please will never see it. `feat!: ...` (or any type) is the one
  place to flag it, and it's what forces a major bump.
- **Releasing is a second PR, not a side effect of the first.**
  `release-please.yml` keeps a standing release PR up to date on every push
  to main; nothing is tagged, versioned, or written to `CHANGELOG.md` until
  a human merges *that* PR. `package.json`'s `version` field and
  `.release-please-manifest.json` are only ever written by that merge - never
  hand-edit either.
- **`deploy.yml` deploys only that merge, not every push to main.** Its `if`
  matches the head commit message against `chore(main): release ` - the
  literal prefix of a release-please release-PR title, which becomes the
  commit subject the same way any squash-merged PR's does - so an ordinary
  merge to main builds and tests but never ships. That makes every deploy
  correspond to a tagged, changelogged version; the tradeoff is the same lag
  between "merged" and "live" any release-gated deploy has, kept small by not
  leaving a release PR open once it's ready to merge. A manual
  `workflow_dispatch` is still the hatch for an urgent fix between releases.

### The catalog, and the two modes

- **The map is hidden, never unmounted, and that is load-bearing.**
  `.map-view` is `display: contents` shown and `display: none` hidden, and the
  render loop returns early when `mode !== 'map'`. Unmounting it instead looks
  like it would work and does not: `useMapCamera`'s listener effect reads
  `canvasRef.current` once and depends on the ref object, so a canvas that
  remounts comes back with no pointer listeners bound at all - the camera still
  holds the right numbers, the HUD still reads correctly, and the map silently
  never pans again. `catalog.e2e.ts`'s "the map is where it was left when the
  catalog closes" test drags after a mode switch because every
  cheaper assertion passes under that bug. Hiding also keeps the tile cache
  and the pyramid's LRU warm, so returning is a repaint, not a rebuild.
- **A room's permalink is its title, and `packages/map/slug.ts` decides it
  for every caller.** `roomPath` builds `catalog/<slug>` from the room's
  title folded to ASCII (`slugify`, over `scoring.ts`'s own `fold`), and the
  server, the sitemap and the overlay's copy-link button all read
  `buildSlugTable` rather than assembling a path each. A room's filename
  stem is a permanent alias that redirects to the title url, so a retitle leaves
  the links already shared somewhere to land; an untitled room has the stem
  as its real url. A room id never reaches a path - ids are positional, so
  one in a shared url comes back pointing at a different room. Unique titles
  are the generator's to keep: two rooms claiming one path each take their
  stem as a suffix and `roomContent.ts` warns at startup, which is the only
  sign it happened.
- **The catalog is not the accessibility mode.** A linear list was rejected
  as an accommodation and left open as a control for everyone. So: nothing
  detects a screen reader, nothing defaults into it, the panel's ranked
  listbox stays where it is, and `role="application"` stays scoped to the
  canvas. The catalog is a `<ul>`; the listbox reasoning behind the panel's
  bare-name results does not carry to rows containing keyword chips.
- **One live region for the whole app, and it lives outside both views.** The
  panel is part of the map, and a region that unmounts on a mode switch is one a
  screen reader loses - keep it out of both. `.note` keeps only the static
  hint, which must never share a node with `role="status"`.
- **Rows are a fixed height and the spacers are arithmetic, not estimates.**
  `spacerHeight` stands in for unmounted pages exactly, so a recycled page
  cannot move the scroll position under a reader's hands - the fixed height
  is why the story is cut rather than allowed to grow the row, and why the
  score breakdown uses a `strip` layout rather than the card's taller
  `table`. A row is two stacked pieces, a fixed-height flow area
  (`--catalog-flow-h`) and the score strip below it (`scoreStripHeight`),
  so match strength can never get pushed off the card; the center room's
  row is the one exception, sized to its own content since it sits outside
  the paging arithmetic. `catalog.ts`, `CatalogView.tsx` and `style.css`'s
  `.catalog-flow`/`.score-strip` comments carry the layout mechanics.
- **A room row's thumbnail floats inside the flow area, and the story wraps
  around it; the center room instead lays the picture, title and spines out
  on one CSS grid.** The float shape is why the story is cut by measured
  `max-height`/`overflow: clip` rather than `-webkit-line-clamp` (a BFC would
  stop it wrapping the float), and why "did this row cut something" asks the
  story's own `scrollHeight`, not the card's. The center room can't use a
  float at all - a spines-beside-then-below layout needs one shared grid so
  both runs land on the same column lines. `style.css`'s comments on
  `.catalog-flow`/`.catalog-row .story`/`.catalog-center` carry the full
  reasoning; `CatalogView`'s layout effect is what fits `--pic-cols`.
- **What a row cannot show, it counts - it never just stops.** A fixed-height
  row cannot promise a room's keywords fit: no reserve can, at an arbitrary
  width with arbitrary keyword lengths. So `chipLines` sizes the chip box from
  the row's real leftover height, and whatever still does not fit is counted
  and offered as a `+N` chip (`RoomDetails`'s `chipOverflow`) that opens the
  room. A flat `max-height` that silently swallows a third keyword is the
  failure mode this guards. The counter is absolutely positioned, and must
  be: it is rendered from a measurement of the very box it sits in, so an
  in-flow one would change the height that decided its own number - and it is
  skipped when
  counting, or it adds one to itself on every pass.
- **A chip ellipsises; it does not get sliced.** `.chip` is `flex: 0 1 auto`
  with `max-width: 100%` and `text-overflow: ellipsis`, so a keyword wider than
  its column shrinks rather than overflowing and being cut mid-glyph by the
  card's `overflow: hidden`. `flex-wrap` still decides the line breaks first,
  so this only ever shrinks a chip already alone on its line. Nothing is lost:
  the full keyword is in the chip's `title` and the link's accessible name.
- **Pagination and infinite scroll are one primitive with a different window.**
  Both slice `pageOf`; pagination passes `windowPages: 0`. Writing them as two
  features would let a room sit at a different position depending on how the
  reader pages. `windowFor` widens the window when a screenful spans more pages
  than the budget mounts, so a tall display cannot scroll into a spacer.
- **Highlighting mirrors the match rules, including their asymmetry.** A
  keyword matches by substring and a story word by prefix, so there are two
  range finders in `scoring.ts` beside the scorers, taking the same folded
  query and tokens the ranking used - a token dropped as a stopword or for being
  too short cannot mark, because it did not score. A room's title matches by
  the same substring rule a keyword does (`classifyTagTerm`), so `useSearch`'s
  `highlight.title` reuses `keywordMatchRanges` rather than a third finder;
  `CatalogView`'s row head and `RoomOverlay`'s head both mark the title through
  it, and only the corpus's real title, never the "Room N" fallback, which
  scored no title match. Do not re-derive "what matched" in a component; the
  drift would be silent.
- **`foldWithMap` exists because folded offsets are not source offsets.** NFD,
  mark-stripping and lowercasing each change length, so a folded index used
  against the original text misplaces every mark on any corpus with an accent in
  it. `fold` is a one-line caller of it; folding is per code point and therefore
  position-independent, which is what an index wants.
- **`rankHybrid` returns the components it sorted on, and the CLIP row must show
  its raw cosine.** `breakdown.clip` is min-maxed for the query, so some room
  scores 1.00 for `cghjj` too. `explainRanking` keeps the raw cosine beside it and
  strength on its own line; printing the relative number alone claims a
  confidence the library does not have. Asserted.
- **Namespace catalog CSS.** `.row` already belongs to the dev panel, so an
  unprefixed `.row` rule for catalog rows reaches in and turns every slider
  row into a fixed-height flex box. `.chips`, `.story`, `.picture` and
  `.score` are shared on purpose - they come from `RoomDetails` and must look
  the same in a card and in a row.
  The trap runs the other way too: a global `button { flex: 1 }`, written for
  the panel's button rows, stretches the pager's buttons across half the window
  each. The catalog's controls opt out explicitly rather than that rule being
  narrowed under the panel it was written for.
- **A fixed row cannot show everything, so the overlay is not optional.**
  `RoomOverlay` is how a reader sees the tile at full size and the whole story
  without going back to the map, reached from the thumbnail and from the "read
  the rest" a clipped story ends with. Expanding a story in place would break
  the windowing: row heights would vary, and then the spacers are estimates.
  The story is cut by the card and faded rather than
  clamped to a line count (see the float rule in this list) - and
  `TEXT_CHROME_PX` must account for the expand button on every row, including
  the ones that do not show one, or the button is clipped out of existence on
  the narrow displays that need it. The chip clamp is derived
  (`chipLines`, `CHIP_LINE_PX`) and whatever it cannot fit is counted, so a
  room's keywords never silently disappear.
- **The query has a length cap and `search()` is where it is enforced.** The
  input's `maxLength` only covers typing; a keyword chip, a book on the shelf
  and a restored history entry all reach `search()` without passing through a
  box. Scoring is O(tokens x keywords) per room, so a pasted tag list does not
  degrade, it stops.

### The WebGL renderer

WebGL is the default renderer; Canvas2D (`render.ts`/`slide.ts`) is the
second. `render-parity.parity.ts` (`npm run test:parity`) is what keeps the
two in step - see *Testing and CI*.

- **It mirrors `render.ts`/`slide.ts`'s draw loop, in lockstep.**
  `glRenderer.ts`/`glSlideRenderer.ts` are a second implementation of the
  same per-cell decisions (which pyramid level, which cell resolves to which
  draw, favorite-badge gating, prefetch/warm-level ordering) using
  `gl/context.ts`'s quad primitives instead of `CanvasRenderingContext2D`
  calls - not a shared abstraction over both. A change to either file's draw
  loop needs the matching change on the other side, or the two renderers
  drift and the map silently stops looking the same under one of them - the
  parity suite is the check that catches this. `GLDrawOpts`/`GLDrawResult` are derived from
  `render.ts`'s real `DrawOpts`/`DrawResult` (`Omit<DrawOpts,'ctx'> &
  {gl}`) specifically so a shape change there is caught here at typecheck
  time rather than silently drifting too.
- **GL setup happens exactly once per canvas element's lifetime, never per
  frame or per prop change.** `canvas.getContext('webgl2', ...)` is
  memoized by the browser and returns the same underlying context on a
  second call, but `gl/context.ts`'s `createGLContext` does not check for
  that - it unconditionally creates a new shader program, VAO and buffer
  every time it runs, and nothing but its own `dispose()` ever frees the
  previous ones. `useMapRendererGL.ts`'s canvas-lifetime effect (dependency
  array `[canvasRef, cache]` only) is what keeps this to once; anything
  routed through it that starts depending on a value that changes often
  (a search, a favorite toggle) reintroduces the leak.
- **The texture cache has its own eviction budget, independent of
  `tiles.ts`'s.** `gl/textureCache.ts` mirrors `tiles.ts`'s frame-aware LRU
  rule (current and previous frame are always protected) rather than
  hooking into it - GPU memory pressure is a different resource than the
  decoded-bitmap budget `pyramid.ts` already manages, and a `WeakMap` alone
  would leak GPU handles forever (JS garbage collection runs no cleanup code
  on a `WeakMap` eviction).
- **The renderer default lives in `webglFlag.ts`.** `DEFAULT_WEBGL` is `true`;
  a plain visit gets WebGL. `?webgl=0` (also `off`/`false`/`no`) forces
  Canvas2D, a bare `?webgl` or any other value forces WebGL, and `WEBGL` folds
  in `supportsWebGL2()`'s capability probe so an unsupported device falls
  back to Canvas2D automatically regardless of the flag. The `?webgl=0` hatch
  is load-bearing for `render-parity.parity.ts`'s Canvas2D control session
  and for a reader who
  hits a GL-specific glitch - don't drop it while Canvas2D still exists.

### Testing and CI

- **`npm run check:requirements` is a required check, run from the `lint` CI
  job.** A test names the requirement it covers in its own name
  (`test('... [SR-18]', ...)`), and the checker rebuilds the whole mapping
  from `git ls-files` on every run - so `docs/search_requirements.md` names
  no tests, nothing is kept in sync, and a renumbered requirement id would
  break every citation at once (which is why an `SR-nn` is permanent; that
  file's header states the rule). It fails on a tag naming a requirement
  that does not exist, and on a requirement losing coverage the committed
  `baseline.json` says it had. Gaining coverage never fails - it prints the
  command that lowers the baseline. A requirement marked `_(judged)_` in the
  document has no assertion that could fail and is counted apart from the
  gaps rather than sitting in them forever.
- **`npm run check:file-map` is a required check, run from the `lint` CI
  job.** It diffs `docs/file_map.md` against `git ls-files`, failing on a
  path the map lists that no longer exists or a tracked file (other than a
  unit test or an image) the map never mentions - see
  `tools/check-file-map/index.ts`'s header for the exact rules. This is
  what makes the Layout section's "part of the change" rule enforced
  rather than hoped for.
- **The e2e suite pins its renderer with `openLibrary`'s `webgl` option, not
  the production default.** `DEFAULT_WEBGL` is `true`, but every spec except
  `webgl-map.e2e.ts` passes `webgl=0` (Canvas2D) because the suite's blank/
  repaint probes (`fingerprint`, the `getImageData` reads) need a 2D context a
  GL canvas doesn't have. GL behaviour is covered by `webgl-map.e2e.ts`
  (`webgl: true`) and the parity suite. Leaving a spec unpinned would let
  the production default silently switch its renderer and break those reads.
- **`render-parity.parity.ts` (`npm run test:parity`) is a separate manual
  suite, not a merge gate.** The `.parity.ts` suffix matches neither `npm test`
  nor `npm run test:e2e`'s glob - it needs a real GPU and boots two
  sessions (Canvas2D + WebGL) to check the renderers draw the same map. Run it
  by hand when touching either draw loop; it is the check behind the lockstep
  invariant in "The WebGL renderer". See its header for the scene design (why
  there's no far-zoom scene, why the pixel bounds are where they are).
- **Running `npm run test:e2e` is slow in a cloud agent container** (the
  pinned Chromium isn't preinstalled the way it is in CI, and each spec
  launches its own browser). There, if a change doesn't touch
  `packages/web/e2e/**` or behavior an existing e2e spec exercises, don't run
  the suite - `npm test` plus lint is the fast local signal, and `e2e.yml`
  runs as the PR's merge gate regardless. That caveat is container-only: on
  the maintainer's own machine - identifiable by Arch Linux (`/etc/os-release`)
  - the pinned Chromium is preinstalled, the suite is cheap, and it runs
  green. Run e2e locally whenever the change is behavior-sensitive enough
  that you want the read before opening the PR (e.g.
  refactors touching the rearrangement/camera/search state machines), when
  you're editing the e2e specs themselves, or on the maintainer's machine
  whenever the change touches tested behavior.
- **e2e is a merge gate.** `ci.yml` runs `npm test` across the Node matrix and
  calls `e2e.yml`; the aggregate `ci` job needs both. A flaky browser test
  blocks merges for everyone, so wait on a condition, never on a duration -
  `settled()` waits out the camera and animation only, not the network, so
  anything asserting on `blank` tiles or the HUD text must poll (bounded)
  rather than trust the first reading after an interaction. `settled()`
  itself works by waiting for the HUD to stop starting with `"rearranging"` -
  `useMapRenderer.ts` sets that text for the whole span from
  `anim.current` first being set through prepare, the flight, and the slide,
  not just once the slide's board exists, so this holds even
  while `prepareRearrangement` (`useRearrangement.ts`) is still fetching.
- **Two reads of the same UI separated by a slow call can describe two
  different renders** (e.g. ranking still settling after a CDP round trip).
  Where genuine settling is needed, poll for two *agreeing* reads with a real
  gap between them - two reads taken back to back with nothing elapsed proves
  nothing.
- **Test cleanup belongs in `finally`.** Each `packages/web/e2e/*.e2e.ts`
  file's tests share one `page` across that file; a failed assertion skipping
  cleanup strands slider/camera state for every test after it in the same
  file, turning one flake into several unrelated
  failures. Sabotage-test cleanup itself, not just the assertion it guards.
- **A green e2e test that cannot fail is worse than none.** If you change one,
  break the app on purpose and confirm it fails.
- **Assert on the accessible name, not on raw ARIA attributes** (e.g.
  `aria-valuetext`) - attribute-vs-computed-name behavior differs across
  Chromium versions and CI vs. local can install different pinned builds
  (`BABEL_E2E_CHROMIUM` points the suite at a specific binary). The accname
  algorithm is consistent everywhere; anything a reader must hear belongs in
  the label.
- **An accessibility assertion must dump the node it failed on** - "expected
  /%/, got 26" can't distinguish a missing attribute from an ignored one, and
  the failing run is usually on a machine you can't open a browser on.
- **CDP touch injection bypasses real gesture arbitration.** The touch/pinch
  tests in `packages/web/e2e/map-gestures.e2e.ts` can't see `touch-action`,
  `pointercancel`, or the real capture lifecycle - treat it as a known blind
  spot. Simulate suspected gesture bugs explicitly and confirm on a device
  with `?touchdebug`.
- **A `flyTo` issued while a rearrangement is animating is overridden, not
  honored** - a fast-clicking reader triggers this for real, and in a test
  it shows up as a plain click-then-`landed()` on the 'center' button
  reporting a "settled" camera that never actually moved. Use
  `e2e/support.ts`'s `recentre()` instead of a bare click whenever a test's
  `before` state might follow a search or other `requestAnimation` trigger
  - its own comment explains why it waits out and retries rather than
  trusting one `landed()` read. Whether a control-issued `flyTo` should end
  an active rearrangement the way a pointer grab does is the open question
  recorded in issue #265.

## Tracking open work

- **Open work lives entirely in [GitHub issues](https://github.com/centuryglass/babel-index/issues).**
  Nothing in this repo tracks tasks; the issue tracker is the only list.
- **A found bug opens an issue**: what was observed, how to reproduce it,
  and what is already ruled out. The trivial same-pass fix rule is
  unchanged - it decides whether anything gets filed at all, not where.
- **A fact worth knowing is not a task.** It belongs in the owning module's
  comment, or in this file, not in an issue. See "This file is for facts
  that cross files".
- **`.claude/scripts/issues.mjs` compiles the issues into a local
  directory** (`index.md` plus one file per issue) for when a file on disk
  is cheaper to read than the API. `--fetch` uses `gh` where it exists;
  otherwise pipe issue JSON in, which is how a session with the GitHub MCP
  tools and no `gh` binary feeds it. The cache is generated and gitignored -
  never edit it, and never treat it as the source of truth.
- **The `SessionStart` hook (`.claude/hooks/session-start.sh`) runs this
  automatically where it can.** When `gh` is on `PATH` and authenticated -
  true on the maintainer's own machine, never true in a Claude Code Remote
  session - it refreshes the cache and prints `index.md` to stdout, which
  Claude Code folds into session context, so every open issue's title is
  already in view at the start of a session without a tool call.
- **When the hook doesn't fire, apply it by hand before relying on "no open
  issue mentions this."** That's every Claude Code Remote session (no
  `gh`), and any other agent system - OpenCode included - that doesn't run
  this repo's Claude Code hooks. Fetch the issue list through whatever tool
  is available (the GitHub MCP tools' `list_issues`, or `gh issue list
  --json ...` if present) and pipe the JSON into the script:
  `node .claude/scripts/issues.mjs --from-json <path>` or `... < issues.json`.
  Then read `.claude/cache/issues/index.md` the same way the hook's stdout
  would have surfaced it.
- **A PR closing an issue says so in its description** (`Closes #NN`), which
  is what makes merging the status update.

## Working with GitHub

- **Don't ask whether to subscribe to a PR you just opened.** The answer is
  effectively always no; if the user wants it watched they'll say so.

## Next up

See [GitHub issues](https://github.com/centuryglass/babel-index/issues).
