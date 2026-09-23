# API

The HTTP surface `packages/server/app.ts` exposes under `/api/` (plus the
admin log viewer's HTML pages). It is an internal contract between the
bundled client (`packages/web`) and its own server, not a public
integration surface: there is no versioning, no auth beyond the favorites
client id and the admin log viewer, and no stability guarantee to anything
but this repo's client.

**Keep this in sync.** A route added, removed, or reshaped in `app.ts` is
not done until this file says so; `app.ts`'s header says the same.

All responses are JSON unless noted, and every error body is
`{ error: string }`. The full manifest shape is the `ManifestResponse` type
in `packages/map/manifest.ts`; the other routes build their responses
inline in `app.ts`, and this page gives those shapes.

| Route                            | Mounted when                              | Purpose                                  |
| -------------------------------- | ----------------------------------------- | ---------------------------------------- |
| `GET /api/manifest`              | always                                    | corpus, shared art, resolved config      |
| `GET /api/search`                | always                                    | CLIP text vector for a query             |
| `GET /api/favorites`             | `--favorites`                             | global favorite counts                   |
| `POST /api/favorites/:file`      | `--favorites`                             | favorite a room                          |
| `DELETE /api/favorites/:file`    | `--favorites`                             | un-favorite a room                       |
| `GET /api/health`                | always                                    | running commit and room count            |
| `GET /api/logs`                  | `LOG_FILE` and `ADMIN_PASSWORD_HASH`      | recent log entries, JSON                 |
| `GET /admin/logs`                | `LOG_FILE` and `ADMIN_PASSWORD_HASH`      | the same, as an HTML page                |
| `GET /admin/logs/fragment`       | `LOG_FILE` and `ADMIN_PASSWORD_HASH`      | the page's entry list, for its polling   |

## `GET /api/manifest`

The corpus manifest, plus resolved client config and favorites-store
status. The client blocks on this fetch before it can render anything, so
every page load calls it once.

- **Response**: `ManifestResponse` (`packages/map/manifest.ts`) - the room
  list and urls, shared-tile info, pyramid levels, embedding and metadata
  sidecar coverage, `favorites: { enabled: boolean } | null`, and `config`
  (the server's resolved `Config` with its `notes`/`source` fields
  stripped).
- The corpus is scanned once, at startup, so the response changes only when
  the process restarts. No `Cache-Control` header is set.

## `GET /api/search`

Runs the CLIP text tower on a query and returns the query vector. Ranking,
which blends this vector with keyword and story matches, runs in the
browser against `embeddings.bin`; this endpoint does only the part that
cannot. When the corpus has no embeddings, or the model is missing or fails
to load, it returns a deterministic stub ranking instead (`stubRanking()`
in `app.ts`), so the rearrangement still happens.

- **Query**: `q` - free text, trimmed, then truncated to
  `config.search.maxQueryLength`.
- **Response**, one of:
  - `{ query: string, order: null }` - empty query.
  - `{ stub: true, query: string, order: number[] }` - no embeddings for
    this corpus; `order` is room ids, best first.
  - `{ stub: false, query: string, vector: number[] }` - a 512-dim
    unit-length CLIP text embedding.
  - `{ stub: true, query: string, order: number[], note: string }` - CLIP
    inference failed; same stub ranking, with `note` saying whether no
    model is installed or the model failed to load.
- Vectors are cached per query (LRU), and concurrent inferences are capped
  at the CPU count, with the excess queued. There is no auth and no rate
  limit. This is the likeliest DoS target on the API, and the Cloudflare
  ruleset that protects asset serving does not cover it (issue #244).

## `GET /api/favorites`

Every room with at least one favorite, keyed by filename.

- **Response**: `{ counts: Record<string, number> }`. A count is the size
  of a per-room set of hashed visitor ids (see`AGENTS.md`, "Favorites").
- `Cache-Control: no-store`, to ensure counts are always current.
- Without `--favorites`, none of the three favorites routes exist, and the
  manifest's `favorites` is `null`.

## `POST /api/favorites/:file`

This visitor favorites the named room. `:file` is the room's filename, not
its numeric id: ids are positional and renumber when the corpus changes.

- **Headers**: `X-Favorite-Client` - a random id the browser mints once per
  visitor (`persist.ts`'s `getOrCreateFavoriteClientId`), matching
  `/^[A-Za-z0-9_-]{8,128}$/`. It decides whose favorite this is. A separate
  token bucket keyed on `req.ip` decides how fast writes can arrive (see
  `AGENTS.md`, "Favorite writes are rate-limited by `req.ip`").
- No request body.
- **Response**: `{ file: string, count: number, favorited: true }`, where
  `count` is the room's new total. Favoriting twice is one favorite.
- **Errors**, checked in this order: `404` unknown `file`, `400` missing or
  malformed client id, `429` rate-limited.

## `DELETE /api/favorites/:file`

The same visitor un-favorites the room. Same header, errors and response
shape as `POST`, with `favorited: false`. Removing a favorite that was
never there changes nothing.

## `GET /api/health`

Liveness for the deploy workflow (`AGENTS.md`, "Deploying to the VPS"). The
client does not call it.

- **Response**: `{ ok: true, commit: string | null, rooms: number,
  uptimeSeconds: number }`.
  - `commit` is the revision the process loaded at startup
    (`packages/server/version.ts`: `BABEL_COMMIT`, else the checkout's
    `.git`), or `null` when it cannot tell. It lets a health check tell the
    new process from an old one still answering on the same port.
  - `rooms: 0` on the deployed commit is treated as a failed deploy, not a
    healthy empty library.
- `Cache-Control: no-store`.

## `GET /api/logs`

Recent entries from the server's log file, for the admin log viewer at
`/admin/logs` (`packages/server/log-file.ts`, `log-reader.ts`,
`admin-auth.ts`, `logViewerPage.ts`). It lets the operator read logs
without an ssh session.

- **Auth**: HTTP Basic, checked against the scrypt hash in
  `ADMIN_PASSWORD_HASH` (`npm run hash-admin-password` prints one). There
  is one operator, so the username is ignored.
- **Query**:
  - `minLevel` - pino's numeric scale (10 trace to 60 fatal). Default `0`,
    everything.
  - `limit` - default `DEFAULT_LOGS_LIMIT`, clamped to `MAX_LOGS_LIMIT`
    (both in `log-reader.ts`).
- **Response**: `{ entries: (LogEntry | RawLogEntry)[] }`, oldest first. A
  `RawLogEntry` (`{ raw: string }`) is a line that did not parse as JSON,
  kept rather than dropped.
- `Cache-Control: no-store`.
- Mounted only when both `LOG_FILE` and `ADMIN_PASSWORD_HASH` are set (env
  vars, not flags, since the second is a secret). With only one set, the
  server logs a startup warning and mounts none of the three admin routes,
  so logs are never served unauthenticated.
- **Errors**:
  - `401` with a `WWW-Authenticate` challenge on missing or wrong
    credentials.
  - `429` past `admin-auth.ts`'s per-address rate limit. Every request
    spends a token before the password is checked, right or wrong.
- Every request to the three admin routes is itself logged (`ip`, path,
  outcome): success at `info`, a wrong password or a rate-limited request
  at `warn`. The attempted password is never logged.

## `GET /admin/logs`

The same entries as `/api/logs`, as a server-rendered HTML page with a
level/limit form. It works without JS (reload for new entries), and an
auto-refresh toggle polls `/admin/logs/fragment`. Same query params, auth
and mounting condition as `/api/logs`.

## `GET /admin/logs/fragment`

The `<ul id="entries">` markup `/admin/logs` embeds, returned as HTML for
that page's polling script. Same query params, auth and mounting condition
as `/api/logs`.

## Usage metrics

`GET /api/manifest`, `GET /api/search` with a non-empty query, and each
successful favorite write also count toward an hourly, in-memory usage log.
No response changes. `packages/server/metrics.ts` covers what is counted
and why nothing per-visitor survives the hour.

## Not covered here

The rest of what `app.ts` serves is pages and files, not a JSON contract:
`/`, `/catalog`, `/catalog/:slug`, `/map/:slug`, `/help`, `/about`,
`/robots.txt`, `/sitemap.xml`, `/babel-book`, `/bundle.js`, `/style.css`,
`/favicon.ico`, the `/images` and `/shared` static mounts (local mode only),
and `packages/web/public`'s files. In watch mode (`npm run demo:watch`) it
also serves `/__live-reload.js` and the `/api/live-reload` event stream.
