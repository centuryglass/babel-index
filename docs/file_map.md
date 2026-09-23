# File map

Every tracked file in the repo, with a line or two on what it is for.
`AGENTS.md` (see its "Layout") has agents read this at the start of a
session; [`docs/architecture.md`](architecture.md) is the five-minute system
overview.

- A file added, removed or renamed is not done until this map says so.
  `npm run check:file-map` fails CI on drift; `tools/check-file-map/index.ts`'s
  header has the format rules.
- Unit tests are not listed: assume each module has a `{name}.test.ts` beside
  it. Playwright specs are in `packages/web/e2e`.
- Anything under `reference` is used only by the inpainting pipeline.

### Root:
- `README.md`: What this is and how to run it.
- `LICENSE`: Unlicense.
- `CHANGELOG.md`: Written by the release-please workflow.
- `AGENTS.md`: The agent rulebook; per-area hazards are in `docs/agents`.
  `CLAUDE.md` is a symlink to it.
- `package.json` / `package-lock.json`: Dependencies and every `npm run`
  script (see `AGENTS.md`'s "Commands").
- `jsconfig.json`: The `tsc` config `npm run typecheck` reads (`checkJs`,
  `paths`).
- `eslint.config.js`: Lint rules (see `AGENTS.md`'s "Commands").
- `.gitignore`: Local and generated paths; its comments say what each is.
- `.claude`: Claude Code session config for this repo, not part of the app.
  * `settings.json`: Wires the session-start hook.
  * `hooks/session-start.sh`: Runs `npm install` in a Claude Code Remote
    session (gated on `CLAUDE_CODE_REMOTE`), then refreshes and prints the
    issue cache.
  * `scripts/issues.mjs`: Compiles the repo's GitHub issues into the
    gitignored `.claude/cache/issues/` (`index.md` plus one file per issue).
    `.mjs` because it must run before `npm install`; its header lists the
    fetch paths.

### Build:
- `build`: The Node-side TypeScript loader hook (see `AGENTS.md`'s
  "Commands"). Not a bundler; the client bundle is built by
  `packages/server/index.ts`.
  * `register.mjs`: What every `node`-invoking npm script passes to
    `--import`.
  * `ts-loader.mjs`: The ESM `load` hook that runs `.ts`/`.tsx` through
    esbuild's `transform` in memory.

### Client/Server code:
- `packages/server`: The demo server.
  * `index.ts`: CLI - argv, the esbuild client bundle, the listening socket.
  * `app.ts`: Express routes - manifest, search, favorites, logs, images,
    SSR pages. `docs/api.md` must change with any `/api/*` shape.
  * `scan.ts`: Scans an images directory (and `--shared-dir`) into the
    corpus manifest.
  * `remote.ts`: Reads a manifest from a remote host (R2) instead of a local
    directory, rebasing its urls.
  * `port.ts`: `portInUse`, so a second `npm run demo` fails instead of
    silently exiting.
  * `favorites.ts`: Global favorite counts - the `FavoriteStore` interface
    and its JSON-file implementation (`--favorites <path>`).
  * `logger.ts`: The leveled, structured (pino) logger every server module
    writes through; `LOG_FILE` also writes via `log-file.ts`.
  * `log-file.ts`: Size-capped rotating file destination for `logger.ts`.
  * `log-levels.ts`: pino's numeric levels, named, for `log-reader.ts` and
    `logViewerPage.ts`.
  * `log-reader.ts`: Reads entries back out of `log-file.ts`'s files for the
    admin log viewer.
  * `admin-auth.ts`: HTTP Basic Auth (`ADMIN_PASSWORD_HASH`) for the admin
    log routes, rate-limited via `rate-buckets.ts`.
  * `rate-buckets.ts`: Per-key token buckets for favorite writes and admin
    login attempts.
  * `metrics.ts`: Hourly, privacy-preserving usage counts logged through
    `logger.ts`; nothing persisted.
  * `logViewerPage.ts`: The `/admin/logs` HTML page and its
    `/admin/logs/fragment` polling partial.
  * `search-cache.ts`: LRU cache and concurrency limiter for `/api/search`'s
    CLIP text tower calls.
  * `image-fixtures.ts`: Synthetic image headers for testing `scan.ts`'s
    parsers.
  * `base-path.ts`: `normalizeBasePath` for `--base-path` (see
    `docs/agents/deploy.md`'s "Deployment and the base path").
  * `clip-cache.ts`: `CLIP_CACHE_DIR`, the repo-root `.clip_model_cache/`
    every CLIP tower loader points transformers.js at.
  * `version.ts`: The running commit (`BABEL_COMMIT`, else `.git`), read
    once at startup and reported by `/api/health`.
  * `roomContent.ts`: Memoized loader for the real `metadata.json`/
    `tagLinks.json` content the SSR routes need, local or remote.
  * `catalogPage.ts`: HTML builders for the SSR catalog list and room
    permalink pages, paged with `packages/web/src/lib/catalog.ts`.
  * `seo.ts`: `robots.txt` and `sitemap.xml` builders.
  * `staticPages.tsx`: SSR bodies for `/help` and `/about`, rendering
    `HelpBody`/`ArtistStatementPages` with `renderToStaticMarkup`.
- `packages/web`: Browser-side code, the only place DOM is expected. `src/`
  is split by React convention (components, hooks, `lib/`), not by feature,
  so a hook and the `lib/` module it wraps sit apart (`useMapCamera.ts` /
  `lib/camera.ts`).
  * `index.html`: The HTML shell. `app.ts`'s `renderPage` fills its `%%...%%`
    placeholders per request; its comments say what each carries.
  * `style.css`: All of the app's CSS, re-read on every request.
  * `public/`: App-level static assets (favicons, touch and manifest icons,
    `site.webmanifest`, the OG card image), served by `app.ts`'s
    `publicDir` mount.
  * `src/main.tsx`: React entry point - loads the corpus, derives the layout,
    wires the hooks together, and renders the map and catalog views. Reads
    the SSR routes' `window.__INITIAL_ROUTE__` seed once at startup.
  * `src/assets.d.ts`: Module declarations for the `.svg` (raw text) and
    `.woff2` (data url) imports esbuild's loaders produce.
  * `src/assets/roboto-slab-400.woff2`: The center shelf's spine typeface,
    bundled with the client (see `spineFont.ts`).
  - `src/components/`: Presentational React components.
    * `MapView.tsx`: The map canvas view and its controls.
    * `CatalogView.tsx`: The catalog list view.
    * `RoomOverlay.tsx`: Modal showing one room's full tile and story, from
      the map or a catalog row.
    * `RoomDetails.tsx`: A room's keywords, story, alt text and ranking
      explanation - shared by the card, the overlay and catalog rows.
    * `SearchForm.tsx`: The search box, on the map or in the catalog bar.
    * `SearchIcon.tsx`: The search badge's glyph, orbiting arrow and preload
      spinner ring.
    * `HelpDialog.tsx`: The "READ ME" dialog - chrome, zoom controls and the
      content-blocking panel around `HelpBody`.
    * `HelpBody.tsx`: The help text, pure so `staticPages.tsx` can render it
      for `/help`.
    * `BookOverlay.tsx`: The open-book dialog shell both reading dialogs use;
      two pages side by side when wide, one when narrow.
    * `ArtistStatementOverlay.tsx`: The artist's statement, opened from the
      book traced into the center shelf's gap (`CENTER_BOOK_PATH` in
      `lib/center.ts`).
    * `ArtistStatementPages.tsx`: The statement's two pages, pure so
      `staticPages.tsx` can render them for `/about`.
    * `BabelBookOverlay.tsx`: Easter egg - a random Library of Babel book,
      opened from the artist's statement and stacked over it.
    * `ZoomControls.tsx`: Zoom in/reset/out buttons for a `useContentZoom`
      scope - the non-pinch path for a mouse-and-keyboard reader.
  - `src/hooks/`: The subsystems `main.tsx` wires together.
    * `useCorpus.ts`: Loads the metadata sidecar and embedding blob and
      builds the search index.
    * `useFavorites.ts`: The reader's favorites (localStorage), the global
      counts (`/api/favorites`), and the toggle that changes both.
    * `useSearch.ts`: The query box, the `/api/search` fetch, blending into
      one ranking, and the highlight range-finders.
    * `useMapCamera.ts`: Pointer plumbing for the map camera; the math is in
      `lib/camera.ts`.
    * `useMapRenderer.ts`: The Canvas2D map frame loop.
    * `useMapRendererGL.ts`: The WebGL frame loop, used when `webglFlag.ts`'s
      `WEBGL` is true (see `docs/agents/rendering.md`'s "The WebGL renderer").
    * `useMapCursor.ts`: The keyboard cursor, what a reader hears about it,
      and every key over the map.
    * `useCenterShelf.ts`: The center shelf's book titles, roving tabindex,
      and what a tap or arrow key does.
    * `useModeTransition.ts`: Switching between map and catalog, with the
      FLIP animation between them.
    * `useRearrangement.ts`: The sliding-tile rearrangement - whether a
      layout/order change animates, and what is announced when it lands
      (see `docs/agents/rearrangement.md`'s "The reorder animation").
    * `useDialog.ts`: Shared modal-dialog behavior (focus in/out, Escape,
      Tab-trap) plus a topmost-only dialog stack. `BookOverlay` uses it, so
      `ArtistStatementOverlay`/`BabelBookOverlay` do; `HelpDialog` and
      `RoomOverlay` still inline their own copies and import only
      `useScrimDismiss`.
    * `useDistillMode.ts`: The distill toggle's state and its fade-then-slide
      sequence; `drawGenericFade` in `render.ts` draws the faded end.
    * `useContentZoom.ts`: Pinch-to-zoom and one-finger pan scoped to one DOM
      subtree (a room overlay, a dialog page, the catalog list).
  - `src/lib/`: Logic with no JSX - state, geometry and rendering.
    * `center.ts`: The center tile's controls as pure code - geometry, shelf
      titles, hit-tests, spine compositing.
    * `cssVars.ts`: Style values shared between canvas drawing and CSS (the
      hover glow color); `applyCssVars` is its only DOM access.
    * `spineFont.ts`: The spine typeface - `SPINE_FONT_FAMILY` and
      `loadSpineFont`, the DOM half that loads the bundled font.
    * `svgPath.ts`: Pure helpers over the path grammar `import-shelf-svg.ts`
      emits - polygon flattening, canvas replay, point-in-polygon.
    * `camera.ts`: Pure camera math for the map.
    * `loadingAnimation.ts`: The center-tile loading indicator's sprite
      playback (see `docs/agents/rearrangement.md`'s "The loading indicator").
    * `render.ts`: Draws one Canvas2D map frame.
    * `slide.ts`: The Canvas2D rearrangement animation renderer.
    * `picking.ts`: `roomAtPoint` - which room is under a screen point.
    * `favoriteBadge.ts`: Geometry and hit-test for the favorite badge on a
      room tile's upper right corner.
    * `distillToggle.ts`: Geometry and hit-test for the distill toggle on the
      center tile's lower right corner.
    * `clearHistoryBook.ts`: Geometry for the "forget searches" book's spine
      overlay on the center tile.
    * `catalog.ts`: The catalog's pure paging, row-height and ordering math.
    * `babelBook.ts`: Random Library of Babel text, shared by
      `BabelBookOverlay.tsx` and the server's `/babel-book` route.
    * `pyramid.ts`: Every pyramid number - tile dimensions, the level
      ladder, cache budgets, the prefetch ring.
    * `tiles.ts`: The tile cache - loading, eviction, and fallback levels.
    * `rooms.ts`: Maps a room and level to its image url or sheet cell.
    * `persist.ts`: localStorage state - search history, pagination
      settings, blocked tags, the reader's favorites and client id.
    * `touchDebug.ts`: On-screen pointer stream behind `?touchdebug`.
    * `debug.ts`: Gates the dev panel and HUD behind `?debug`.
    * `debugActions.ts`: A seeded, repeatable random-usage session for
      perf/memory profiling; also driven by `tools/perf-capture`.
    * `contentZoomCamera.ts`: Pure zoom/pan-bounds math for
      `useContentZoom.ts`.
    * `perfProbe.ts`: Rearrangement frame-timing instrumentation behind
      `?perf`.
    * `webglFlag.ts`: `DEFAULT_WEBGL`, the `?webgl` override and the WebGL2
      probe (see `docs/agents/rendering.md`'s "The WebGL renderer").
    * `glRenderer.ts`: The WebGL counterpart of `render.ts`.
    * `glSlideRenderer.ts`: The WebGL counterpart of `slide.ts`.
    * `gl/context.ts`: The shader program, VAO and quad-drawing primitives;
      created once per canvas.
    * `gl/shaders.ts`: Loads the quad shader's GLSL source.
    * `gl/shaders/quad.vert`: The quad shader's vertex stage.
    * `gl/shaders/quad.frag`: The quad shader's fragment stage.
    * `gl/textureCache.ts`: Tile image to `WebGLTexture` cache, with its own
      frame-aware eviction budget.
    * `gl/warm.ts`: Uploads a rearrangement's tiles to the GPU before the
      flight.
    * `gl/spineTexture.ts`: The center tile's spine text, composited
      offscreen and cached as a texture.
    * `gl/glowTexture.ts`: Hover-glow silhouettes (favorite badge, distill
      toggle) baked once and cached as textures.
- `packages/web/e2e`: Playwright specs (`*.e2e.ts`), the render parity suite
  (`render-parity.parity.ts`, `npm run test:parity`), and `support.ts`'s
  shared helpers (see `docs/agents/testing.md`'s "Testing and CI").
- `packages/config`: Every number tuned by feel.
  * `config.ts`: `DEFAULTS` and validation, no filesystem.
  * `load.ts`: Reads the optional `config.json` overlay.
- `packages/map`: Map layout and room data, no DOM.
  * `ordering.ts`: Room placement, the search density gradient, ranking by
    embedding, pan resistance.
  * `nextRoom.ts`: Ctrl+arrow's walk to the next corpus room in a
    direction.
  * `metadata.ts`: Normalizing and joining per-room keyword/story data.
  * `slug.ts`: Room permalinks - building slugs from titles and resolving
    them (and filename-stem aliases) back to rooms.
  * `manifest.ts`: The corpus manifest's types (`Manifest`, `Room`,
    `SharedAssets`, ...). Types only.
  * `moves.ts`: The rearrangement's types (`Move`, `Board`,
    `Rearrangement`, ...), shared by `illusion.ts`, `board.ts` and
    `slide.ts`. Types only.
  * `searchResult.ts`: Search's result types - what `rankHybrid()` returns
    and `useSearch.ts` stores. Types only.
  * `scoring.ts`: Search tokenizing, scoring, the hybrid rank and match
    strength.
  * `favorites.ts`: The favorite sort modes, as a re-sort of the current
    order and (`favoriteStrength`) a placement input.
  * `illusion.ts`: Plans the sliding-tile rearrangement moves.
  * `board.ts`: Cuts the finite board a rearrangement is planned on out of
    the map.
  * `describe.ts`: Screen-reader messages.
  * `prng.ts`: Seedable RNG (mulberry32) and string-to-seed hash (FNV-1a).
  * `wink-lemmatizer-stub.d.ts`: Type-only stand-in for the untyped
    `wink-lemmatizer`, mapped in by `jsconfig.json`'s `paths`; its header
    says why.
- `packages/pipeline`: Generates the tile resolution pyramid
  (`npm run generate:mips`), packing coarse levels into sheets.
  * `index.ts`: CLI.
  * `mips.ts`: Writes each room's per-file pyramid levels.
  * `sheets.ts`: Composites a level's per-file tiles into `<width>-sheets/`
    grids.
  * `layout.ts`: On-disk level layout and sheet arithmetic, shared with the
    server; no imaging.
  * `shared-mips.ts`: The same per-file pyramid for the `--shared-dir`
    center and `generic/` tiles.

### Associated tools:

Offline tools, except `tools/center-placement/lib`, which `packages/web`
imports at bundle time.

- `tools/center-placement`: Center-tile geometry for the diegetic interface,
  traced from an SVG (`npm run generate:shelf-geometry`).
  * `import-shelf-svg.ts`: Converts the Inkscape trace into `lib/measured.ts`.
  * `shelf_geometry.svg`: The hand-traced center tile geometry.
  * `lib/geometry.ts`: `layout()` - book and search box placement for a tile
    size.
  * `lib/measured.ts`: Generated geometry data; never hand-edited.
  * `lib/svg.ts`: Minimal SVG element builder; nothing imports it.
- `tools/center-animation`: Packs `assets/animation/<cycle>/` frames into
  sprite sheets plus `manifest.json` (`npm run generate:animation`).
  * `index.ts`: CLI - discover cycles, crop, pack, write sheets and manifest.
  * `lib.ts`: Pure crop, grid and cell-fraction math, and the manifest type.
- `tools/embed/embed.ts`: Computes CLIP image embeddings for a corpus
  (`npm run generate:embeddings`).
- `tools/embed/README.md`: How to run `embed.ts` and `cosine-range.ts`.
- `tools/embed/cosine-range.ts`: Measures CLIP's raw cosine range on a real
  corpus, to calibrate `CLIP_STRENGTH` and `search.density`.
  * `cosine-stats.ts`: Its pure percentile and calibration arithmetic.
- `tools/upload`: Syncs a corpus to Cloudflare R2, incrementally by content
  hash.
  * `upload-r2.ts`: CLI; credentials from the environment.
  * `lib.ts`: Pure upload-list and diff logic.
  * `README.md`: Credentials setup and usage.
- `tools/hash-admin-password`: `npm run hash-admin-password` - prints an
  `ADMIN_PASSWORD_HASH` value.
  * `index.ts`: CLI with a hidden-echo password prompt.
  * `README.md`: Usage and where the hash goes.
- `tools/font-lab`: Design lab for the spine typeface. No npm script, no
  tests; run with `node --import ./build/register.mjs tools/font-lab/render.ts`.
  * `fonts.ts`: The candidate typefaces and their Google Fonts sources.
  * `download-fonts.ts`: Fetches each candidate's woff2 into `fonts/`.
  * `variants.ts`: The font/settings sweep `render.ts` draws.
  * `render.ts`: Renders each variant onto the center tile in Chromium, as a
    labelled contact sheet.
  * `README.md`: What the lab is for and how to read its output.
- `tools/perf-capture/capture.ts`: Automated Chrome perf/memory capture of a
  seeded `debugActions.ts` session (`npm run profile:chrome`).
- `tools/perf-capture/README.md`: Flags, why it is Chrome-only, and how to
  read the metrics.
- `tools/check-file-map`: `npm run check:file-map` - diffs this file against
  `git ls-files`.
  * `index.ts`: CLI; its header has the rules.
  * `lib.ts`: Pure parsing of this file's bullets into paths.
- `tools/check-requirements`: `npm run check:requirements` - checks
  `docs/search_requirements.md` against the tests' `[SR-nn]` tags.
  * `index.ts`: CLI.
  * `lib.ts`: Pure parsing of requirement ids and tags, and the baseline
    comparison.
  * `baseline.json`: Requirements known to be uncovered. Losing coverage
    fails the check; gaining it prints the command to lower this list.
- `tools/curation`: Python/Qt tools that turn a batch of generated tiles into
  `metadata.json` (keywords, stories, alt text, titles, sensitive tags). A
  separate ecosystem with its own `AGENTS.md`/`CLAUDE.md` and `README.md`;
  read them only when working there.

### Infra, CI and deploy:
- `infra`: Terraform for the R2 bucket and its abuse protection (rate
  limiting, edge caching, billing alert). Applied by hand, never from CI; see
  `infra/README.md`.
- `Dockerfile`: Containerizes the demo server. The `WITH_CLIP` build arg
  drops the optional CLIP install. It copies `tools/center-placement/lib`
  because `packages/web` imports geometry from it at bundle time.
- `.dockerignore`: Keeps dev-only paths out of the build context, re-including
  `tools/center-placement/lib`.
- `deploy`: Shipping a release to the VPS from Actions (see
  `docs/agents/deploy.md`'s "Deploying to the VPS").
  * `deploy.sh`: The deploy, run on the VPS and pinned as the deploy key's
    SSH forced command.
  * `health-check.mjs`: Polls `/api/health` until it reports the expected
    commit; run by both `deploy.sh` and `deploy.yml`.
  * `README.md`: One-time VPS and repository setup, and rollback.
  * `babel-index.nginx.conf`: Reference copy of the VPS's babel-index nginx
    location blocks, not synced automatically.
- `.github/workflows/ci.yml`: The required `ci` check - test matrix, lint
  (with `check:file-map` and `check:requirements`), typecheck, and a
  change-gated call into `e2e.yml`. Its `audit` job is informational.
- `.github/workflows/e2e.yml`: The browser smoke test, called from `ci.yml`
  and manually dispatchable.
- `.github/workflows/deploy.yml`: After `ci` passes on a release-PR merge,
  ships that sha over ssh and re-checks health from outside. Dispatching it
  with a sha is the rollback.
- `.github/workflows/docker-build.yml`: Builds the Dockerfile against the
  sha `deploy.yml` shipped; build only, no push.
- `.github/workflows/release-please.yml`: Keeps the standing release PR
  current from squash-merged PR titles; merging it is the release (see
  `docs/agents/deploy.md`'s "Release discipline").
- `release-please-config.json` / `.release-please-manifest.json`: The
  config `release-please.yml` reads and the version state it writes; never
  hand-edit the manifest.
- `.github/workflows/pr-title-lint.yml`: Requires Conventional Commits PR
  titles.
- `.github/pull_request_template.md`: The title format (as a comment) and a
  description/testing checklist.
- `.github/workflows/codeql.yml`: CodeQL static analysis on PRs, main and a
  weekly schedule.
- `.github/workflows/dependency-review.yml`: Blocks a PR that adds a
  vulnerable or disallowed-license dependency.
- `.github/dependabot.yml`: Automated dependency-update PRs.

### Assets:
- `assets/center_tile.png`: The blank center tile at cell (0, 0), which
  carries the diegetic controls.
- `assets/generic`: The generic "default" tiles.
- `assets/generic_distill`: Distill mode's alternate for each generic tile,
  matched by filename stem; a generic tile crossfades to it when distill mode
  hides the filler.
- `assets/animation`: Loading-animation frame cycles (`<cycle>/`, source
  only) and the generated `sheets/` and `manifest.json` served from
  `/shared/animation/`.
- `assets/corpus-sample`: A minimal demo corpus with metadata, embeddings,
  pyramid and tag links.

### Reference:
- `reference`: Inpainting pipeline source material (Blender renders, a canny
  edge map, a mask).

### Docs:
- `docs/api.md`: The `/api/*` request/response contract.
- `docs/architecture.md`: The five-minute, human-facing system overview.
- `docs/user-guide.md`: Every control, annotated with screenshots - the
  repo-side counterpart of the in-app "READ ME" dialog.
- `docs/file_map.md`: This file.
- `docs/agents`: Per-area agent hazards, reached from `AGENTS.md`'s "Things
  that will bite you" routing table.
  * `map.md`: Tile geometry, map coordinates, the center tile and its
    controls, camera and gestures, config and the pyramid.
  * `search.md`: Search ranking and the density gradient.
  * `favorites.md`: The favorites store, identity, sorting and badge.
  * `rearrangement.md`: The reorder animation and the loading indicator.
  * `rendering.md`: The WebGL and Canvas2D renderers.
  * `catalog.md`: The catalog view and the two modes.
  * `deploy.md`: The base path, VPS deploys and release discipline.
  * `testing.md`: Testing and CI.
  * `comment-audit.md`: The comment and documentation audit process.
- `docs/concept.md`: The original concept and a dated design-decision log. A
  record of intent, not kept in sync with the code.
- `docs/keyboard-controls.md`: The spec for every key the map view handles,
  state by state.
- `docs/search_rules.md`: The full specification of search - parsing,
  scoring, strength, reporting. Changes with `packages/map/scoring.ts`.
- `docs/search_requirements.md`: What search must do for a reader, as
  numbered `SR-nn` requirements. Maintainer-set intent, not a description of
  the code.
- `docs/cosine-range-report.json`: Snapshot of `cosine-range.ts`'s last real
  run, the numbers `docs/search_rules.md` cites.
