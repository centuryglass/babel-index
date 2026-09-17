/**
 * Loading a corpus's keyword/story sidecar and tag-link map, in real parsed
 * form, for the SSR catalog routes - `scan.ts` and `remote.ts` ship only
 * `{url, ...counts}` for both, keeping the manifest small (see the
 * `metadata` note in `scanDirectory`).
 *
 * Mode-aware, because the two modes have different things to read: local
 * mode has the same flat files `scan.ts` reads (`METADATA_FILE`/
 * `TAG_LINKS_FILE` names in the images directory), while remote mode only
 * has the already-rebased absolute urls `remote.ts` put on the manifest.
 *
 * Loaded once and memoized per manifest: the server scans a corpus once at
 * startup and never rescans it, and re-parsing a multi-megabyte sidecar on
 * every catalog request would be waste, not freshness.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { joinMetadata } from '../map/metadata.ts';
import { METADATA_FILE, TAG_LINKS_FILE } from './scan.ts';
import type { Manifest, Room } from '../map/manifest.ts';
import type { RoomMeta } from '../map/metadata.ts';

export interface RoomContent {
  /** Indexed by room id, as `joinMetadata` returns it; null where absent entirely. */
  metadata: (RoomMeta | null)[];
  /** Keyword -> external link, or null when the corpus has no tagLinks.json. */
  tagLinks: Record<string, string> | null;
}

/**
 * Local mode reads the flat file from the images directory; remote mode
 * fetches the manifest's already-rebased absolute url.
 */
async function readSidecar(localFile: string, remoteUrl: string, imagesDir: string | null): Promise<unknown> {
  if (imagesDir) return JSON.parse(await readFile(join(imagesDir, localFile), 'utf8'));
  const res = await fetch(remoteUrl);
  if (!res.ok) throw new Error(`failed to fetch ${remoteUrl}: ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * @param imagesDir the local corpus directory (local mode), or null (remote
 *   mode) - mirrors `createApp`'s own `imagesDir` option.
 */
async function loadUncached(manifest: Manifest, imagesDir: string | null): Promise<RoomContent> {
  const rooms: Room[] = manifest.rooms;

  let metadata: (RoomMeta | null)[] = new Array(rooms.length).fill(null);
  if (manifest.metadata) {
    try {
      const sidecar = await readSidecar(METADATA_FILE, manifest.metadata.url, imagesDir);
      metadata = joinMetadata(rooms, sidecar);
    } catch {
      // Same "absent, unreadable, or malformed - just no metadata" tolerance
      // scan.ts's own sidecar read uses.
    }
  }

  let tagLinks: Record<string, string> | null = null;
  if (manifest.tagLinks) {
    try {
      const map = await readSidecar(TAG_LINKS_FILE, manifest.tagLinks.url, imagesDir);
      if (map && typeof map === 'object' && !Array.isArray(map)) tagLinks = map as Record<string, string>;
    } catch {
      // no file, unreadable, or malformed - leave tagLinks null
    }
  }

  return { metadata, tagLinks };
}

// Keyed by manifest identity (a process only ever scans one corpus, but tests
// build more than one `Manifest` per process) rather than a single bare
// promise - the same reasoning `app.ts`'s `textTowerPromises` documents.
const cache = new WeakMap<Manifest, Promise<RoomContent>>();

/** Load this manifest's room content, fetching it at most once per process. */
export function loadRoomContent(manifest: Manifest, imagesDir: string | null): Promise<RoomContent> {
  let promise = cache.get(manifest);
  if (!promise) {
    promise = loadUncached(manifest, imagesDir);
    cache.set(manifest, promise);
  }
  return promise;
}
