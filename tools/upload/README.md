# tools/upload — Cloudflare R2 sync

Uploads a corpus - room images at every generated pyramid level, the
keyword/story sidecar, the CLIP embeddings blob, and the shared
center/generic tiles - to Cloudflare R2. See `docs/implementation-plan.md`'s
Hosting section.

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

The pure decision logic (which files make up a corpus upload, and which of
those are new/changed) lives in `lib.ts`, tested without any real corpus or
bucket in `lib.test.mjs`.
