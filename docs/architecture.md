# Architecture

A five-minute system overview. See `README.md` for what the
project is and how to run it, [`docs/concept.md`](concept.md) for the
design intent behind it, and [`docs/file_map.md`](file_map.md) for the
exhaustive file-by-file layout. `AGENTS.md` is the engineering rulebook,
the invariants and gotchas behind the decisions summarized here.

## Shape of the system

One Node/Express process serves both the API and the client bundle. There
is no separate build pipeline, no framework server, no database:

```
Browser  <-- HTML/JS/CSS, /api/* -->  Express (packages/server)
                                          |
                                          +-- local disk (--images)
                                          |   or
                                          +-- fetch from R2 (--remote)
                                          |
                                          +-- optional local CLIP model
                                              (packages/server/search-cache.ts)
```

- **Client**: `packages/web` - a React app rendered onto an HTML5 canvas map
  (plus a conventional list "catalog" view), built with esbuild.
- **Server**: `packages/server` - Express routes for the corpus manifest,
  search, favorites, and health.
- **Shared logic**: `packages/map` (placement/ranking/scoring, no DOM) and
  `packages/config` (tunable numbers) are imported by both client and
  server code, so ranking math has one implementation regardless of which
  side calls it.
- **Corpus**: a directory of room images plus a JSON metadata sidecar and a
  binary CLIP-embedding blob - either read straight off local disk, or
  fetched from Cloudflare R2 for a real deployment (see *Where the corpus
  lives* below).

## Request flow

1. A browser requests `/`. `app.ts`'s `renderPage` reads `index.html` (not
   compiled - re-read per request, along with `style.css`) and stamps in a
   `<base href>`, title/description/canonical/OG-image meta, and, for the
   SSR `/catalog` and `/catalog/:slug` routes, a server-rendered HTML
   fragment plus a `window.__INITIAL_ROUTE__` hint so a JS-capable visitor
   boots straight into the right view.
2. The page requests `/bundle.js`. There is no build step: `packages/server/
   index.ts` starts an esbuild `context` in-process at server startup and
   serves the bundle it produces from memory. Editing a client source file
   means restarting `npm run demo`; editing `style.css` does not, since
   that file bypasses the bundle entirely and is served (and re-read) like
   `index.html`.
3. Once mounted, the client fetches `/api/manifest` for the corpus's room
   list and shared-asset URLs, then loads the metadata sidecar and CLIP
   embedding blob directly (not proxied through the API) to build its
   search index client-side.
4. A search: the client scores keyword and story matches locally, and
   sends only the query text to `/api/search`, which runs CLIP's text
   tower (the one piece of ranking that can't happen in the browser) and
   returns the query's text vector for the client to blend into one ranked,
   cached result (`packages/server/search-cache.ts` bounds concurrency and
   caches repeat queries). `docs/search_rules.md` is the full scoring spec.
5. Favoriting: the client mints a random per-visitor token once
   (`localStorage`) and calls `/api/favorites/:file`; the server stores a
   *set* of HMACs (client token + filename), not a counter, so double-
   favoriting or double-unfavoriting is a no-op instead of a driftable
   count - see `AGENTS.md`'s *Favorites* section for why that shape is
   deliberate.

## Why esbuild bundles in-process

There is deliberately no `dist/` and no separate build phase for the
client: `packages/server/index.ts` bundles at startup and serves the
result from memory, and `build/`'s Node-side loader hook runs every
`.ts`/`.tsx` server/tooling file through esbuild's `transform` per-module,
in memory, on import - so the whole tree runs as TypeScript on the Node 20
floor without a compile step anywhere. The tradeoff: a client edit needs a
server restart (there is no watch-and-hot-reload loop), which is an
acceptable cost for a project of this scale.

## Where the corpus lives

The server has two mutually exclusive modes, chosen by CLI flag:

- **Local mode** (`--images <dir>`): use a directory as the corpus,
  `scan.ts` walks it directly. This is what `npm run demo` uses by
  default, against `assets/corpus-sample/`, so a clone works with zero
  external dependencies.
- **Remote mode** (`--remote <url> --prefix <name>`): `remote.ts` fetches
  a manifest and metadata previously uploaded to Cloudflare R2 by
  `tools/upload/upload-r2.ts` (incrementally, by content hash), and every
  URL the client receives points at that host directly rather than being
  proxied through this server.

The real deployment runs in remote mode. The corpus - thousands of room
images across multiple resolution levels, plus embeddings - is large,
static, and read-heavy. Keeping it off the app server means a redeploy of the
app never touches the (much larger, much slower to move) image data, and 
hosting the image data on CloudFlare cuts bandwidth costs to effectively zero.
`infra/` holds the Terraform for that bucket, applied by hand rather than
from CI since it's independent of any release cadence.

## Deploying to the VPS

Release tagging and versioning (`release-please.yml`) are the primary
mechanism for deployment. Every automatic release-please PR merged to
`main` that passes CI triggers `.github/workflows/deploy.yml` after
the version update is applied. Deployment ships that exact commit to
a Debian VPS over one SSH call, constrained to run only `deploy/deploy.sh`
(a forced command, not a login shell). `deploy.sh` refuses any sha that isn't
already an ancestor of `origin/main`, so the narrow key can redeploy or roll
back to something that was already `main`, never run arbitrary code.

Deployment validation checks server health, reported version, and the presence
of real data to confirm success. A plain HTTP 200 from the health endpoint
doesn't prove the deploy worked. The old process could still be running after
a failed restart, or a misconfigured unit could be serving a stale checkout,
and either would answer 200 looking perfectly healthy. So `/api/health`
reports the git commit the running process actually loaded, and
`deploy/health-check.mjs` polls until that reported commit matches the sha
being deployed. This is checked once from `deploy.sh` itself and again from
the GitHub Actions workflow, to confirm the release both started successfully
and is fully available online. A release that comes up on the
right commit but reports zero rooms also fails fast rather than waiting
out a timeout, since retrying can't change that answer.

A failed deploy is not automatically rolled back. It stops with the
previous sha printed, and the same workflow can be manually dispatched
with any sha as the rollback button.

## Rendering

The map is a virtualized canvas. There are two
parallel renderers sharing one set of per-cell decisions (which pyramid
resolution to draw, favorite-badge placement, prefetch order): a Canvas2D
implementation (`render.ts`/`slide.ts`) and a WebGL2 one
(`glRenderer.ts`/`glSlideRenderer.ts`), the latter the default when the
browser supports it. A parity test(`npm run test:parity`) runs as part of
the release pipeline, and must pass before a deploy.

Room rearrangements (re-sorting the map after a search) are staged as a
sliding-tile illusion rather than an instant relayout: `packages/map/
illusion.ts` plans a sequence of whole-row/column rotations bounded to the
viewport, so visible cost never scales with corpus size.

## Testing and CI

- `npm test` (`node --test`, no browser, no network, ~1s) covers the pure
  logic in `packages/map`, `packages/config`, `packages/pipeline`, and
  most of `packages/server`/`packages/web/src/lib`.
- `npm run test:e2e` (Playwright) is the browser-level merge gate, run as
  a required check (`e2e.yml`) alongside the unit tests across the Node
  20/22/24 matrix.
- `npm run test:parity` is real-GPU check that the two renderers
  draw the same map.
- `npm run typecheck` / `npm run lint` are the type and style gates; see
  `AGENTS.md`'s *Commands* for why `typescript` is pinned below `^7`.
  
## Agentic development

Most of this codebase is written with AI coding agents, and the workflow
around them is itself part of what the repo is meant to demonstrate. The
practices below exist to keep an AI-assisted process producing code a human
would sign off on, reviewed, tested, and documented.

Every session is human-triggered and scoped to a task; nothing runs
unattended against `main`. Agents work on branches, changes go through the
same CI gates as any other (`npm test`, e2e, typecheck, lint), and every
diff is reviewed before it lands. A PR is opened only when asked for.
Open work is tracked in GitHub issues rather than a file in the
repo, so the task list has one home and can't drift from what's actually
been done. `AGENTS.md` (symlinked as `CLAUDE.md`) is the standing rulebook
every session reads: the conventions, invariants, and the "things that will
bite you" that a fresh context wouldn't otherwise know.

**Keeping documentation honest.** An agent left to its own habits tends
toward comments that argue with the previous version of the code,
scaffolding that restates a fact three files away from where it's defined,
and prose that inflates rather than informs. `AGENTS.md` codifies rules
against these - lead with the invariant, state each fact in exactly one
place, describe the code as it stands rather than the change that produced
it, keep hazards and drop the ghosts of prior implementations. Because a
single model applying its own rules is a weak check on its own tendencies,
the comment discipline is periodically re-swept by a *different* model - the
`qwen3.8-flash-comment-fix` branch is one such pass - so drift one model is
blind to gets caught by another with different biases.

**Issue context at session start.** A `SessionStart` hook compiles the
project's open GitHub issues into a local cache and folds their titles
straight into the agent's context, so every open task is already in view
without a tool call. The full text of each issue sits in the cache
(`.claude/cache/issues/`) for the session to read on demand. The hook
degrades gracefully across environments: it uses the `gh` CLI where it's
authenticated, falls back to the unauthenticated REST API otherwise.

## Further reading

- [`docs/file_map.md`](file_map.md) - every file, what it's for.
- [`docs/search_rules.md`](search_rules.md) - the full search/ranking spec.
- [`docs/keyboard-controls.md`](keyboard-controls.md) - the map's full
  keyboard spec.
- `AGENTS.md` - the engineering conventions and the "things that will bite
  you" invariants behind the decisions summarized above.
