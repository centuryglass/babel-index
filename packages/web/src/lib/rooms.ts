/**
 * Turning `(room, level)` into where to draw it from.
 *
 * The manifest says which levels the corpus actually has on disk, what
 * directory each per-file level lives in, and - for a sheet-packed level
 * (`level.sheet`, see packages/map/manifest.ts) - the grid geometry many
 * rooms share one image under (`scan.ts` discovers all of this). The cache
 * asks for a room at a level and does not want to know about directories or
 * sheets; this is the one place all three meet.
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
import { CENTER, genericId, FAV_ON, FAV_OFF } from './tiles.ts';
import { sheetPosition, sheetFileName } from '../../../pipeline/layout.ts';
import type { Manifest } from '../../../map/manifest.ts';

/** A source rectangle within a shared sheet image, in that image's own pixels. */
export type Rect = { sx: number; sy: number; sw: number; sh: number };

/** Where to draw a room from: a url, plus a source rect if it's packed into a sheet. */
export type TileLocation = { url: string; rect: Rect | null };

export type LocateTile = (id: number | string, level: number) => TileLocation | null;
export type UrlFor = (id: number | string, level: number) => string | null;

/**
 * The full locator: resolves `(id, level)` to a url and, for a sheet-packed
 * level, the rectangle within that sheet's image the room occupies. This is
 * what the canvas render path (`tiles.ts`/`render.js`/`slide.js`) uses, since
 * a canvas can cheaply draw a sub-rect of a shared, already-decoded image.
 *
 * @param manifest as served by /api/manifest
 */
export function createTileLocator(manifest: Manifest): LocateTile {
  // Older manifests have no `levels`; a flat level 0 is the honest reading.
  const levels = new Map((manifest.levels ?? [{ level: 0, dir: null }]).map((l) => [l.level, l]));
  // Older manifests (and any manifest.imagesBase omission) fall back to the
  // local mount path - see scan.mjs's IMAGES_BASE.
  const imagesBase = manifest.imagesBase ?? '/images';

  // Every shared-tile id to its (flat) url, so resolving one is a lookup rather
  // than string-parsing an index back out of the id.
  const shared = manifest.shared;
  const sharedUrls = new Map<number | string, string>();
  if (shared.center?.url) sharedUrls.set(CENTER, shared.center.url);
  shared.generic.forEach((v, i) => sharedUrls.set(genericId(i), v.url));
  // The favorite badge's two faces are fixed app art, not part of a scanned
  // corpus, so they are not in `manifest.shared` - but they live in the same
  // `--shared-dir` and are served flat from it exactly like the center tile.
  sharedUrls.set(FAV_ON, `${manifest.sharedBase}/${encodeURIComponent('fav_on.png')}`);
  sharedUrls.set(FAV_OFF, `${manifest.sharedBase}/${encodeURIComponent('fav_off.png')}`);

  return (id, level) => {
    if (sharedUrls.has(id)) return level === 0 ? { url: sharedUrls.get(id)!, rect: null } : null;

    const info = levels.get(level);
    if (!info) return null;

    if (info.sheet) {
      const idx = typeof id === 'number' ? id : Number(id);
      if (!Number.isInteger(idx) || idx < 0) return null;
      const { sheetIndex, col, row } = sheetPosition(idx, info.sheet);
      if (sheetIndex >= info.sheet.sheetCount) return null;
      const file = sheetFileName(sheetIndex, info.sheet.ext);
      return {
        url: `${imagesBase}/${info.sheet.dir}/${file}`,
        rect: { sx: col * info.sheet.tileW, sy: row * info.sheet.tileH, sw: info.sheet.tileW, sh: info.sheet.tileH },
      };
    }

    const file = manifest.rooms[id]?.file;
    if (file == null) return null;

    // Level 0 is flat, so its url is exactly the `url` the manifest already
    // carries for each room - the two must not drift apart.
    return { url: `${imagesBase}/${info.dir ? `${info.dir}/` : ''}${encodeURIComponent(file)}`, rect: null };
  };
}

/**
 * The bare-url view of the locator above, for callers (an `<img>` tag) that
 * cannot draw a source rect. A sheet-packed level has no single url that
 * means the whole tile, so it resolves to null here exactly like any other
 * level the corpus doesn't have - the caller's existing missing-level
 * fallback (typically to level 0) is what actually serves it.
 *
 * @param manifest as served by /api/manifest
 */
export function createUrlFor(manifest: Manifest): UrlFor {
  const locate = createTileLocator(manifest);
  return (id, level) => {
    const loc = locate(id, level);
    return loc && !loc.rect ? loc.url : null;
  };
}
