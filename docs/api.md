# API

The HTTP surface `packages/server/app.ts` exposes under `/api/`. This is an
internal contract between the bundled client (`packages/web`) and its own
server, not a public integration surface — there's no versioning, no auth
beyond the favorites client-id scheme below, and no stability guarantee to
anyone but this repo's own client code. If you're calling it for something
else, it'll probably work, but nothing here is designed against that use.

**Keep this in sync.** A route added, removed, or reshaped in `app.ts` is
not done until this file says so — see the note at the top of that file.

All responses are JSON unless noted. Full response shapes are TypeScript
types, not repeated here: `packages/map/manifest.ts` for the manifest, and
the inline route handlers in `packages/server/app.ts` for search/favorites/
health. This page describes behavior and points at the type, rather than
duplicating a shape that would drift from it.

## `GET /api/manifest`

The corpus manifest, plus resolved client config and favorites-store status.
The client blocks on this fetch before it can render anything, so it's the
one endpoint hit unconditionally on every load.

- **Response**: `ManifestResponse` (`packages/map/manifest.ts`) — room list
  and urls, shared-tile info, pyramid levels, embedding/metadata sidecar
  coverage, `favorites: { enabled: boolean } | null`, and `config` (the
  server's resolved `Config` with its `notes`/`source` fields stripped).
- Not cached by this server; nothing here changes after startup except by
  restarting the process (the corpus is scanned once — see `AGENTS.md`,
  "The map and its coordinates" is unrelated but "No store, no feature" and
  the config section cover why nothing here is mutable at runtime).

## `GET /api/search`

Runs the CLIP text tower on a query string and returns a query vector — or,
if there's no embedding blob for this corpus or the model fails to load, a
deterministic stub ranking instead. Actual ranking (combining this vector
with keyword/story matches) happens client-side against `embeddings.bin`;
this endpoint only does the one thing that can't run in a browser.

- **Query**: `q` — free text, truncated to `config.search.maxQueryLength`.
- **Response**, one of:
  - `{ query: string, order: null }` — empty query.
  - `{ stub: true, query: string, order: number[] }` — no embeddings for
    this corpus; `order` is room ids, best-first, from `stubRanking()`.
  - `{ stub: false, query: string, vector: number[] }` — a 512-dim
    unit-length CLIP text embedding.
  - `{ stub: true, query: string, order: number[], note: string }` — CLIP
    inference failed or isn't installed; same stub ranking, with `note`
    explaining why (no model on this machine vs. a load error).
- No auth, no rate limit of its own. This is the better DoS target on this
  API and isn't yet covered by the Cloudflare ruleset that protects asset
  serving - see issue #244.

## `GET /api/favorites`

Every room with at least one favorite, by filename.

- **Response**: `{ counts: Record<string, number> }` — a count is the size
  of a per-room set of hashed visitor ids, never a raw counter (see
  `AGENTS.md`, "Favorites").
- `Cache-Control: no-store` — a stale count reads as a favorite that didn't
  register, which is the one thing this endpoint exists to report.
- Only mounted when the server was started with `--favorites`; otherwise
  none of the three favorites routes exist at all.

## `POST /api/favorites/:file`

This visitor favorites the named room. `:file` is the room's filename (not
its numeric id — ids are positional and renumber when the corpus changes).

- **Headers**: `X-Favorite-Client` — a random id the browser mints once per
  visitor (`persist.ts`'s `getOrCreateFavoriteClientId`), matching
  `/^[A-Za-z0-9_-]{8,128}$/`. Decides *whose* favorite this is; a separate
  `req.ip`-keyed token bucket decides how fast writes can arrive (deliberately
  different keys — see `AGENTS.md`, "Favorite writes are rate-limited by
  `req.ip`").
- No request body.
- **Response**: `{ file: string, count: number, favorited: true }`.
- **Errors**: `404` unknown `file`, `400` missing/malformed client id, `429`
  rate-limited.

## `DELETE /api/favorites/:file`

The same visitor un-favorites the room. Same headers, same errors, same
response shape with `favorited: false`.

## `GET /api/health`

Liveness for the deploy workflow (`AGENTS.md`, "Deploying to the VPS") —
not meant to be polled by the client.

- **Response**: `{ ok: true, commit: string | null, rooms: number,
  uptimeSeconds: number }`. `commit` lets a health check tell the new
  process apart from the old one still answering on the same port;
  `rooms: 0` on the deployed commit is treated as a failed deploy rather
  than a healthy empty library.
- `Cache-Control: no-store` — the point is this process's current answer.

## `GET /api/logs`

Recent entries from the operator's own log file, for the admin log viewer at
`/admin/logs` (see `packages/server/log-file.ts`, `log-reader.ts`,
`admin-auth.ts`, `logViewerPage.ts`) — the "don't ssh into the VPS to read
logs" route. Unlike everything above, this one has real auth: HTTP Basic
Auth, checked against a scrypt hash in `ADMIN_PASSWORD_HASH`
(`tools/hash-admin-password` prints one). There's one operator, so the Basic
Auth username is never checked.

- **Query**: `minLevel` (pino's numeric scale — 10 trace .. 60 fatal;
  default `0`, everything), `limit` (default/max in `log-reader.ts`).
- **Response**: `{ entries: (LogEntry | RawLogEntry)[] }`, oldest first.
  `RawLogEntry` (`{ raw: string }`) is a line that didn't parse as JSON,
  kept rather than dropped.
- `Cache-Control: no-store`.
- Only mounted when the server was started with both `LOG_FILE` and
  `ADMIN_PASSWORD_HASH` set (env vars, not flags — the second is a secret);
  a lone one logs a startup warning and mounts neither route rather than
  serving unauthenticated. Same "no store, no feature" shape as favorites.
- **Errors**: `401` with a `WWW-Authenticate` challenge on missing/wrong
  credentials, `429` past `admin-auth.ts`'s per-address rate limit
  (`rate-buckets.ts` — every request spends a token, right password or
  wrong, before it's checked).
- Every attempt against any of the three admin routes is itself logged
  (`ip`, path, outcome) — a real login at `info`, a wrong password or a
  rate-limited request at `warn`, never the attempted password. So this
  route's own log ends up in the log it serves.

## `GET /admin/logs`

The same data as `/api/logs`, as a small server-rendered HTML page (works
with no JS — reload to see new entries) with a level/limit form and an
auto-refresh toggle that polls `/admin/logs/fragment`. Same query params,
same auth, same mounting condition as `/api/logs`.

## `GET /admin/logs/fragment`

Just the `<ul id="entries">` markup `/admin/logs` embeds — what its own
polling script fetches on refresh. Not meant to be visited directly; same
query params, auth, and mounting condition as `/api/logs`.

## Usage metrics

`GET /api/manifest`, `GET /api/search` (non-empty query only), and the two
favorite-write routes above each also count toward an hourly, in-memory
usage log — no response shape changes, no new route. See `metrics.ts` for
what is counted and why nothing per-visitor survives an hour.

## Not covered here

Everything else `app.ts` serves — `/`, `/catalog`, `/catalog/:slug`,
`/map/:slug`, `/help`, `/about`, `/robots.txt`, `/sitemap.xml`,
`/babel-book`, `/bundle.js`, `/style.css`, static asset mounts, and the
dev-only `/api/live-reload` — are page/asset routes serving HTML, plain
text, or files, not a JSON API contract. See `app.ts` itself for those.
