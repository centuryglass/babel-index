# AGENTS.md

Rules for coding agents working in this repo. Human-facing docs are
[`README.md`](README.md) (how to run it),
[`docs/architecture.md`](docs/architecture.md) (a five-minute system
overview), and [`docs/concept.md`](docs/concept.md) (what it is meant to
become). Open work lives in
[GitHub issues](https://github.com/centuryglass/babel-index/issues) - see
"Tracking open work".

## How to use this file

- **Read [`docs/file_map.md`](docs/file_map.md) at the start of a session,**
  before navigating the repo. It is the file-by-file map.
- **This file is for facts that cross files, and most changes add nothing
  to it.** A bullet here earns its place by biting someone who is editing a
  *different* file than the one the fact lives in. Before adding one, ask:
  - Is it relevant only within one file?
  - Would opening that file to make the edit surface it anyway?
  - Would a reader be better served finding it there?

  A yes to any of these means the fact goes in that file's own comment
  (confirm it is there, or add it). Here it gets at most a one-line pointer.
- **Edit by replacing, not appending.** When a change makes a bullet wrong,
  rewrite that bullet; don't add a second one that corrects the first. When
  the code a bullet describes is gone, delete the bullet.
- **Code comments cite this file's headings and bold lead phrases by name**
  (`AGENTS.md, "The WebGL renderer"`). Renaming one breaks those pointers:
  grep the repo for the old phrase and fix every hit in the same change.
- **`CLAUDE.md` is a symlink to this file.** Edit `AGENTS.md`.

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

## Two audiences

The project is an art piece first. The map, the search and the stories are
the point, and no engineering practice should crowd them out or become the
subject of the site.

It is also the maintainer's software engineering portfolio. That reader is a
reviewer or hiring manager skimming the repo, not a visitor to the site, and
they look for the signals of a work sample: CI that gates merges, a deploy
path with health verification, tests that would catch a real regression, and
enough surface docs (README, architecture overview, API contract) to trust
the process without reading the source.

- When a change is ambiguous between what the art needs and what the
  portfolio needs, flag the tension to the maintainer. Don't quietly
  resolve it in either direction.
- A process or documentation gap that matters only for portfolio value gets
  its own GitHub issue, not bundled invisibly into unrelated work.

## Commands

```sh
npm run demo                       # http://localhost:5173, against assets/corpus-sample/
npm run demo -- --images <dir> [--center center.jpg] [--shared-dir assets] [--port 5173] [--config config.json] [--base-path /babel-index/]
npm run demo -- --favorites favorites.json [--trust-proxy 1]   # record global favorite counts
npm test                           # node --test, ~1s, no browser and no network
npm run test:e2e                   # browser smoke test; needs `npx playwright install chromium` once
npm run test:parity                # Canvas2D-vs-WebGL render parity; deploy gate, not a merge gate
npm run lint                       # config in eslint.config.js
npm run typecheck                  # tsc --noEmit -p jsconfig.json
npm run check:file-map             # docs/file_map.md vs the real tree, a required check (see its own header)
npm run check:requirements         # docs/search_requirements.md vs the tests' [SR-nn] tags, a required check
npm run check:requirements -- --list              # ... and print every requirement with the tests covering it
npm run check:requirements -- --update-baseline   # ... lower the allowed-uncovered list once a gap is closed
npm run generate:mips -- --images <dir> [--shared-dir <dir>] [--center <name>]   # write the resolution pyramid in place; --shared-dir also pyramids the center render + generic/ tiles there
npm run generate:embeddings -- --images <dir>   # CLIP image embeddings: embeddings.bin + .json (needs the optional transformers install)
npm run generate:animation                 # pack assets/animation/<cycle>/ frames into sprite sheets + manifest
npm run generate:shelf-geometry     # Recalculate diegetic control bounds from tools/center-placement/shelf_geometry.svg
```

- **Run Node scripts through `npm run`.** Each script passes
  `--import ./build/register.mjs`, a loader hook that transforms `.ts`/`.tsx`
  in memory with esbuild (`build/ts-loader.mjs`), because Node 20 cannot run
  `.ts` natively. Plain `node script.ts` fails with
  `ERR_UNKNOWN_FILE_EXTENSION`; an ad hoc run passes the `--import` flag
  itself.
- **No compiled output ever hits disk.** The demo server bundles the client
  with esbuild at startup (`packages/server/index.ts`), so editing a web
  source means restarting `npm run demo`. `packages/web/style.css` and
  `index.html` are re-read on every request and need only a browser refresh.
  The demo fails to start if its port is in use.
- **Linting is syntax-only.** It uses typescript-eslint's non-type-checked
  `recommended` config, since `npm run typecheck` owns type correctness.
  `eslint.config.js` carries the globals scoping and the react-hooks rule
  subset.
- **`typescript` is pinned to `^6`** until typescript-eslint can parse
  TypeScript 7 (typescript-eslint/typescript-eslint#10940). Don't bump it
  before then. Installing TS 7 beside an aliased TS 6 does not work: both
  packages ship a `tsc` bin, and npm picks which one `node_modules/.bin/tsc`
  points at by an undocumented rule.

## Layout

[`docs/file_map.md`](docs/file_map.md) lists every tracked file. It is part
of the change the same way code is: a file added, removed or renamed is not
done until the map says so, and `npm run check:file-map` fails CI when it
doesn't. One silently missing entry is how a module gets written twice.

The map omits unit tests: assume each module has a `{name}.test.ts` beside
it. Playwright specs are in
`packages/web/e2e`. Anything under `reference` is used only by the
inpainting pipeline.

## Conventions

- **ESM everywhere** (`"type": "module"`). Import Node built-ins with the
  `node:` prefix, and give every internal import its real file extension
  (`./port.ts`, not extensionless) - Node's resolver doesn't guess.
- **Node 20 is the floor** (`engines`), and CI runs 20/22/24.
- **Ask the maintainer before adding a dependency,** and keep them minimal.
- **Every file is TypeScript** (`.ts`, `.tsx`, tests `*.test.ts`), except
  the few that run where the loader hook can't: the hook itself (`build/`),
  `eslint.config.js`, `deploy/health-check.mjs` (run on the VPS), and
  `.claude/scripts/issues.mjs`. A new file is TypeScript unless it shares
  that constraint.
- **Loose data gets an honest type.** Where data is loose by design, type it
  as loosely as it is (`object`, `unknown`, a partial shape) until
  there is a real type to write. A strict type that fights the code's
  actual tolerance, or a lying assertion, is worse.
- **Tests sit next to the code**, using `node:test` + `node:assert/strict`.
  The `test` script `find`s the test files and passes them to `node --test`
  explicitly, because Node 20's `--test` neither discovers `.ts` nor
  expands globs. e2e specs are `*.e2e.ts`, outside that pattern.
- **`@huggingface/transformers` is optional.** `onnxruntime-node` ships only
  for win32/darwin/linux, the app is occasionally run on Android/Termux, and
  base functionality must not need CLIP. Never import it statically; see
  `tools/embed` and `packages/server/app.ts` for the dynamic import pattern.
- **`esbuild` is a runtime dependency**, since `packages/server/index.ts`
  bundles the client at startup.
- **Fixtures are synthesised, not committed.**
  `packages/server/image-fixtures.ts` builds PNG/JPEG/WebP headers byte by
  byte. Don't make tests depend on `assets/corpus-sample/`.
- **Formatting:** two-space indent, semicolons, single quotes, trailing
  commas in multi-line literals. Follow the file you're in.
- **A bug found during unrelated work gets fixed or filed, never just
  noticed.**
  - Trivial to fix (a wrong assertion, an off-by-one, a stale comment or
    pointer): fix it in the same pass.
  - Needs real investigation or design, or touches code you weren't already
    changing: open a GitHub issue (see "Tracking open work") with what was
    observed, how to reproduce it, and what is ruled out.
  - "Trivial" is about the fix, not the effort spent finding it. A fix that
    needs more than one e2e run to confirm belongs in an issue, unless the
    maintainer asked for that investigation.

## Comments and docs

**Comments are reference, not advocacy.** A comment tells the next reader
what is true of the code as it stands, quickly. It does not defend a design
to a skeptic or argue against the version it replaced. These rules apply to
code comments, this file, and everything under `docs/`.

- **Lead with the rule.** Line 1 of a comment is a standalone summary; a
  reader who stops there must lose no invariant.
- **One fact, one home.** State a fact fully where the thing is defined.
  Elsewhere, point or stay silent. A pointer names a symbol or a section
  title, never a position ("see `board.ts`", not "see the comment above"),
  and it must resolve - check every `see X` before committing, because a
  dangling pointer is a confident-looking lie.
- **Pin to a declaration, not a region.** One comment describes one thing
  below it. Split a paragraph that describes several things and re-attach
  each piece. A pinned comment moves with its code; a region paragraph goes
  stale quietly.
- **Keep hazards, drop ghosts.**
  - A hazard warns that a change here breaks something there ("`board.ts`
    refuses a margin under 1 because a tighter one lands the swap somewhere
    visible"). Keep it, as the main clause.
  - A ghost is prose about a design the code doesn't have: an argument
    against an alternative ("rather than folded into X", "not a number
    restated here that would only drift") or a note about a prior state
    ("X used to live in Y", "there is no longer a file for this"). Do that
    reasoning in your head, not the file; the alternative exists only in
    git.
  - Keep a history note only where a reader would otherwise trip: a
    redirect, a permanent alias, a link that still uses an old name.
  - Before finishing, sweep the lines you touched for "used to", "instead
    of", "rather than", "would only", "no longer", "anymore", "was
    migrated", "previously", "now". Most hits are ghosts.
- **Length tracks risk, and terse has a floor.** A few lines is the default.
  More is earned only where deleting a clause would let a careful reader
  introduce a real bug; in genuinely subtle code (`illusion.ts`,
  `scoring.ts`) long commentary is often correct. Never delete a hazard to
  look terse - condense or relocate it. A fact that keeps recurring across
  files wants one owning home, not another copy.
- **No color.** Leave out measurements, device names, incident narrative and
  closed issue numbers unless the reader needs them to act. Cite an issue
  only when it is open and the reader should follow it.
- **Plain declaratives.**
  - No shouting caps, and no conviction words: "exactly", "really",
    "deliberately", "on purpose", "load-bearing", "the whole reason". Emphasis
    comes from position and structure.
  - One clause per sentence, and real lists for list-shaped content.
  - Reference symbols, not their current values ("the buttons `BOOK_COUNT`
    generates", not "the forty buttons").
  - Don't cite section numbers in ephemeral docs (plans, task lists). A
    pointer into `docs/search_rules.md` or `docs/keyboard-controls.md`,
    which are kept in sync, is fine.
- **File headers and density.** A file opens with a block comment saying what
  it is for and which decision it embodies. Match the surrounding comment
  density, and don't narrate what the code does line by line.
- **ASCII hyphens, not em dashes,** in prose comments and markdown.

## Things that will bite you

### Tile geometry

- **`tools/center-placement/lib/measured.ts` is generated.** Never hand-edit
  it. Center-tile geometry is human-managed in `shelf_geometry.svg`, parsed
  with `import-shelf-svg.ts` (`npm run generate:shelf-geometry`), and
  validated with `npm test`.
- **Don't assume the tile aspect ratio; read it from `BASE_TILE`.** If it
  ever changes, update `BASE_TILE` in `pyramid.ts` and `shelf_geometry.svg`
  together and re-run `import-shelf-svg.ts`. Nothing else should need
  updating.
- **Don't pin art choices in tests.** Shelf spacing, book width, shelf count
  and book count are free to move. Assert only that books stay inside the
  opening, don't overlap, and each shelf has one baseline.
- **Only the center room needs exact geometry.** It carries the search box
  and controls; other rooms have none and need only bounding boxes.

### The map and its coordinates

- **The world's base unit is the cell, and a cell is not square.** World
  coordinates are in cells. `zoom` is pixels per cell *width*, and
  `camera.ts`'s `pxPerCell()` is the only place height is derived from it -
  never write `zoom` for both axes. Cameras carry an optional `aspect` and
  `limits`, so code that builds a camera spreads the old one rather than
  rebuilding `{x, y, zoom}`, or the shape and range are lost mid-gesture.
- **`packages/map` measures distance as it looks, not as it indexes.** Every
  distance goes through `cellDistance()` - `hypot(x, y * aspect)`, in cell
  widths - which makes the library round on screen. A raw
  `Math.hypot(x, y)` in that package is a bug. Placement uses the same
  metric: a circular boundary around an elliptical spread of rooms is empty
  at top and bottom.
- **The center room is cell (0, 0)**, and `packages/map` never assigns a
  corpus room there.
- **Corpus size and generic ratio are runtime parameters** to
  `createLayout()`. Growing the corpus keeps existing slots in place and
  appends further out; the sliders depend on that, and `ordering.test.ts`
  asserts it.
- **Only four things recompute placement.** A relevance re-sort is a swap of
  `order`: the map rearranges but does not reload. These rebuild the layout,
  each O(slots):
  - the generic-ratio slider;
  - the shuffle button, which rerolls `seed` (which cells are content slots)
    alongside `order`, and first clears any active search or favorite sort,
    since either one pins the layout it would otherwise rescatter;
  - a search, and an active favorite sort (`'mine'`/`'count'`), which are
    placement inputs through their strength profiles (see "Distance from the
    center carries one meaning at a time").
- **The map is virtualized canvas.** Do not mount thousands of DOM nodes.

### The center tile and its generic tiles

- **The center and a generic tile are different images.** Cell (0, 0)
  always draws the blank `center_tile.png` (the `CENTER` tile id). Every
  generic cell draws one of the inpainted generic tiles (`genericId(i)`),
  never the blank tile. `genericId(-1)` is `CENTER`, the fallback only for a
  corpus with no generic tiles.
- **Which generic tile a cell shows depends only on its coordinate.**
  `layout.genericIndexAt(x, y)` is a seeded hash of the coordinate, so a
  reorder never changes a generic cell's face. That lets `board.ts` and
  `illusion.ts` treat every generic cell as one interchangeable `GENERIC`
  value (`roomAt`'s `{ generic: true }`). The renderers are the only places a
  cell resolves to a tile id; `slide.ts` reads the generic index at each
  tile's *home* cell, so a sliding line keeps its faces mid-ride.
- **The shared tiles live outside `--images`.** `scan.ts` finds them in
  `--shared-dir` (default `assets/`): the center by name (`center_tile.*`,
  else `center.*`, else `--center`), and the generic tiles as every image in
  `generic/`. They ride in the manifest as `shared: { center, generic }` and
  are served from `/shared/`, not `/images/`. A `center.*` in the corpus dir
  counts as a generic tile only when `sharedDir === imagesDir`.
- **Shared art has its own pyramids, in separate manifest arrays that are
  not interchangeable.** `generate:mips --shared-dir`
  (`packages/pipeline/shared-mips.ts`) writes the same per-file
  `<width>/<file>` ladder a room gets, never packed into sheets, and
  `scan.ts` discovers what is on disk:
  - `shared.levels` is the intersection of the center and generic trees; a
    level counts only where every one of those files has it.
  - `shared.distillLevels` (`generic_distill/`) is never intersected with
    `levels`, because not every generic tile has a distill alternate.
  - `shared.favoriteLevels` covers the hand-tuned favorite badge art; see
    "The on-map badge".
  - Every other shared id (the distill toggle's faces, the forget-searches
    overlay) is flat level-0 art, reached through `servableLevel`.

  `main.tsx` pins the center at level 0 and each generic or distill tile at
  the coarsest level its own array has - never a hardcoded `FALLBACK_LEVEL`,
  since a corpus with no shared pyramid has only level 0. `drawGenericFade`
  (and its GL and slide counterparts) draws the distill alternate at the
  base tile's level: distill is a mode toggle, visible at any zoom.

### The center room's controls

- **`center.ts` is the pure half, and the geometry comes from the tools
  tree.** The book layout, `assignTitles`, the hit-test and `pickTags` live
  in `packages/web/src/lib/center.ts`, tested browser-free in
  `center.test.ts`. A book is one flat slot id (`BOOK_COUNT` of them), top
  left to bottom right. The hit-test walks `center.ts`'s `RUNS`, not
  `GEOMETRY.shelves`, so a gap in a shelf resolves to no book. The rects come
  from `layout({ width: 1, height: 1 })` in
  `tools/center-placement/lib/geometry.ts`, the one module the tile trace
  feeds.
- **The fractions are per-axis.** The renderers stretch the center tile's
  width to `cellPx.x` and height to `cellPx.y` independently, so a spine
  rect is `{x, w}` against the cell width and `{y, h}` against its height.
  One divisor for both axes silently stretches everything.
- **Spine compositing is content, and it is zoom-gated.** It draws on the
  center cell whenever `centreSlots` is passed, and `composeSpines` draws
  nothing below a legible spine width. `render.test.ts` never passes
  `centreSlots`, which keeps its recording `fakeCtx` free of
  `save`/`rotate` and its byte-cost assertions stable.
- **The books are DOM buttons and painted spines, with one `onBook` for
  both.**
  - `.center-books` is one container positioned once per frame in per-axis
    percentages. Don't position each button per frame from
    `bookScreenRects()`.
  - The container is `pointer-events: none`, so a click routes through the
    canvas's `onTap` -> `bookAtPoint` -> `onBook`. A second copy of "what
    book i does" in either path will drift.
  - The shelf is one tab stop (roving tabindex), with arrow-key movement in
    `center.ts`'s `bookNeighbour`. `areSpinesLegible` is the single zoom gate
    that keeps a reader from tabbing to a book nobody can read.
- **The center cell's DOM overlays are sized to the whole cell, and `#root`'s
  clip keeps them off the page.** `.center-search`, `.center-books`,
  `.center-book` and `.center-controls` are several screens wide at reading
  zoom. A phone responds to that by shrinking the page scale, which drags
  every dialog and the map's paint size with it. `#root`'s `overflow: clip`
  in `style.css` prevents it (its comment explains why `clip` and not
  `hidden`); `map-gestures.e2e.ts`'s "zooming in never grows the page past
  the viewport" guards it.
- **`onTap` loses to a pan, a flight, and a long-press.** It fires only on a
  pointer-up that stayed within the slop and did not stop a flight, and a
  completed long-press clears the tap candidate.
- **Two opening views, and they are not interchangeable.**
  - The page-load view (`main.tsx`, `fitZoom` at mount) frames the center
    shelf so its spines are legible. `center.ts`'s `openingZoom` caps it at
    1x so a load is never upscaled.
  - The return-to-center view (`overviewZoom`, recomputed at each call site:
    the center button, a room double-tap, the rearrangement's park) frames
    `config.camera.minVisibleCells` whole rows/columns, so a rearrangement
    has rooms to slide across.

  Collapsing them breaks whichever view loses. `camera.ts`'s
  `fitZoom`/`overviewZoom` comments carry the derivation.
- **The zoom cap is `MAX_ZOOM_FACTOR` times the tile's native width**,
  derived in `camera.ts`'s `ZOOM_LIMITS`. A reader may zoom past 1x by hand
  to read a spine. Raising the cap breaks the "tile too large to reach"
  example in `pyramid.test.ts`; that is the test doing its job.

### Search and the density gradient

- **Search blends three signals into one sort; it does not tier them.**
  Every signal is normalised to [0, 1] before weighting, and the CLIP term
  is min-maxed across the corpus for that query. Tiering keyword hits ahead
  of everything would let one weak partial beat a room CLIP is certain about.
- **A query is matched term by term and as one whole string, and the better
  reading wins.** `rankHybrid` classifies each term against a room's
  keywords and title, then the whole folded query the same way, so a
  multi-word tag typed plainly (`outsider art`) is an exact match. A keyword
  chip searches its text unquoted, and many real keywords are multi-word. A
  whole-query match counts as one exact match, so two separate exact tags
  still outrank one matched phrase.
- **Keyword partials divide by the keyword; story matches divide by the
  query.** `art` matches only 3/11 of `art nouveau`, but a hit in a long
  story is worth the same as in a short one.
- **The density gradient is one formula**
  (`contentRatio + (peak - contentRatio) * strength`, walking outward), not
  special cases for cluster, falloff and no-match. Strength must stay
  non-increasing with rank, and anything under `STRENGTH_FLOOR` snaps to the
  baseline; both are asserted.
- **Distance from the center carries one meaning at a time, so a search and
  a favorite sort are mutually exclusive** (`docs/search_requirements.md`
  SR-24, SR-27, SR-28, SR-41).
  - A real (non-empty) search ends an active favorite sort: `useSearch.ts`'s
    `search` calls `onSearchStart` before the fetch.
  - A favorite sort or `'random'` ends an active search: `changeSort` calls
    `clearSearch()` for any mode but `'relevance'`.
  - Clearing the search box (the clear-x, an empty submit) is not starting a
    search and must not touch the sort.
  - Because the two never run at once, `main.tsx`'s `sortResult` reads
    whichever strength is active (`result.strength`, or
    `packages/map/favorites.ts`'s `favoriteStrength`), and nothing composes
    the two. `'relevance'` and `'random'` claim no strength and leave the
    map uniform.
- **Strength is absolute; ranking is relative. Don't feed one the other's
  numbers.** The blend min-maxes CLIP, so some room scores 1 for *any*
  query; a gradient driven by that clusters nonsense as confidently as an
  exact match. `matchStrength` reads raw cosines against absolute bounds
  (`CLIP_STRENGTH`, config `search.density.clipCentre/High`).
- **`embeddings.bin` is keyed by row order; `metadata.json` by filename.**
  `scan.ts` rejects a blob whose row count drifted. The sidecar joins per
  file, so a partial match is just partial - but `matched: 0` against
  non-zero `entries` means the keys drifted, which `index.ts` warns about.
- **A room's optional `alt` is an image caption, not a story.** It goes on
  the real `<img alt>` (`RoomOverlay`, the catalog thumbnail) and never feeds
  the search index. The map canvas's fallback content (`RoomDetails`'s
  `showPicture`) renders it as a paragraph, since it has no `<img>`. Don't
  write placeholder captions into `assets/corpus-sample/`.
- **`tagLinks.json` is a flat keyword -> url map, not joined to anything.**
  It is hand-edited and optional; `scan.ts` only counts its keys, and a
  corpus without one renders chips with no "more about this" link.
  `RoomDetails.tsx` receives it as a prop (see `useCorpus.ts`).

### Favorites

- **A count is a set's size, never a counter.** `packages/server/favorites.ts`
  stores, per room, a set of `HMAC(salt, file + NUL + clientId)`. Adding
  twice is one favorite and removing what was never there is nothing, so no
  request can zero a room or run it up. Replacing the set with an increment
  loses that.
- **The hash is per room.** One visitor hashes differently in every room's
  set, so sets cannot be joined into one person's list, and the store cannot
  count distinct visitors. That is intended. Hashing de-duplicates; it is not
  a security control.
- **Identity is a client-generated token, not `req.ip`.** The browser mints
  a random id once (`persist.ts`'s `getOrCreateFavoriteClientId`) and sends
  it as `X-Favorite-Client`; `app.ts` rejects one that fails
  `CLIENT_ID_PATTERN`. Addresses collide real visitors behind NAT and split
  one visitor across rotating IPs. A regenerated token only reverts a
  visitor to "not yet favorited"; the set semantics are what stop abuse.
- **Favorites are keyed by filename everywhere** - server, `localStorage`,
  and `packages/map/favorites.ts`. Room ids are positional (`scan.ts` sorts
  filenames), so adding one image renumbers every later id, and a stored id
  would silently point at a different room.
- **Favorite writes are rate-limited by `req.ip`**, a different key than
  identity, because a script can mint a fresh token per request for free
  (`app.ts`'s `createRateBuckets`). Behind a reverse proxy, `req.ip` is the
  proxy, so without `--trust-proxy` every visitor shares one bucket. The flag
  stays off by default: trusting `X-Forwarded-For` where nothing strips it
  lets a client choose its own rate budget. The proxy must send
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.
- **No store, no feature.** Without `--favorites` the routes are not mounted
  and `manifest.favorites` is null, which every consumer reads as "render no
  favorite control" - distinct from a count of zero.
- **A relevance sort is a re-rank, and the catalog row's toggle is in the
  head.**
  - In `'relevance'` mode, sorting swaps `order` (the reorder animation's
    path) and never rebuilds the layout. A favorite sort is a placement
    input; see "Only four things recompute placement".
  - A catalog row is a fixed height, so its favorite control sits beside
    "show on the map", not inside `RoomDetails` as on the card and overlay.
    In the text column it would cost two story lines on every row.
- **The on-map badge is the third favorite control, and it is fixed art,
  not a scanned corpus asset.** `assets/fav_on.png`/`fav_off.png`
  (`tiles.ts`'s `FAV_ON`/`FAV_OFF`) resolve off `manifest.sharedBase`
  directly; `scan.ts` discovers only their scaled pyramid
  (`shared.favoriteLevels`). The renderers draw it on every non-center,
  non-generic cell; `favoriteBadge.ts` is the pure geometry and hit-test
  half. Two separate zoom gates:
  - **Drawing needs an exact pyramid level.** The scaled art is hand-tuned
    and stops at tile width 128. `drawFavoriteBadge`/`drawFavoriteBadgeGL`
    skip the cache's coarser-or-finer substitution: the badge's screen size
    tracks the tile regardless of which rung backs it, so a substitute
    would only be blurrier.
  - **Interaction needs `config.favorites.minInteractiveTileWidth`.** The
    tap handler (`main.tsx`) and hover path (`useMapRenderer.ts`,
    `useMapRendererGL.ts`) check it before hit-testing `favoriteHitRect`,
    which is padded to `MIN_FAVORITE_HIT_TOUCH` on a coarse pointer.

### The reorder animation

- **A rearrangement is a sliding-tile illusion.** Rooms travel only as part
  of a whole row or column rotating. `illusion.ts` rejects a `swap` (which
  reads as teleportation) if either end is on camera. Don't add a move type
  that moves one cell.
- **The illusion bounds are the viewport plus one cell.** The planner swaps a
  value into the cell just outside the region and slides it inward.
  `board.ts` refuses a margin under 1 because a tighter one lands that swap
  somewhere visible.
- **The center room is the planner's fixed tile**, holding the same value in
  both boards, which is why the map visibly pivots around it. This is about
  the board, not where the camera is parked.
- **The board is finite only because the camera is parked** for the whole
  animation, wherever it already was: `startRearrangement`
  (`useRearrangement.ts`) zooms out in place, not home to the center.
  - A pointer grab (`onDown` in both render hooks) ends the rearrangement,
    since a pan cannot be honored while the slide runs.
  - A control's `flyTo` (the center button, zoom buttons, keyboard pan)
    does not end it, and is overridden by the rearrangement's own next
    `flyTo`. The controls currently stay enabled while they are inert
    (issue #306).
- **While zooming out to start, the map still draws the old arrangement**
  (`anim.current.before`) until the camera lands. Without that hold the map
  shows the new library, zooms to it, then slides in from the one it
  already replaced.
- **The plan is built and fetched before the flight starts.**
  `prepareRearrangement` (`useRearrangement.ts`) simulates the moves to find
  every room the slide will show - more than the before and after
  viewports, since a line rotates whole - and fetches them, waiting up to
  `config.slide.prepareTimeoutMs`. Past that budget, or if the reader
  interacts, it falls back to an instant rebuild.
- **`board.ts` returning null is a real answer, not a failure.** With the
  rooms-on-the-map slider pulled back, a room the new order wants on camera
  may never have been on the old board. The caller falls back to an instant
  rebuild, discovered during prepare, before any flight.
- **A reserved cell is never a source** (`makeAvailable` skips them).
  Otherwise a copy staged for one slot is handed back for another, and the
  first reservation points at a cell holding something else.
- **A rearrangement announces its outcome after the camera settles**, which
  moves the screen-reader cursor without a keypress. Tests asserting the
  canvas `aria-label` must establish their own camera rather than assume
  the page is where it loaded.
- **Visible cost is the viewport's, not the corpus's.** Every move outside
  the region is an invisible swap, so a slide count that scales with corpus
  size is a bug.

`illusion.test.ts` documents the staging and batching mechanics.

### The loading indicator

- **It fills the preload pause, and the flight waits for it.**
  `startRearrangement` starts a cycle when `prepareRearrangement` begins, and
  holds the flight until a cycle boundary with at least one full cycle
  played (`loadingAnimation.ts`'s `finish()`). A warm-cache rearrangement
  still pauses for one cycle; that is intended.
- **The center-tile indicator plays only when the center shelf is legible
  on screen** (`overlapsViewport(cellRect, ...) &&
  areSpinesLegible(cellRect)`). Otherwise nothing plays and no cycle-wait is
  imposed. The search badge's ring (`SearchIcon.tsx`'s
  `SearchOrbitSpinner`) spins over the same preload window regardless of
  that gate, driven by `useRearrangement.ts`'s `onPreparingChange`.
- **The controller owns its own rAF loop,** because the map's render loop is
  on-demand and doesn't repaint during the wait. It calls the `requestDraw`
  it was handed each tick, and the renderer pulls the frame through
  `frame()`. A grab mid-preload calls `cancel()`, which stops the loop and
  resolves the pending `finish()`, ending the rearrangement.
- **`drawLoadingFrame` is drawn in both renderers, in lockstep** (see "The
  WebGL renderer").
- **The frames are a build artifact, served like fixed art** from the shared
  dir (`assets/animation/`), resolved off `sharedBase`; `scan.ts` discovers
  nothing here. A missing manifest means no indicator, read as null
  everywhere. The e2e suite's `--shared-dir` has no manifest, so e2e never
  sees the indicator.
- **The dev panel's "loop loading animations" checkbox owns the screen while
  on** (`startDebug`): a rearrangement's `play()` no-ops.

### Camera and gestures

- **`flyTo` returns a promise for the landing.** `cam.current` has not moved
  when it returns, and the promise resolves false if a hand hit the map
  mid-flight.
- **A handler chaining a move off camera state reads `flightTarget()`, never
  `cam.current`.** `cam.current` is the flight's interpolated position, so
  two key-repeat presses in one frame both compute the same target and cancel
  instead of compounding. The same applies to the cursor cell.
- **Keyboard and pointer panning share `damp` but not its curve.**
  `panByPixels` floors its scale so a drag never feels frozen. A held arrow
  key auto-repeats, so the same floor would be a constant outward velocity
  that never stops. `panByCells` uses `damp` unfloored, and inside the content
  region (`damp === 1`) snaps cell-centered so a boundary trip doesn't
  offset the grid.
- **The edge glide applies to keyboard input too.** The boundary pushback is
  an affordance and must fire with no pointer involved. For
  `prefers-reduced-motion`, `glideToRest` runs the same step function to
  convergence; there is no closed form.
- **A flight interpolates zoom geometrically and position linearly,** on the
  glide's rAF loop - don't start a second loop. `pointerdown` and `wheel`
  each drop an in-flight animation.
- **Pointer capture is best-effort.** `setPointerCapture`/
  `releasePointerCapture` can throw `NotFoundError`, which is ordinary on
  touch. Do the `pointers` map bookkeeping before the capture call, not
  gated by it.
- **The overlay opens on right-click or long press, never left-click** (left
  focuses the room). A long press loses to a pan: its timer lives on the
  pointer stream, so moving past the slop radius cancels it.

### Config and the pyramid

- **No `config.json` is committed, and config never throws.** A committed
  file spelling out every value would become the real surface. Every
  adjustment lands in `notes`, printed by the server, because a value
  silently not taking effect is the one failure a tuning file has.
- **Consuming files state no fallback defaults.** They read values from
  config with nothing restated locally.
- **Zoom config narrows, never widens.** `camera.ts`'s `ZOOM_LIMITS` is the
  only statement of the hard range. The configured range rides on the
  camera as `limits` (see "The world's base unit is the cell").
- **Every pyramid number lives in `packages/web/src/lib/pyramid.ts`** - tile
  dimensions, the ladder, cache budgets, the prefetch ring. `tiles.ts` and
  the render loop read it rather than restating it.
- **A level is per-file or sheet-packed, never both on disk.** The pipeline
  writes every level per-file, composites levels at or above
  `SHEETS.fromLevel` into `<width>-sheets/`, then deletes those per-file
  directories. `scan.ts`'s `discoverLevels` prefers a complete sheets
  directory and falls back to per-file.
- **Tile eviction is frame-aware.** The renderer walks cells row by row, so
  a plain LRU would evict the top of the screen for its own bottom.
  `tiles.ts` won't evict anything stamped in the current or previous frame,
  so the render loop must call `beginFrame()` once per frame.

### Deployment and the base path

- **`--base-path` does not change how Express routes anything.** Every route
  in `app.ts` is mounted unprefixed. The VPS's nginx config
  (`deploy/babel-index.nginx.conf`, `deploy/README.md`) strips the prefix:
  `location /babel-index/ { proxy_pass http://localhost:5173/; }`, trailing
  slash on both sides. An Express-side mount at the same prefix would strip
  twice and 404 everything.
- **Every url this server hands the browser is relative.** A root-absolute
  url (`/api/manifest`) resolves against the origin root, above the subpath,
  and never reaches the proxy. `scan.ts`'s `IMAGES_BASE`/`SHARED_BASE` and
  the client's `fetch()` calls (`main.tsx`, `useSearch.ts`) have no leading
  slash. A new one with a leading slash works at the root and breaks the
  deployment.
- **`<base href>` makes a relative url resolve under the subpath,** so
  `app.ts` injects it immediately after `<head>`. `base-path.ts`'s
  `normalizeBasePath` is the one place the flag's slashes are decided.
- **A bare visit to the subpath must redirect to add the trailing slash**
  (nginx's `location = /babel-index { return 301 ... }`). Until the page has
  loaded and set `<base href>`, a relative url resolves against the last
  `/`-terminated segment of the document location.
- **`--base-path` is meaningless without the proxy.** Hitting
  `localhost:5173` directly with the flag set serves a page whose every
  relative fetch 404s. That is expected; test the subpath behind nginx.

### Deploying to the VPS

Setup and rollback are in `deploy/README.md`. The invariants:

- **A 200 is not a successful deploy.** An old process surviving a failed
  restart, a unit pointing at another checkout, or a moved `--images` dir all
  answer 200. `/api/health` reports the running commit, and
  `health-check.mjs` compares it to the sha being deployed. A release on the
  right commit with zero rooms fails immediately rather than retrying.
- **`version.ts` is read once at startup, never per request.** Re-reading
  `.git` would report the checkout, not the code in memory - the mismatch
  the health check exists to catch.
- **The deploy key is an SSH forced command pinned to `deploy/deploy.sh`.**
  The requested sha must match 40 hex characters and already be an ancestor
  of `origin/main`, so the key can deploy or roll back only what reached
  main. Loosening either check turns a narrow credential into a login.
- **Both halves of the health check run.** `deploy.sh` checks `127.0.0.1`
  (did the unit come back on the new code?). The workflow re-checks the
  public url (can anyone reach it?), which is the only one that sees a
  broken reverse proxy.
- **A failed deploy is not rolled back automatically.** It stops and prints
  the previous sha, and the workflow's dispatch input takes a sha, so a
  rollback is one manual run. An automatic rollback would pair a
  working-looking site with a red workflow, easily misread as flaky CI.
- **`deploy.sh` runs as the version already on the box**, since it checks out
  the new revision partway through its own run. A change to it takes effect
  one deploy late.

### Release discipline

- **The PR title is the only release input.** The repo squash-merges, so a
  PR's title becomes the commit subject `release-please.yml` reads for the
  version bump and `CHANGELOG.md`. `pr-title-lint.yml` requires Conventional
  Commits format (`feat: ...`, `fix: ...`). The PR description and
  individual commits are read by nothing downstream.
- **Mark a breaking change with `!` on the title** (`feat!: ...`). A
  `BREAKING CHANGE:` footer in the description does not survive the squash.
- **Releasing is a second PR.** `release-please.yml` keeps a standing release
  PR up to date; nothing is tagged, versioned or changelogged until a human
  merges it. Never hand-edit `package.json`'s `version` or
  `.release-please-manifest.json`.
- **`deploy.yml` deploys only the release merge.** Its `if` matches a head
  commit starting `chore(main): release `, so an ordinary merge to main
  builds and tests but never ships. `workflow_dispatch` is the hatch for an
  urgent fix between releases.

### The catalog, and the two modes

- **The map is hidden, never unmounted.** `.map-view` toggles between
  `display: contents` and `display: none`, and the render loop returns early
  when `mode !== 'map'`. A remounted canvas comes back with no pointer
  listeners, because `useMapCamera`'s listener effect reads
  `canvasRef.current` once: the HUD still reads correctly and the map never
  pans again. `catalog.e2e.ts`'s "the map is where it was left when the
  catalog closes" drags after a mode switch to catch this. Hiding also keeps
  the tile caches warm.
- **A room's permalink is its title, and `packages/map/slug.ts` decides it
  for every caller.** The server, the sitemap and the overlay's copy-link
  button all read `buildSlugTable`. A room's filename stem is a permanent
  alias that redirects to the title url, so links survive a retitle. A room
  id never reaches a path, since ids are positional. Two rooms with the
  same title each get their stem as a suffix, and `roomContent.ts` warns at
  startup.
- **The catalog is not the accessibility mode.** It is a control offered to
  everyone: nothing detects a screen reader or defaults into it, the panel's
  ranked listbox stays, and `role="application"` stays scoped to the canvas.
  The catalog is a `<ul>`, not a listbox, because its rows contain keyword
  chips.
- **One live region for the whole app, outside both views,** so a mode
  switch can't unmount it. `.note` holds only the static hint and must never
  share a node with `role="status"`.
- **Rows are a fixed height and the spacers are arithmetic, not
  estimates.** `spacerHeight` stands in for unmounted pages to the pixel, so
  recycling a page never moves the scroll position. Anything that makes row
  heights vary - expanding a story in place, letting chips grow the row -
  turns the spacers into estimates. A row is a fixed-height flow area plus
  the score strip below it, so match strength is never pushed off the card.
  The center room's row is the exception, sized to its content outside the
  paging arithmetic. `catalog.ts`, `CatalogView.tsx` and `style.css`'s
  `.catalog-flow`/`.score-strip` comments carry the layout mechanics.
- **A room row's thumbnail floats, and the story wraps around it.** So the
  story is cut by a measured `max-height`/`overflow: clip`, not
  `-webkit-line-clamp` (whose block formatting context would stop the
  wrap), and "did this row cut something" asks the story's own
  `scrollHeight`, not the card's. The center room's row can't float: its
  picture and spines share one CSS grid so both land on the same column
  lines. `style.css`'s `.catalog-row .story` comment has the details.
- **What a row cannot show, it counts.** `chipLines` sizes the chip box from
  the row's real leftover height, and whatever doesn't fit becomes a `+N`
  chip (`RoomDetails`'s `chipOverflow`) that opens the room. The counter is
  absolutely positioned and skipped when counting, since it is rendered from
  a measurement of the box it sits in.
- **A fixed row cannot show everything, so the overlay is not optional.**
  `RoomOverlay` shows the full tile and story, reached from the thumbnail and
  from a clipped story's "read the rest". `TEXT_CHROME_PX` reserves room for
  that button on every row, including rows that don't show one, or it is
  clipped away on the narrow displays that need it.
- **Pagination and infinite scroll are one primitive with a different
  window.** Both slice `pageOf`; pagination passes `windowPages: 0`, so a
  room sits at the same position however the reader pages. `windowFor`
  widens the window when a screenful spans more pages than the budget
  mounts.
- **Highlighting mirrors the match rules.** `scoring.ts` has two range
  finders beside the scorers - substring for keywords and titles, prefix for
  story words - fed the same folded query and tokens the ranking used, so a
  token that didn't score can't mark. `useSearch`'s `highlight` is the only
  source of "what matched"; don't re-derive it in a component. Only a real
  title is marked, never the "Room N" fallback.
- **Folded offsets are not source offsets.** NFD, mark-stripping and
  lowercasing change length, so highlighting maps positions through
  `scoring.ts`'s `foldWithMap`. A folded index used on the original text
  misplaces every mark on accented text.
- **The CLIP row of a score breakdown must show its raw cosine.**
  `breakdown.clip` is min-maxed per query, so some room scores 1.00 even for
  `cghjj`. `explainRanking` prints the raw cosine beside it, with strength
  on its own line.
- **Namespace catalog CSS.** `.row` belongs to the dev panel, so an
  unprefixed `.row` rule reaches into its slider rows. The reverse also
  bites: the panel's global `button { flex: 1 }` stretches any button the
  catalog doesn't opt out. `.chips`, `.story`, `.picture` and `.score` are
  shared by design, from `RoomDetails`.
- **The query length cap is enforced in `search()`, not the input.**
  `maxLength` covers only typing; a keyword chip, a shelf book and a restored
  history entry all call `search()` directly. Scoring is O(tokens x keywords)
  per room, so an uncapped paste stalls the page.

### The WebGL renderer

WebGL is the default renderer; Canvas2D (`render.ts`/`slide.ts`) is the
second.

- **The two renderers are separate implementations kept in lockstep.**
  `glRenderer.ts`/`glSlideRenderer.ts` make the same per-cell decisions as
  `render.ts`/`slide.ts` (pyramid level, what each cell draws, badge gating,
  prefetch order) with `gl/context.ts`'s quad primitives. A change to either
  draw loop needs the matching change in the other. `GLDrawOpts`/
  `GLDrawResult` derive from `render.ts`'s `DrawOpts`/`DrawResult`, so a
  shape change fails typecheck. Behavior drift is caught by
  `npm run test:parity`; run it by hand when touching either loop.
- **GL setup happens once per canvas element's lifetime.**
  `gl/context.ts`'s `createGLContext` creates a new shader program, VAO and
  buffer on every call, and only its `dispose()` frees them.
  `useMapRendererGL.ts`'s canvas-lifetime effect (dependencies
  `[canvasRef, cache]`) keeps it to once. Adding a dependency that changes
  often (a search, a favorite toggle) leaks GPU resources.
- **The texture cache has its own eviction budget.** `gl/textureCache.ts`
  follows `tiles.ts`'s frame-aware LRU rule but keeps a separate budget,
  since GPU memory is a different resource from `pyramid.ts`'s decoded-byte
  budget. It is a strong `Map` with explicit eviction; a `WeakMap` would
  never free GPU handles, since garbage collection runs no cleanup code.
- **The renderer default lives in `webglFlag.ts`.** `DEFAULT_WEBGL` is
  `true`. `?webgl=0` (or `off`/`false`/`no`) forces Canvas2D, and `WEBGL`
  falls back to Canvas2D when `supportsWebGL2()` fails. The parity suite's
  Canvas2D session and readers hitting a GL glitch depend on `?webgl=0`;
  keep it while Canvas2D exists.

### Testing and CI

- **Required checks:** `npm test` across the Node matrix, `e2e.yml`, lint,
  typecheck, `check:file-map` and `check:requirements` all feed `ci.yml`'s
  aggregate `ci` job.
- **`check:requirements` maps tests to `docs/search_requirements.md` by tag.**
  A test names the requirement it covers in its own name
  (`test('... [SR-18]', ...)`); the checker rebuilds the mapping from
  `git ls-files` each run. An `SR-nn` id is permanent (that file's header
  states the rule). The check fails on a tag naming no requirement, and on a
  requirement losing coverage `baseline.json` says it had. Gaining coverage
  prints the command that lowers the baseline. A `_(judged)_` requirement
  has no failing assertion and is counted apart from the gaps.
- **`check:file-map` diffs `docs/file_map.md` against `git ls-files`** (see
  "Layout"; `tools/check-file-map/index.ts`'s header has the exact rules).
- **`npm run test:parity` is a deploy gate, not a merge gate.** The
  `.parity.ts` suffix matches neither the unit nor the e2e glob. `deploy.yml`
  runs it before the ssh call, and a failure stops the deploy. It runs on a
  CI runner's GPU-less Chromium (SwiftShader WebGL2). Its header explains
  the scene choices.
- **e2e specs pin their renderer with `openLibrary`'s `webgl` option.** Every
  spec but `webgl-map.e2e.ts` passes `webgl=0`, because the blank/repaint
  probes (`fingerprint`, `getImageData`) need a 2D context. An unpinned spec
  would silently switch renderer with the production default.
- **When to run e2e locally.** On the maintainer's machine (Arch Linux per
  `/etc/os-release`) Chromium is preinstalled and the suite is cheap: run it
  whenever a change touches tested behavior. In a cloud agent container it
  is slow; run it only when editing e2e specs or behavior they exercise
  (the rearrangement, camera or search state machines), and otherwise rely
  on `npm test`, lint, and CI's e2e gate.
- **Wait on a condition, never a duration.** A flaky browser test blocks
  every merge. `settled()` waits until the HUD stops starting with
  `"rearranging"`, which covers prepare, flight and slide, but not the
  network: anything asserting on `blank` tiles or HUD text polls (bounded)
  rather than trusting the first read.
- **Where settling matters, poll for two agreeing reads with a real gap
  between them.** Two reads either side of a slow call can describe two
  different renders; two back-to-back reads prove nothing.
- **Test cleanup belongs in `finally`.** The tests in one `*.e2e.ts` file
  share one `page`, so skipped cleanup strands slider and camera state for
  every later test, turning one flake into several failures.
- **A green e2e test that cannot fail is worse than none.** When you change
  one, break the app and confirm the test fails. That includes
  its cleanup.
- **Assert on the accessible name, not raw ARIA attributes.** Attribute
  behavior differs across Chromium builds, and CI and local can run
  different ones (`BABEL_E2E_CHROMIUM`). Anything a reader must hear belongs
  in the label.
- **An accessibility assertion dumps the node it failed on,** since the
  failing run is usually on a machine you can't open a browser on.
- **CDP touch injection bypasses real gesture arbitration.** The touch tests
  in `map-gestures.e2e.ts` can't see `touch-action`, `pointercancel` or the
  real capture lifecycle. Confirm suspected gesture bugs on a device with
  `?touchdebug`.
- **A 'center' click during a rearrangement does nothing** (see "The board
  is finite only because the camera is parked"). A test whose setup may
  follow a search uses `e2e/support.ts`'s `recentre()`, not a bare click.

## Tracking open work

- **Open work lives only in
  [GitHub issues](https://github.com/centuryglass/babel-index/issues).**
  Nothing in the repo tracks tasks.
- **A found bug that isn't a same-pass fix opens an issue**: what was
  observed, how to reproduce it, and what is ruled out.
- **A fact worth knowing is not a task.** It belongs in the owning module's
  comment, or here.
- **A PR closing an issue says `Closes #NN` in its description.**
- **Open issues are usually already in context.** The `SessionStart` hook
  (`.claude/hooks/session-start.sh`) runs `.claude/scripts/issues.mjs`, which
  writes `.claude/cache/issues/` (`index.md` plus one file per issue) and
  prints the index. The cache is generated and gitignored; never edit it or
  treat it as the source of truth. `issues.mjs`'s header covers the fetch
  paths and `BABEL_INDEX_ISSUES_TOKEN`.
- **When the hook produced nothing** (rate-limited, no token, or an agent
  that doesn't run Claude Code hooks), build the cache by hand before
  concluding no issue covers something: fetch the list with whatever tool
  you have (the GitHub MCP `list_issues`, `gh issue list --json ...`) and run
  `node .claude/scripts/issues.mjs --from-json <path>`, then read
  `.claude/cache/issues/index.md`.

## Comment and documentation audits

When the maintainer asks for a comment or documentation audit ("run a
comment style audit on this change", "spot-check these comments"), the
audit process and its code-preservation tool live on the
`qwen3.8-flash-comment-fix` branch, not `main`. Pull them in, do the pass,
and remove them before committing.

Fetch the branch if needed (`git fetch origin qwen3.8-flash-comment-fix`),
then copy four files to their real paths so the plan's cross-references
resolve:

```sh
git show qwen3.8-flash-comment-fix:docs/comment-refactor-plan.md > docs/comment-refactor-plan.md
git show qwen3.8-flash-comment-fix:docs/claude_critique.md > docs/claude_critique.md
git show qwen3.8-flash-comment-fix:tools/comment-check/check.mjs > tools/comment-check/check.mjs
git show qwen3.8-flash-comment-fix:tools/comment-check/strip.mjs > tools/comment-check/strip.mjs
```

- `docs/comment-refactor-plan.md` is the process: the tell-and-move table,
  the spot-check workflow (its §3), and the verifier's contract (its §4).
  Read it first.
- `docs/claude_critique.md` is the diagnosis behind those tells, with
  evidence. Read it when a judgment call needs the reasoning.
- `tools/comment-check/check.mjs` imports `typescript-classic` from a
  gitignored `tools/comment-check/node_modules`. If that install is missing,
  pull the directory's `package.json` and run
  `npm --prefix tools/comment-check install`, or use the plan's §4 esbuild
  fallback (weaker: it can't see a type-only change). Don't pull
  `strip.test.mjs`; `npm test` picks it up and it fails without that
  install.

Rewrite comment text only, scoped to the sections the change or request
touched plus comments a fix makes untrue. Then prove no code moved:

```sh
node tools/comment-check/check.mjs <file>...              # working tree vs HEAD
node tools/comment-check/check.mjs --base <rev> <file>...  # vs another revision
```

- Every edited file must report `OK (comment-only)` or `clean (unchanged)`.
  A `-/+` listing of code lines means code moved; fix it before committing.
- `check.mjs` parses JS/TS/CSS/HTML only. For `.md` edits, confirm from
  `git diff` that only prose changed.
- `npm test`, `npm run typecheck` and `npm run lint` still apply.
- When done, delete the four pulled files (and any nested install), and
  stage only the real edits by explicit path.

## Working with GitHub

- **Don't ask whether to subscribe to a PR you just opened.** If the
  maintainer wants it watched, they'll say so.
- **An issue or comment an AI agent writes under the maintainer's account
  ends with a footer marking it as AI-generated**, e.g.
  `_Drafted with AI assistance._`, so it doesn't read as the maintainer
  arguing with themselves. Keep it tool-agnostic ("AI assistance", never a
  product name), since the maintainer uses more than one agent. Existing
  issues and comments without one need no edit.
- **An issue links a repo document by permalink, not by branch path.** Use a
  blob url pinned to a commit sha, with the section's heading anchor
  (`.../blob/<sha>/docs/search_rules.md#reporting`), so the link still shows
  what the issue was written against after the doc is edited, renamed or
  deleted. Code references by symbol name (`scoring.ts`'s `rankHybrid`) stay
  as they are.
