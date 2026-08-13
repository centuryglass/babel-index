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
 */
import { GENERIC } from './tiles.js';

/**
 * @param {object} manifest  as served by /api/manifest
 * @returns {(id: number|string, level: number) => string|null}
 */
export function createUrlFor(manifest) {
  // Older manifests have no `levels`; a flat level 0 is the honest reading.
  const dirs = new Map((manifest.levels ?? [{ level: 0, dir: null }]).map((l) => [l.level, l.dir]));

  return (id, level) => {
    if (!dirs.has(level)) return null;
    const file = id === GENERIC ? manifest.generic?.file : manifest.rooms[id]?.file;
    if (file == null) return null;

    const dir = dirs.get(level);
    // Level 0 is flat, so its url is exactly the `url` the manifest already
    // carries for each room - the two must not drift apart.
    return `/images/${dir ? `${dir}/` : ''}${encodeURIComponent(file)}`;
  };
}
