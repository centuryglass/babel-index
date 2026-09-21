/**
 * Pure decision logic for the R2 upload tool: which files need uploading, and
 * under what keys. No filesystem and no network here, so the rules are
 * testable without a corpus on disk or a bucket to talk to; `upload-r2.ts`
 * does the I/O.
 */
import type { Manifest } from '../../packages/map/manifest.ts';
import type { AnimationManifest } from '../center-animation/lib.ts';
import { sheetFileName } from '../../packages/pipeline/layout.ts';

export interface UploadEntry {
  local: string;
  key: string;
}

/**
 * The loading-animation manifest and every sheet it names, under
 * `shared/animation/`.
 *
 * The corpus `Manifest` does not describe these files, so the caller loads
 * the on-disk animation manifest itself and hands it in. Null (no manifest on
 * disk) uploads nothing - the same "no indicator deployed" case the client
 * (`loadingAnimation.ts`) tolerates as a 404. Like the rest of `shared/`,
 * these are shared across corpora, so no corpus prefix gates them.
 */
function animationKeys(animation: AnimationManifest | null | undefined): string[] {
  if (!animation) return [];
  const keys = ['shared/animation/manifest.json'];
  for (const cycle of animation.cycles) {
    const key = `shared/animation/${cycle.sheet}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export interface HashedUploadEntry extends UploadEntry {
  hash: string | undefined;
}

export type JoinPath = (...parts: string[]) => string;

/**
 * Every (local path, remote key) pair a corpus upload touches, derived from a
 * `scanDirectory()` manifest the same way the demo server and `tools/embed`
 * read it - "what files make up a corpus" has one definition, so a change to
 * the scan's shape lands here too.
 *
 * Keys mirror the local layout (`<prefix>/<file>`, `<prefix>/<level-dir>/<file>`)
 * so `packages/server/remote.ts` can resolve a room's url the same way
 * `packages/web/src/lib/rooms.ts` does locally. Shared assets (the center tile
 * and the generics) live outside any one corpus's prefix, at `shared/...`,
 * matching the demo server's `/shared/` mount, so multiple corpora point at
 * the same tiles.
 *
 * `join` is path.join, injected so this stays free of node:path and testable
 * with plain strings.
 */
export function buildUploadList(
  manifest: Manifest,
  {
    imagesDir,
    sharedDir,
    prefix,
    animation,
  }: { imagesDir: string; sharedDir: string; prefix: string; animation?: AnimationManifest | null },
  join: JoinPath
): UploadEntry[] {
  const uploads: UploadEntry[] = [];

  for (const room of manifest.rooms) uploads.push({ local: join(imagesDir, room.file), key: `${prefix}/${room.file}` });

  for (const level of manifest.levels) {
    if (level.level === 0) continue; // level 0 is the flat files, pushed by the manifest.rooms loop
    if (level.sheet) {
      // A sheet-packed level uploads one object per sheet file, not per room -
      // fewer, larger objects is the point of sheet packing.
      for (let i = 0; i < level.sheet.sheetCount; i++) {
        const file = sheetFileName(i, level.sheet.ext);
        uploads.push({ local: join(imagesDir, level.sheet.dir, file), key: `${prefix}/${level.sheet.dir}/${file}` });
      }
      continue;
    }
    if (!level.dir) continue;
    for (const room of manifest.rooms)
      uploads.push({ local: join(imagesDir, level.dir, room.file), key: `${prefix}/${level.dir}/${room.file}` });
  }

  if (manifest.metadata) uploads.push({ local: join(imagesDir, 'metadata.json'), key: `${prefix}/metadata.json` });

  if (manifest.tagLinks) uploads.push({ local: join(imagesDir, 'tagLinks.json'), key: `${prefix}/tagLinks.json` });

  if (manifest.embeddings) {
    uploads.push({ local: join(imagesDir, 'embeddings.bin'), key: `${prefix}/embeddings.bin` });
    uploads.push({ local: join(imagesDir, 'embeddings.json'), key: `${prefix}/embeddings.json` });
  }

  if (manifest.shared?.center)
    uploads.push({ local: join(sharedDir, manifest.shared.center.file), key: `shared/${manifest.shared.center.file}` });

  for (const generic of manifest.shared?.generic ?? [])
    uploads.push({ local: join(sharedDir, 'generic', generic.file), key: `shared/generic/${generic.file}` });

  // The shared tiles' own pyramid (packages/pipeline/shared-mips.ts), mirroring
  // the manifest.levels loop above: one object per level per file, center and
  // every generic tile, skipping level 0 (already pushed by the two loops
  // above) and any level with no per-file dir (there is no sheet-packed shape
  // for the shared tiles - see scan.ts's discoverLevels for why this can only
  // ever be a dir).
  for (const level of manifest.shared?.levels ?? []) {
    if (level.level === 0 || !level.dir) continue;
    if (manifest.shared.center)
      uploads.push({
        local: join(sharedDir, level.dir, manifest.shared.center.file),
        key: `shared/${level.dir}/${manifest.shared.center.file}`,
      });
    for (const generic of manifest.shared.generic)
      uploads.push({
        local: join(sharedDir, 'generic', level.dir, generic.file),
        key: `shared/generic/${level.dir}/${generic.file}`,
      });
  }

  for (const distill of manifest.shared?.genericDistill ?? [])
    if (distill)
      uploads.push({
        local: join(sharedDir, 'generic_distill', distill.file),
        key: `shared/generic_distill/${distill.file}`,
      });

  // `generic_distill/`'s own pyramid, mirroring the loop above - a separate
  // tree from `shared.levels` (manifest.ts's `SharedAssets` doc), so it walks
  // `shared.distillLevels` and only the tiles that actually have a distill
  // alternate.
  for (const level of manifest.shared?.distillLevels ?? []) {
    if (level.level === 0 || !level.dir) continue;
    for (const distill of manifest.shared?.genericDistill ?? [])
      if (distill)
        uploads.push({
          local: join(sharedDir, 'generic_distill', level.dir, distill.file),
          key: `shared/generic_distill/${level.dir}/${distill.file}`,
        });
  }

  // Fixed app art, not part of any corpus's manifest.shared: the badges and
  // toggles resolve off `manifest.sharedBase` in packages/web/src/lib/rooms.ts,
  // the leather texture behind the dark chrome via a relative `url(shared/...)`
  // in packages/web/style.css. Always uploaded, unlike the manifest-gated
  // center/generic tiles - there is no manifest field to gate on.
  for (const file of [
    'fav_on.png', 'fav_off.png',
    'fav_center_switch_base.png', 'fav_mine_on.png', 'fav_count_on.png',
    'distill_off.png', 'distill_on.png',
    'clear_history_book.png',
    'leather_texture_tile.png',
  ])
    uploads.push({ local: join(sharedDir, file), key: `shared/${file}` });

  // The animation files (see animationKeys), mapped from the
  // `shared/animation/...` key to a path under sharedDir, like the
  // center/generic entries.
  for (const key of animationKeys(animation))
    uploads.push({ local: join(sharedDir, key.slice('shared/'.length)), key });

  return uploads;
}

/**
 * Split an upload list into what needs uploading and what's already current:
 * each file's freshly-computed content hash against the record for its key in
 * the previously-uploaded manifest. A key absent from the remote manifest
 * (new file, or first run) always uploads.
 *
 * Hashing the file's own bytes, not reusing metadata.json's per-source hash,
 * is deliberate: every quality setting of a re-encoded pyramid level shares
 * the old level's source hash while being different bytes.
 *
 * A matching hash alone isn't enough. `upload-manifest.json` records what a
 * previous run believed it wrote, not what's in the bucket now - an object
 * deleted out-of-band, by hand or by a lifecycle rule, would read as
 * "unchanged" forever with no way to notice. `existingKeys`, a live listing
 * of the bucket, closes that gap: a key missing from it uploads regardless of
 * the recorded hash.
 */
export function diffAgainstManifest(
  uploads: UploadEntry[],
  hashes: Map<string, string>,
  remoteManifest: Record<string, string>,
  existingKeys: Set<string>
): { toUpload: HashedUploadEntry[]; unchanged: HashedUploadEntry[] } {
  const toUpload: HashedUploadEntry[] = [];
  const unchanged: HashedUploadEntry[] = [];
  for (const { local, key } of uploads) {
    const hash = hashes.get(local);
    const entry = { local, key, hash };
    if (remoteManifest[key] === hash && existingKeys.has(key)) unchanged.push(entry);
    else toUpload.push(entry);
  }
  return { toUpload, unchanged };
}

/**
 * The keys a browser reads with `fetch()` rather than an `<img>` tag: the
 * corpus sidecars in `packages/web/src/hooks/useCorpus.ts` and the animation
 * files in `loadingAnimation.ts`, gated on the same manifest fields as
 * `buildUploadList`.
 *
 * The upload tool purges these from the edge cache every run, regardless of
 * `toUpload`. For a `fetch()`ed resource a stale cached *response* can be the
 * problem rather than stale bytes: a response cached without CORS headers -
 * before `cloudflare_r2_bucket_cors` existed, or by a no-Origin request -
 * silently breaks the reader in `--remote` mode even when the bytes are
 * current, and content-hash diffing only guards against the latter.
 */
export function crossOriginFetchedKeys(
  manifest: Manifest,
  prefix: string,
  animation?: AnimationManifest | null
): string[] {
  const keys: string[] = [];
  if (manifest.metadata) keys.push(`${prefix}/metadata.json`);
  if (manifest.tagLinks) keys.push(`${prefix}/tagLinks.json`);
  if (manifest.embeddings) {
    keys.push(`${prefix}/embeddings.bin`);
    keys.push(`${prefix}/embeddings.json`);
  }
  keys.push(...animationKeys(animation));
  return keys;
}

/** Guess a Content-Type from a key's extension, for the objects this tool writes. */
export function guessContentType(key: string): string {
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.bin')) return 'application/octet-stream';
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}
