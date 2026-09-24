# Architecture

A five-minute system overview. [`README.md`](../README.md) covers what the
project is and how to run it, [`docs/api.md`](api.md) the HTTP contract,
and [`docs/file_map.md`](file_map.md) every file. `AGENTS.md` and
`docs/agents/` hold the engineering invariants behind the decisions
summarized here.

## Shape of the system

One Node/Express process serves the API, the pages and the client bundle.
There is no database, no framework server and no separate build step.

```
Browser  <-- HTML/JS/CSS, /api/* -->  Express (packages/server)
   |                                      |
   |                                      +-- corpus: local disk (--images)
   |                                      |   or a manifest from R2 (--remote)
   |                                      |
   |                                      +-- optional CLIP text tower
   |                                          (/api/search)
   |
   +-- tiles, metadata.json, embeddings.bin
       (from /images, or straight from R2 in remote mode)
```

- **Client**: `packages/web` - a React app drawing the map on a canvas,
  plus the "catalog", a conventional list view of the same corpus.
- **Server**: `packages/server` - Express routes for the manifest, search,
  favorites, health, the admin log viewer, and server-rendered catalog,
  room, help and about pages for crawlers and no-JS readers.
- **Shared logic**: `packages/map` (placement, ranking, scoring; no DOM)
  and `packages/config` (tunable numbers) are imported by both client and
  server, so each piece of ranking math has one implementation.
- **Corpus**: a directory of room images at several resolutions, a
  `metadata.json` sidecar (titles, keywords, stories) and an
  `embeddings.bin` of CLIP image embeddings. `packages/pipeline` builds the
  resolution pyramid; `tools/embed` builds the embeddings.

## Request flow

1. **Page.** A browser requests `/`. `app.ts`'s `renderPage` reads
   `index.html` from disk on every request and stamps in a `<base href>`
   (see [Deployment](#deploying-to-the-vps)), the title, description,
   canonical url and OG image. For `/catalog`, `/catalog/:slug`,
   `/map/:slug`, `/help` and `/about` it also inserts server-rendered HTML
   and a `window.__INITIAL_ROUTE__` hint, so a JS-capable visitor boots
   straight into the matching view.
2. **Bundle.** The page loads `/bundle.js`, which the server built in
   memory at startup (see [No compile step](#no-compile-step)).
   `style.css` is not bundled; like `index.html`, it is re-read per request.
3. **Corpus.** The client fetches `/api/manifest` (room list, asset urls,
   resolved config), then fetches `metadata.json` and `embeddings.bin`
   directly by url and builds its search index in the browser.
4. **Search.** The client sends the query text to `/api/search`, which runs
   CLIP's text tower (the one piece of ranking that can't run in the
   browser) and returns a query vector. The server caches vectors per query
   and caps concurrent inferences. The client blends that vector with its
   own keyword and story matches into one ranking and one match strength.
   [`docs/search_rules.md`](search_rules.md) is the scoring spec.
5. **Favorites.** The client mints a random token once, keeps it in
   `localStorage`, and sends it with `POST`/`DELETE
   /api/favorites/:file`. The server stores a set of HMACs (salt, filename,
   token) per room, not a counter, so favoriting twice is one favorite and
   no request can drive a count negative. A visitor's own list stays in the
   browser. `docs/agents/favorites.md`'s "Favorites" section has the full rules.

## No compile step

Nothing compiled is written to disk. `packages/server/index.ts` runs an
esbuild `context` at startup and serves the client bundle from memory.
Server and tooling code runs as TypeScript through `build/`'s Node loader
hook, which transforms each `.ts`/`.tsx` module with esbuild as it is
imported, on the Node 20 floor.

The cost is that a client edit needs a restart under `npm run demo`.
`npm run demo:watch` removes it: it restarts the process on a server edit,
rebuilds the bundle on a client edit, and reloads the open page either way.

## Where the corpus lives

The server reads the corpus in one of two modes, chosen by flag:

- **Local** (`--images <dir>`): `scan.ts` walks the directory and the server
  serves it under `/images`, with the shared art (center tile, generic
  tiles) under `/shared`. `npm run demo` defaults to
  `assets/corpus-sample/`, so a clone runs with no external services.
- **Remote** (`--remote <url> --prefix <name>`): `remote.ts` fetches the
  manifest that `tools/upload/upload-r2.ts` wrote when it synced the corpus
  to Cloudflare R2 (incrementally, by content hash), and rewrites every url
  in it to point at that host. The browser fetches tiles, metadata and
  embeddings from R2 directly; this server never proxies them.

The live site runs in remote mode. The corpus is large, static and
read-heavy, so keeping it off the app server means a redeploy never moves
image data, and Cloudflare serves it at close to zero bandwidth cost.
`infra/` holds the Terraform for the bucket and its cache and rate-limit
rules. It is applied by hand, since it is independent of releases.

## Deploying to the VPS

- **Only a release deploys.** PR titles follow Conventional Commits (checked
  by `pr-title-lint.yml`), and `release-please.yml` turns them into a
  standing release PR with the version bump and `CHANGELOG.md`. Once that
  PR is merged and `ci` passes on the merge commit, `deploy.yml` ships it. An ordinary merge to
  `main` is built and tested but not shipped.
- **One narrow SSH call.** `deploy.yml` makes a single ssh call whose key is
  pinned to `deploy/deploy.sh` as a forced command. `deploy.sh` accepts only
  a full sha that is already an ancestor of `origin/main`, so the key can
  deploy or roll back to a revision of `main` and do nothing else.
- **A 200 is not success.** An old process surviving a failed restart, or a
  unit serving a stale checkout, still answers 200. `/api/health` reports
  the commit the running process loaded, and `deploy/health-check.mjs`
  polls until it matches the sha being deployed. It runs twice: from
  `deploy.sh` against `127.0.0.1` (did the unit come back on the new code?)
  and from the workflow against the public url (can anyone reach it?). A
  release on the right commit that reports zero rooms fails immediately.
- **Render parity gates the deploy.** `deploy.yml` runs
  `npm run test:parity` before the ssh call; see [Rendering](#rendering).
- **Rollback is manual.** A failed deploy stops and prints the previous sha.
  Dispatching `deploy.yml` by hand with that sha is the rollback.
- **The site lives under a subpath.** It is served at `/babel-index/`
  behind nginx, which strips the prefix before proxying.
  `--base-path /babel-index/` only sets the `<base href>` the pages carry;
  every Express route stays unprefixed, and every url the server hands the
  browser is relative.

`deploy/README.md` has the one-time VPS setup and the rollback steps.

## Rendering

The map is a virtualized canvas with two renderers: WebGL2
(`glRenderer.ts`/`glSlideRenderer.ts`), the default where the browser
supports it, and Canvas2D (`render.ts`/`slide.ts`), used otherwise or with
`?webgl=0`. They are separate implementations that must make the same
per-cell decisions (pyramid level, what each cell draws, favorite-badge
placement, prefetch order). `npm run test:parity` drives both over the
same scenes and compares their HUD reports and pixels; it runs on
headless Chromium's software WebGL2, so it needs no GPU.

A rearrangement (re-sorting the map after a search or a shuffle) is a
sliding-tile illusion, not an instant relayout. `packages/map/illusion.ts`
plans whole-row and whole-column rotations inside the viewport and swaps
everything else out of sight, so visible cost never scales with corpus
size. The rooms the slide will show are fetched before it starts.

## Testing and CI

| Check                        | What it covers                                                                 | Gates    |
| ---------------------------- | ------------------------------------------------------------------------------ | -------- |
| `npm test`                   | `node --test` on Node 20/22/24; pure logic in `packages/*` and `tools/`, no browser or network, about a second | merge    |
| `npm run test:e2e`           | Playwright against a running demo server (`e2e.yml`); skipped on PRs that touch nothing the browser can see | merge    |
| `npm run lint`               | eslint, syntax-level only                                                      | merge    |
| `npm run typecheck`          | `tsc --noEmit`; `typescript` is pinned to `^6` (see `AGENTS.md`'s "Commands") | merge    |
| `npm run check:file-map`     | `docs/file_map.md` lists every tracked file                                    | merge    |
| `npm run check:requirements` | no requirement in `docs/search_requirements.md` loses the test coverage it had     | merge    |
| `npm run test:parity`        | Canvas2D and WebGL draw the same map                                           | deploy   |

`ci.yml`'s aggregate `ci` job is the merge gate; the two `check:` scripts
run inside its lint job. CodeQL (`codeql.yml`) and dependency review
(`dependency-review.yml`) run as separate workflows, and `docker-build.yml`
builds the Dockerfile for each release, without blocking the deploy.

## Agentic development

Most of this codebase is written with AI coding agents, and the workflow
around them is part of what the repo demonstrates. Its practices exist to
keep an AI-assisted process producing code a human would sign off on.

- **Human-scoped sessions.** Every session is started by a person for one
  task; nothing runs unattended against `main`. Agents work on branches,
  their changes pass the same CI gates as any other, and every diff is
  reviewed before it lands.
- **One rulebook.** `AGENTS.md` (symlinked as `CLAUDE.md`) is read by every
  session: the conventions, the invariants that cross files, and a routing
  table to `docs/agents/`, where each area's "things that will bite you"
  load only when a change touches that area.
- **One task list.** Open work lives only in GitHub issues. A `SessionStart`
  hook (`.claude/hooks/session-start.sh`) caches the open issues under
  `.claude/cache/issues/` and prints their titles into the agent's context.
  It uses the `gh` CLI where it is authenticated and the public REST API
  otherwise. An OpenCode plugin runs the same hook once per session and adds
  the cached index to that session's system prompt.
- **Honest documentation.** Left to its habits, an agent writes comments
  that argue with the previous version of the code, restate a fact far from
  where it is defined, and inflate rather than inform. `AGENTS.md`'s
  "Comments and docs" rules counter this: lead with the invariant, give
  each fact one home, describe the code as it stands, keep hazards and drop
  ghosts. Because one model checking its own habits is a weak check, the
  comments are periodically re-swept by a different model; the
  `qwen3.8-flash-comment-fix` branch is one such pass.

## Further reading

- [`docs/file_map.md`](file_map.md) - every file, and what it is for.
- [`docs/api.md`](api.md) - the `/api/*` request/response contract.
- [`docs/search_rules.md`](search_rules.md) - the search and ranking spec.
- [`docs/keyboard-controls.md`](keyboard-controls.md) - the map's keyboard
  spec.
- [`deploy/README.md`](../deploy/README.md) - VPS setup and rollback.
- `AGENTS.md` - engineering conventions and invariants, with per-area
  hazards in `docs/agents/`.
