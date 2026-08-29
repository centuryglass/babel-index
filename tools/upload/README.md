# tools/upload — Cloudflare R2 sync

Uploads a corpus - room images at every generated pyramid level, the
keyword/story sidecar, the optional keyword -> external-link map, the CLIP
embeddings blob, and the shared center/generic tiles - to Cloudflare R2. See
`docs/implementation-plan.md`'s Hosting section.

R2 is S3-compatible, so this uses `@aws-sdk/client-s3` rather than a bespoke
client.

## Credentials

Read from the environment, never from the command line:

```sh
export R2_ACCOUNT_ID=...          # or R2_ENDPOINT for a full url override
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export R2_BUCKET=...              # or pass --bucket
```

`R2_ACCOUNT_ID` builds the default endpoint
(`https://<account>.r2.cloudflarestorage.com`); set `R2_ENDPOINT` directly if
you need something else (a custom domain, a local S3-compatible test server).

## Run

```sh
node tools/upload/upload-r2.ts                          # assets/corpus-sample/, prefix "corpus-sample"
node tools/upload/upload-r2.ts --images <dir> [--shared-dir assets] \
  [--prefix <name>] [--bucket <name>] [--center center.jpg] [--dry-run]
```

`--dry-run` prints what would be uploaded without touching R2 or writing
credentials-requiring requests beyond the manifest fetch.

## Layout in the bucket

Keys mirror the local layout, so a future R2-backed demo server can resolve a
room's url the same way `packages/web/src/rooms.js` does locally:

```
<prefix>/001.jpg                  level 0 (flat)
<prefix>/512/001.jpg              level 1
<prefix>/metadata.json
<prefix>/tagLinks.json          only if the corpus has one
<prefix>/embeddings.bin
<prefix>/embeddings.json
<prefix>/upload-manifest.json     this tool's own bookkeeping (below)
shared/center_tile.png
shared/generic/a.jpg
```

`prefix` defaults to the basename of `--images`, so different corpora don't
collide in one bucket. The shared tiles live outside any prefix, at the
bucket root, since multiple corpora can point at the same center/generic
assets.

## Incremental by content hash

A run's manifest - key -> sha256 of the bytes uploaded under that key - is
written back to `<prefix>/upload-manifest.json`. The next run hashes every
local file the corpus touches and skips any whose hash still matches the
manifest's record, so touching a handful of images costs a handful of PUTs,
not a full re-upload. Nothing is ever deleted from R2 by this tool.

The hash compared is the uploaded file's own bytes, not the source-image hash
`generate:mips` embeds in `metadata.json` - that also catches a pyramid level
re-encoded at a different JPEG quality, which shares its source hash with the
old level but isn't the same bytes.

A matching hash alone doesn't prove the object is still in the bucket - the
manifest only records what a past run *believed* it wrote, and a manual
delete or any other out-of-band loss would otherwise read as "unchanged"
forever. Every run also lists the bucket (scoped to this corpus's prefix and
to `shared/`) and re-uploads any key missing from that listing regardless of
its recorded hash.

The pure decision logic (which files make up a corpus upload, and which of
those are new/changed) lives in `lib.ts`, tested without any real corpus or
bucket in `lib.test.mjs`.

## Cache purge

If the bucket is fronted by a Cloudflare zone with `enable_zone_protections`
(see `infra/`), every object under `assets_hostname` - including
`manifest.json` itself - is edge-cached for `cache_edge_ttl_seconds` (24h by
default). Replacing a file under an existing key, or overwriting
`manifest.json` in place, leaves the edge serving the old copy until that TTL
expires. This tool purges exactly the keys it just wrote, if you set:

```sh
export CLOUDFLARE_API_TOKEN=...        # needs Zone.Cache Purge on the zone below
export CLOUDFLARE_ZONE_ID=...          # the zone fronting the bucket
export CLOUDFLARE_ASSETS_HOSTNAME=...  # matches terraform's assets_hostname
```

All three unset skips the purge with a note - the common case for a bucket
with no zone protections, or a purely local demo. Purges go out at most 30
URLs per Cloudflare API call; past 1000 keys in one run, a single
`purge_everything` call replaces the whole batch instead.

A Cloudflare `purge_cache` call can return `success: true` and still not
evict a given object - observed in practice on `metadata.json`/`tagLinks.json`
after a real CORS-config change, confirmed stale by comparing a normal
request against one with a cache-busting query string (which reaches the
origin directly and proved R2 itself was already correct). Retrying the same
by-URL purge did nothing; a `purge_everything` call for the zone, or a manual
purge from the Cloudflare dashboard, is what actually cleared it. If a page
still shows stale data (or CORS errors on a request that used to work) after
this tool prints `cache purged: N key(s)`, don't assume the purge script is
broken - check the object directly with a cache-busting query string first,
and fall back to a dashboard purge if the API-driven one didn't take.

## Concurrency

Hashing and uploading both run up to 16 files at once, through the same
bounded-concurrency `createLimiter` used for CLIP inference
(`packages/server/search-cache.ts`) - each file is a separate network or disk
round trip, and running them one at a time pays full latency per file for no
reason.
