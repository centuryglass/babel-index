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
 *
 * The permalink table (`packages/map/slug.ts`) is built here, so it is
 * memoized alongside the titles it reads. The corpus's curation warnings -
 * rooms that collide on a permalink, rooms with no alt text - come from this
 * same load, so each is said once per process.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { joinMetadata } from '../map/metadata.ts';
import { buildSlugTable, type SlugTable } from '../map/slug.ts';
import { METADATA_FILE, TAG_LINKS_FILE } from './scan.ts';
import { logger } from './logger.ts';
import type { Manifest, Room } from '../map/manifest.ts';
import type { RoomMeta } from '../map/metadata.ts';

export interface RoomContent {
  /** Indexed by room id, as `joinMetadata` returns it; null where absent entirely. */
  metadata: (RoomMeta | null)[];
  /** Keyword -> external link, or null when the corpus has no tagLinks.json. */
  tagLinks: Record<string, string> | null;
  /** Every room's permalink, built from the titles just loaded. */
  slugs: SlugTable;
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
 * How many filenames the missing-alt warning lists. Its count is always
 * exact; the cap keeps a large uncaptioned corpus from flooding the startup
 * log.
 */
export const MISSING_ALT_LISTED = 20;

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

  const slugs = buildSlugTable(rooms, metadata);
  // Unique titles are the generator's job, and this is the only place a lapse
  // becomes visible: every room stays reachable (`buildSlugTable` disambiguates
  // with the filename stem), so nothing here fails, and a permalink nobody
  // meant to write would otherwise ship unnoticed.
  for (const c of slugs.collisions)
    logger.warn(
      { wanted: c.wanted, rooms: c.rooms },
      'more than one room asked for this permalink - two rooms share a title, or a title matches another room\'s filename'
    );

  // Alt text is the curation tools' job, and this is the only place a lapse
  // becomes visible: the client gives the image an empty `alt`, which a screen
  // reader skips as decorative, so nothing fails. A room with no sidecar entry
  // lacks it too. The center and generic tiles are not in `rooms`
  // (`scanDirectory`), so they are never counted.
  const missingAlt = rooms.filter((r) => !metadata[r.id]?.alt).map((r) => r.file);
  if (missingAlt.length)
    logger.warn(
      { missing: missingAlt.length, files: missingAlt.slice(0, MISSING_ALT_LISTED) },
      'rooms with no alt text - the client marks their images decorative, so a screen reader skips them'
    );

  return { metadata, tagLinks, slugs };
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
