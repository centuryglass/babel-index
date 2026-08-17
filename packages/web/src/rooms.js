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
 * The base tiles - the centre and every wallpaper variant - live OUTSIDE the
 * corpus pyramid (`manifest.base`, served from `--base-dir`), so they are looked
 * up here by their own ids and served flat: level 0 only, and every coarser
 * request falls back to it through the cache's `servableLevel`. There are only a
 * handful of distinct base images and the cache keys on id, not on cell, so a
 * far-out screen of thousands of generic cells still holds just those few in
 * memory. (Giving the base assets their own resolution pyramid is a later step.)
 */
import { CENTRE, variantId } from './tiles.js';

/**
 * @param {object} manifest  as served by /api/manifest
 * @returns {(id: number|string, level: number) => string|null}
 */
export function createUrlFor(manifest) {
  // Older manifests have no `levels`; a flat level 0 is the honest reading.
  const dirs = new Map((manifest.levels ?? [{ level: 0, dir: null }]).map((l) => [l.level, l.dir]));

  // Every base-tile id to its (flat) url, so resolving one is a lookup rather
  // than string-parsing an index back out of the id.
  const base = manifest.base ?? {};
  const baseUrls = new Map();
  if (base.centre?.url) baseUrls.set(CENTRE, base.centre.url);
  (base.variants ?? []).forEach((v, i) => baseUrls.set(variantId(i), v.url));

  return (id, level) => {
    if (baseUrls.has(id)) return level === 0 ? baseUrls.get(id) : null;

    if (!dirs.has(level)) return null;
    const file = manifest.rooms[id]?.file;
    if (file == null) return null;

    const dir = dirs.get(level);
    // Level 0 is flat, so its url is exactly the `url` the manifest already
    // carries for each room - the two must not drift apart.
    return `/images/${dir ? `${dir}/` : ''}${encodeURIComponent(file)}`;
  };
}
