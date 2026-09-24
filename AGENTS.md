# AGENTS.md

Rules for coding agents working in this repo. Human-facing docs are
[`README.md`](README.md) (how to run it),
[`docs/architecture.md`](docs/architecture.md) (a five-minute system
overview), and [`docs/concept.md`](docs/concept.md) (what it is meant to
become). Open work lives in
[GitHub issues](https://github.com/centuryglass/babel-index/issues) - see
"Tracking open work".

## How to use this file

- **Read [`docs/file_map.md`](docs/file_map.md) when the task needs the
  repo's shape, not by default.** It is the file-by-file map. Read it:
  - before creating a file or module, to find one that already does the job;
  - before adding, removing, renaming or moving a file, since the map is
    part of that change;
  - when the task names a behavior but no file, and a search for its
    obvious symbols comes up empty;
  - for work that spans packages (a cross-cutting refactor, an audit,
    triage over many issues).

  A task that names its files or symbols doesn't need it.
- **Area hazards live in `docs/agents/`.** "Things that will bite you"
  routes to them by path; check it before editing. Every rule in this
  section applies to those files too.
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
- **Code comments cite headings and bold lead phrases by file and name**
  (`AGENTS.md, "Layout"`, `docs/agents/rendering.md, "The WebGL
  renderer"`). Renaming one, or moving it to another file, breaks those
  pointers: grep the repo for the old phrase and fix every hit in the same
  change.
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
- **Required checks:** `npm test` across the Node matrix, `e2e.yml`, lint,
  typecheck, `check:file-map` and `check:requirements` all feed `ci.yml`'s
  aggregate `ci` job.

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

Area hazards live in `docs/agents/`, one file per area. Before editing a
path in the left column, or doing the task named there, read the file on the
right. A row lists where a hazard bites, not only where it is stated, so one
path can match several rows; read every file it matches.

| When the change touches | Read |
| --- | --- |
| `packages/map/` layout, ordering or placement; `packages/web/src/lib/camera.ts`, `center.ts`, `pyramid.ts`, `tiles.ts`; `useMapCamera.ts`, `useCenterShelf.ts`, `main.tsx`; `packages/config/`; `packages/pipeline/`; `packages/server/scan.ts`; `tools/center-placement/`, `tools/center-animation/`; shared art under `assets/`; the center cell's overlays in `style.css`; zoom, panning, gestures | [`docs/agents/map.md`](docs/agents/map.md) |
| `packages/map/scoring.ts`, `searchResult.ts`, `metadata.ts`; `useSearch.ts`, `useCorpus.ts`, `RoomDetails.tsx`; `tools/embed/`; embeddings, `metadata.json`, `tagLinks.json`; search strength or `main.tsx`'s sort modes | [`docs/agents/search.md`](docs/agents/search.md) |
| `packages/server/favorites.ts`, `rate-buckets.ts`, `app.ts`'s favorite routes, `--trust-proxy`; `packages/map/favorites.ts`; `useFavorites.ts`, `persist.ts`, `favoriteBadge.ts`; the on-map badge in either renderer | [`docs/agents/favorites.md`](docs/agents/favorites.md) |
| `packages/map/board.ts`, `illusion.ts`, `moves.ts`; `useRearrangement.ts`, `loadingAnimation.ts`, `SearchIcon.tsx`; `slide.ts`, `glSlideRenderer.ts`; `flyTo` callers; `assets/animation/` | [`docs/agents/rearrangement.md`](docs/agents/rearrangement.md) |
| `packages/web/src/lib/render.ts`, `slide.ts`, `glRenderer.ts`, `glSlideRenderer.ts`, `gl/`, `webglFlag.ts`; `useMapRenderer.ts`, `useMapRendererGL.ts`; anything that changes what a cell draws | [`docs/agents/rendering.md`](docs/agents/rendering.md) |
| `CatalogView.tsx`, `RoomOverlay.tsx`, `RoomDetails.tsx`, `MapView.tsx`; `packages/web/src/lib/catalog.ts`; `packages/map/slug.ts`, `scoring.ts`'s range finders; `packages/server/roomContent.ts`; catalog rules in `style.css`; the live region | [`docs/agents/catalog.md`](docs/agents/catalog.md) |
| `deploy/`, `Dockerfile`; `.github/workflows/deploy.yml`, `release-please.yml`; `packages/server/app.ts`'s routes, `base-path.ts`, `version.ts`; any url the server or client hands the browser | [`docs/agents/deploy.md`](docs/agents/deploy.md) |
| `packages/web/e2e/`; `.github/workflows/`; `tools/check-file-map/`, `tools/check-requirements/`; an `[SR-nn]` tag; a test beyond the unit test beside its module | [`docs/agents/testing.md`](docs/agents/testing.md) |
| A comment or documentation audit, when the maintainer asks for one | [`docs/agents/comment-audit.md`](docs/agents/comment-audit.md) |

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

## Working with GitHub

- **Open a PR once work is complete and checked, without waiting to be
  asked.** This overrides a coding agent's default of only opening a PR on
  explicit request. Run the project's checks first (tests, lint, typecheck,
  the required `check:` scripts for anything the change touches); a PR the
  maintainer doesn't want costs them a delete, not a review.
- **The PR title is the only release input.** The repo squash-merges, so a
  PR's title becomes the commit subject `release-please.yml` reads for the
  version bump and `CHANGELOG.md`. `pr-title-lint.yml` requires Conventional
  Commits format (`feat: ...`, `fix: ...`). The PR description and
  individual commits are read by nothing downstream. Mark a breaking change
  with `!` on the title (`feat!: ...`); a `BREAKING CHANGE:` footer in the
  description does not survive the squash.
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
