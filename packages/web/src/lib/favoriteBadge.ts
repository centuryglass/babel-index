/**
 * The favorite badge painted into a tile's upper right corner.
 *
 * `assets/fav_on.png`/`fav_off.png` are fixed, checked-in art at a known
 * native size, designed to integrate with any tile when anchored to its top
 * right corner and scaled by the same factor `render.ts`/`slide.ts` scale the
 * tile itself - a cell's pixels-per-cell-width divided by `BASE_TILE.w`, since
 * both assets share the tile's aspect and so need no per-axis split.
 *
 * `FAV_ICON_HIT_BOUNDS` is the bounding box of the art's non-transparent
 * pixels, measured directly off the two PNGs (identical for both - only their
 * fill differs, not their silhouette). Hardcoded rather than sampled from
 * pixel data at load time: this is fixed art like the traced center-tile
 * geometry, not something that changes shape at runtime, and re-measuring it
 * on every load would just be the same fact re-derived on a timer.
 *
 * No DOM - this is the pure geometry/hit-test half, split out the same way
 * `picking.ts` and `center.ts` are.
 */
import { BASE_TILE } from './pyramid.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The native pixel size of fav_on.png/fav_off.png. */
export const FAV_ICON_SIZE = { w: 92, h: 198 };

/** The non-transparent bounds within `FAV_ICON_SIZE`, in the same native pixel space. */
export const FAV_ICON_HIT_BOUNDS: Rect = { x: 29, y: 128, w: 41, h: 49 };

/** Below this, on each axis, the badge is too small to be a fair click/tap target. */
export const MIN_FAVORITE_HIT = { desktop: 24, mobile: 48 };

/**
 * The badge's full screen rect for a tile whose top left corner is at
 * `(sx, sy)` and whose width is `cellPx.x` - anchored to the tile's upper
 * right corner, scaled by the same factor the tile itself is drawn at.
 */
export function favoriteIconScreenRect(cellPx: { x: number; y: number }, sx: number, sy: number): Rect {
  const scale = cellPx.x / BASE_TILE.w;
  const w = FAV_ICON_SIZE.w * scale;
  const h = FAV_ICON_SIZE.h * scale;
  return { x: sx + cellPx.x - w, y: sy, w, h };
}

/**
 * The native pixel size of `fav_center_switch_base.png`/`fav_mine_on.png`/
 * `fav_count_on.png` - identical for all three, since the two "on" faces
 * overlay the base plate exactly.
 */
export const FAV_SWITCH_SIZE = { w: 239, h: 240 };

/**
 * The favorites-sort switch's full screen rect on the CENTER tile, anchored
 * to its upper LEFT corner - the mirror of `favoriteIconScreenRect`'s upper
 * right, scaled by the same factor the tile itself is drawn at. The switch's
 * own hit regions are traced separately (`center.ts`'s
 * `CENTER_MINE_TOGGLE_RECT`/`CENTER_COUNT_TOGGLE_RECT`/`CENTER_SHUFFLE_RECT`);
 * this is only where the art is drawn.
 */
export function favoriteSwitchScreenRect(cellPx: { x: number; y: number }, sx: number, sy: number): Rect {
  const scale = cellPx.x / BASE_TILE.w;
  return { x: sx, y: sy, w: FAV_SWITCH_SIZE.w * scale, h: FAV_SWITCH_SIZE.h * scale };
}

/** `FAV_ICON_HIT_BOUNDS`, carried into the same screen rect as `iconRect`. */
export function favoriteHitRect(iconRect: Rect): Rect {
  const scale = iconRect.w / FAV_ICON_SIZE.w;
  return {
    x: iconRect.x + FAV_ICON_HIT_BOUNDS.x * scale,
    y: iconRect.y + FAV_ICON_HIT_BOUNDS.y * scale,
    w: FAV_ICON_HIT_BOUNDS.w * scale,
    h: FAV_ICON_HIT_BOUNDS.h * scale,
  };
}

/** Whether a hit rect this size is worth testing at all - see `MIN_FAVORITE_HIT`. */
export function isFavoriteHitEnabled(hitRect: Rect, mobile: boolean): boolean {
  const min = mobile ? MIN_FAVORITE_HIT.mobile : MIN_FAVORITE_HIT.desktop;
  return hitRect.w >= min && hitRect.h >= min;
}

export function pointInRect(px: number, py: number, rect: Rect): boolean {
  return px >= rect.x && px < rect.x + rect.w && py >= rect.y && py < rect.y + rect.h;
}
