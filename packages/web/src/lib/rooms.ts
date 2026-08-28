/**
 * Turning `(room, level)` into a url.
 *
 * The manifest says which levels the corpus actually has on disk and what
 * directory each one lives in (`scan.mjs` discovers this); the cache asks for a
 * room at a level and does not want to know about directories. This is the one
 * place the two meet.
 *
 * A level the corpus does not have resolves to null rather than to a url that
 * would 404. That is what makes a flat directory of images - a corpus that has
 * never been through the pipeline - behave exactly as it did before the pyramid
 * existed: only level 0 resolves, so every lookup falls back to it.
 *
 * The shared tiles - the center and every generic tile - live OUTSIDE the
 * corpus pyramid (`manifest.shared`, served from `--shared-dir`), so they are
 * looked up here by their own ids and served flat: level 0 only, and every
 * coarser request falls back to it through the cache's `servableLevel`. There
 * are only a handful of distinct shared images and the cache keys on id, not
 * on cell, so a far-out screen of thousands of generic cells still holds just
 * those few in memory. (Giving the shared assets their own resolution pyramid
 * is a later step.)
 */
import { CENTER, genericId } from './tiles.js';
import type { Manifest } from '../../../map/manifest.ts';

export type UrlFor = (id: number | string, level: number) => string | null;

/** @param manifest as served by /api/manifest */
export function createUrlFor(manifest: Manifest): UrlFor {
  // Older manifests have no `levels`; a flat level 0 is the honest reading.
  const dirs = new Map(
    (manifest.levels ?? [{ level: 0, dir: null }]).map((l) => [l.level, l.dir]),
  );
  // Older manifests (and any manifest.imagesBase omission) fall back to the
  // local mount path - see scan.mjs's IMAGES_BASE.
  const imagesBase = manifest.imagesBase ?? '/images';

  // Every shared-tile id to its (flat) url, so resolving one is a lookup rather
  // than string-parsing an index back out of the id.
  const shared = manifest.shared;
  const sharedUrls = new Map<number | string, string>();
  if (shared.center?.url) sharedUrls.set(CENTER, shared.center.url);
  shared.generic.forEach((v, i) => sharedUrls.set(genericId(i), v.url));

  return (id, level) => {
    if (sharedUrls.has(id)) return level === 0 ? sharedUrls.get(id) : null;

    if (!dirs.has(level)) return null;
    const file = manifest.rooms[id]?.file;
    if (file == null) return null;

    const dir = dirs.get(level);
    // Level 0 is flat, so its url is exactly the `url` the manifest already
    // carries for each room - the two must not drift apart.
    return `${imagesBase}/${dir ? `${dir}/` : ''}${encodeURIComponent(file)}`;
  };
}
