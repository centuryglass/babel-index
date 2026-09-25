# tools/upload - Cloudflare R2 sync

Uploads a corpus - room images at every generated pyramid level, the
keyword/story sidecar, the optional keyword -> external-link map, the CLIP
embeddings blob, and the shared center/generic tiles - to Cloudflare R2.

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
npm run upload:r2                                # assets/corpus-sample/, prefix "corpus-sample"
npm run upload:r2 -- --images <dir> [--shared-dir assets] \
  [--prefix <name>] [--bucket <name>] [--center center.jpg] [--dry-run]
```

`--dry-run` prints what would be uploaded without touching R2 or writing
credentials-requiring requests beyond the manifest fetch.

## Layout in the bucket

Keys mirror the local layout, so the demo server's `--remote` mode
(`packages/server/remote.ts`) serves the bucket through the same manifest
shape as a local scan:

```
<prefix>/001.jpg                  level 0 (flat)
<prefix>/512/001.jpg              level 1
<prefix>/metadata.json
<prefix>/tagLinks.json            only if the corpus has one
<prefix>/embeddings.bin
<prefix>/embeddings.json
<prefix>/manifest.json            the scanDirectory() result, read by --remote
<prefix>/upload-manifest.json     this tool's own bookkeeping (below)
shared/center_tile.png
shared/generic/a.jpg
shared/animation/manifest.json    only if the loading indicator is built
shared/animation/sheets/*.png     the loading-animation frame sheets
```

`prefix` defaults to the basename of `--images`, so different corpora don't
collide in one bucket. The shared tiles live outside any prefix, at the
bucket root, since multiple corpora can point at the same center/generic
assets. The loading-animation manifest and sheets ride up the same way, read
from `<shared-dir>/animation/`; a shared dir without one (no indicator built)
uploads nothing there.

`manifest.json` is the `scanDirectory()` result, the same shape
`/api/manifest` serves locally, written on every run. `--remote` fetches it,
so the bucket needs no listing API: the scan runs once, here, at upload time.

## Incremental by content hash

A run's manifest - key -> sha256 of the bytes uploaded under that key - is
written back to `<prefix>/upload-manifest.json`. The next run hashes every
local file the corpus touches and skips any whose hash still matches the
manifest's record, so touching a handful of images costs a handful of PUTs,
not a full re-upload. Nothing is ever deleted from R2 by this tool.

The hash compared is the uploaded file's own bytes (`contentHash` from
`packages/pipeline/mips.ts`), so a pyramid level re-encoded at a different
JPEG quality uploads even though its source image is unchanged.

Every run also lists the bucket (scoped to this corpus's prefix and to
`shared/`) and re-uploads any key missing from that listing regardless of
its recorded hash; `diffAgainstManifest` in `lib.ts` owns that rule.

The pure decision logic (which files make up a corpus upload, and which of
those are new/changed) lives in `lib.ts`, tested without any real corpus or
bucket in `lib.test.ts`.

## Cache purge

If the bucket is fronted by a Cloudflare zone with `enable_zone_protections`
(see `infra/`), every object under `assets_hostname`, including
`manifest.json`, is edge-cached for `cache_edge_ttl_seconds`. Replacing a
file under an existing key, or overwriting `manifest.json` in place, leaves
the edge serving the old copy until that TTL expires. This tool purges the
keys it just wrote, plus `crossOriginFetchedKeys` (`lib.ts`) on every run,
if you set:

```sh
export CLOUDFLARE_API_TOKEN=...        # needs Zone.Cache Purge on the zone below
export CLOUDFLARE_ZONE_ID=...          # the zone fronting the bucket
export CLOUDFLARE_ASSETS_HOSTNAME=...  # matches terraform's assets_hostname
```

- Any of the three unset skips the purge with a note: the case for a bucket with no
  zone protections, or a purely local demo.
- All three set but the purge request failing is an error, not a note.
- Purges go out `PURGE_BATCH` URLs per Cloudflare API call. Past
  `PURGE_ALL_THRESHOLD` keys in one run, a single `purge_everything` call
  replaces the whole batch (both constants are in `upload-r2.ts`).

A Cloudflare `purge_cache` call can return `success: true` and still not
evict a given object, and retrying the same by-URL purge does not help. If a
page still shows stale data (or CORS errors) after this tool prints
`cache purged: N key(s)`:

1. Request the object with a cache-busting query string. That reaches the
   origin directly, so it shows whether R2 itself is current.
2. If R2 is current, purge the zone from the Cloudflare dashboard, or with a
   `purge_everything` API call.

## Concurrency

Hashing and uploading both run several files at once, through the
bounded-concurrency `createLimiter` from `packages/server/search-cache.ts`.
A corpus is many small files, and running them one at a time pays full
round-trip latency per file.
