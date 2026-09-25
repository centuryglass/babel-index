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
 * A level the corpus does not have resolves to null, not to a url that would
 * 404. A flat directory of images that never went through the pipeline
 * therefore resolves only level 0, and every lookup falls back to it.
 *
 * Shared art (`manifest.shared`, served from `--shared-dir`) has its own
 * pyramids, one manifest array per group (docs/agents/map.md, "Shared art has
 * its own pyramids"):
 * - the center and every generic tile resolve off `shared.levels`;
 * - generic distill alternates resolve off `shared.distillLevels`;
 * - the favorite badge's faces (`FAV_ON`/`FAV_OFF`) resolve off
 *   `shared.favoriteLevels`.
 *
 * A shared level resolves by inserting `<width>/` before the asset's
 * filename, the layout `packages/pipeline/shared-mips.ts` writes. A level
 * missing from the group's array resolves to null.
 *
 * Every other shared id (the distill toggle's faces, the "forget searches"
 * overlay) is flat level-0 art, reached through the cache's `servableLevel`
 * for any coarser request. The cache keys on id, not cell, so a screen of
 * thousands of generic cells holds only those few images.
 */
import {
  CENTER, genericId, genericDistillId, FAV_ON, FAV_OFF, FAV_CENTER_SWITCH_BASE, FAV_MINE_ON, FAV_COUNT_ON,
  DISTILL_OFF, DISTILL_ON, CLEAR_HISTORY_BOOK,
} from './tiles.ts';
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
 * what the canvas render path (`tiles.ts`/`render.ts`/`slide.ts`) uses, since
 * a canvas can cheaply draw a sub-rect of a shared, already-decoded image.
 *
 * @param manifest as served by /api/manifest
 */
export function createTileLocator(manifest: Manifest): LocateTile {
  // Older manifests have no `levels`; a flat level 0 is the honest reading.
  const levels = new Map((manifest.levels ?? [{ level: 0, dir: null }]).map((l) => [l.level, l]));
  // Older manifests (and any manifest.imagesBase omission) fall back to the
  // local mount path - see `scan.ts`'s IMAGES_BASE.
  const imagesBase = manifest.imagesBase ?? '/images';

  // Every shared-tile id to its (level-0) url, so resolving one is a lookup
  // rather than string-parsing an index back out of the id.
  const shared = manifest.shared;
  const sharedUrls = new Map<number | string, string>();
  // The ids with a pyramid of their own - see this file's header. A coarser
  // level is only ever tried for one of these.
  const pyramidSharedIds = new Set<number | string>();
  if (shared.center?.url) {
    sharedUrls.set(CENTER, shared.center.url);
    pyramidSharedIds.add(CENTER);
  }
  shared.generic.forEach((v, i) => {
    sharedUrls.set(genericId(i), v.url);
    pyramidSharedIds.add(genericId(i));
  });
  // Older manifests have no `shared.levels`; a flat level 0 is the honest
  // reading, same as `manifest.levels`' own fallback above.
  const sharedLevels = new Map((shared.levels ?? [{ level: 0, dir: null }]).map((l) => [l.level, l]));
  // `generic_distill/`'s own pyramid, kept in a separate map rather than
  // merged into `sharedLevels` - see manifest.ts's `SharedAssets` doc for why
  // the two trees are never intersected.
  const distillLevels = new Map((shared.distillLevels ?? [{ level: 0, dir: null }]).map((l) => [l.level, l]));
  // Only an index whose generic tile has a matching distill alternate on disk
  // gets an entry - see `genericDistillId`'s doc for what a missing one means.
  const distillSharedIds = new Set<number | string>();
  shared.genericDistill?.forEach((v, i) => {
    if (v) {
      const id = genericDistillId(i);
      sharedUrls.set(id, v.url);
      pyramidSharedIds.add(id);
      distillSharedIds.add(id);
    }
  });
  // The favorite badge's pyramid, same treatment as `distillLevels` - a
  // third map, never intersected with the other two (see manifest.ts's doc).
  const favoriteLevels = new Map((shared.favoriteLevels ?? [{ level: 0, dir: null }]).map((l) => [l.level, l]));
  const favoriteSharedIds = new Set<number | string>([FAV_ON, FAV_OFF]);
  // The badge's level-0 urls: fixed app art, not part of a scanned corpus, so
  // not listed in `manifest.shared.center`/`generic` - but they live in the
  // same `--shared-dir` and are served from its base like the center tile's
  // level 0. Only their per-level widths are discovered, in
  // `SharedAssets.favoriteLevels`.
  sharedUrls.set(FAV_ON, `${manifest.sharedBase}/${encodeURIComponent('fav_on.png')}`);
  sharedUrls.set(FAV_OFF, `${manifest.sharedBase}/${encodeURIComponent('fav_off.png')}`);
  pyramidSharedIds.add(FAV_ON);
  pyramidSharedIds.add(FAV_OFF);
  // The center tile's favorites-sort switch art - same fixed-app-art treatment.
  sharedUrls.set(FAV_CENTER_SWITCH_BASE, `${manifest.sharedBase}/${encodeURIComponent('fav_center_switch_base.png')}`);
  sharedUrls.set(FAV_MINE_ON, `${manifest.sharedBase}/${encodeURIComponent('fav_mine_on.png')}`);
  sharedUrls.set(FAV_COUNT_ON, `${manifest.sharedBase}/${encodeURIComponent('fav_count_on.png')}`);
  // The distill-mode toggle's two faces - same fixed-app-art treatment.
  sharedUrls.set(DISTILL_OFF, `${manifest.sharedBase}/${encodeURIComponent('distill_off.png')}`);
  sharedUrls.set(DISTILL_ON, `${manifest.sharedBase}/${encodeURIComponent('distill_on.png')}`);
  // The "forget searches" book's black spine overlay - same fixed-app-art treatment.
  sharedUrls.set(CLEAR_HISTORY_BOOK, `${manifest.sharedBase}/${encodeURIComponent('clear_history_book.png')}`);

  const resolve = (id: number | string, level: number): TileLocation | null => {
    if (sharedUrls.has(id)) {
      const url = sharedUrls.get(id)!;
      if (level === 0) return { url, rect: null };
      if (!pyramidSharedIds.has(id)) return null;
      const levelMap = distillSharedIds.has(id) ? distillLevels : favoriteSharedIds.has(id) ? favoriteLevels : sharedLevels;
      const info = levelMap.get(level);
      // Insert `<width>/` before the filename - the same per-level directory
      // `shared-mips.ts` wrote it into, right beside where level 0 already sits.
      if (!info?.dir) return null;
      const slash = url.lastIndexOf('/');
      return { url: `${url.slice(0, slash + 1)}${info.dir}/${url.slice(slash + 1)}`, rect: null };
    }

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

  // The answer for a given (id, level) never changes for this manifest, but
  // computing it allocates a fresh TileLocation/rect every call - and the
  // cache asks on every visible cell every frame, cache hits included.
  // Memoized per level then id: the returned object is now SHARED across
  // every caller for that (id, level), so nobody may mutate a TileLocation
  // or its rect - callers only ever read them today.
  const cache = new Map<number, Map<number | string, TileLocation | null>>();
  return (id, level) => {
    let byId = cache.get(level);
    if (!byId) {
      byId = new Map();
      cache.set(level, byId);
    }
    if (byId.has(id)) return byId.get(id)!;
    const loc = resolve(id, level);
    byId.set(id, loc);
    return loc;
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
