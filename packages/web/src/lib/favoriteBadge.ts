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
import { layout } from '../../../../tools/center-placement/lib/geometry.ts';
import { flattenPath, pointInPolygon, type Point } from './svgPath.ts';
import { BASE_TILE } from './pyramid.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GEOMETRY = layout({ width: 1, height: 1 });

/**
 * The on-tile favorite badge's traced silhouette - `tile_fav_toggle` in
 * `shelf_geometry.svg`, an ellipse fitted to the badge art's non-transparent
 * pixels and imported the same way `center.ts`'s `CENTER_BOOK_PATH` is: the
 * canonical M/L/C/Z grammar, every coordinate a fraction of the WHOLE tile
 * (not of the badge's own icon), so it scales the same way every other traced
 * rect on a tile does - per axis, by that tile's `cellPx`. Null on a trace
 * with none, in which case a badge draws no hover highlight.
 */
export const FAVORITE_TOGGLE_PATH: string | null = GEOMETRY.favoriteToggle?.d ?? null;

/** `FAVORITE_TOGGLE_PATH` flattened into a polygon once at module load - see `CENTER_BOOK_POLYGON` in `center.ts` for the same tradeoff. */
const FAVORITE_TOGGLE_POLYGON: Point[] | null = FAVORITE_TOGGLE_PATH ? flattenPath(FAVORITE_TOGGLE_PATH) : null;

/** The native pixel size of fav_on.png/fav_off.png. */
export const FAV_ICON_SIZE = { w: 92, h: 198 };

/** The non-transparent bounds within `FAV_ICON_SIZE`, in the same native pixel space. */
export const FAV_ICON_HIT_BOUNDS: Rect = { x: 29, y: 128, w: 41, h: 49 };

/**
 * Touch-only floor for the badge's tap target, on each axis - a coarse
 * pointer gets its hit rect padded up to at least this size (see
 * `favoriteHitRect`). Mouse/trackpad input is precise enough that the art's
 * own bounds are always a fair target, so this never applies to it.
 */
export const MIN_FAVORITE_HIT_TOUCH = 20;

/**
 * The padded touch hit rect may never exceed this fraction of the tile's own
 * area - otherwise, at extreme zoom-out, a tiny badge would pad out to
 * cover most of the tile and turn "tap the tile" into "tap the favorite
 * button" by accident.
 */
const TOUCH_HIT_AREA_CAP = 0.1;

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

/**
 * `FAV_ICON_HIT_BOUNDS`, carried into the same screen rect as `iconRect` -
 * then, for a coarse (touch) pointer only, grown to `MIN_FAVORITE_HIT_TOUCH`
 * on each axis (centered on the art's own bounds) and capped so the result
 * never exceeds `TOUCH_HIT_AREA_CAP` of the tile's area. A mouse/trackpad
 * gets the raw art bounds back unchanged - there is no disabled state here
 * any more: a badge is always tappable, just not always as forgivingly.
 */
export function favoriteHitRect(iconRect: Rect, cellPx: { x: number; y: number }, touch: boolean): Rect {
  const scale = iconRect.w / FAV_ICON_SIZE.w;
  const rect: Rect = {
    x: iconRect.x + FAV_ICON_HIT_BOUNDS.x * scale,
    y: iconRect.y + FAV_ICON_HIT_BOUNDS.y * scale,
    w: FAV_ICON_HIT_BOUNDS.w * scale,
    h: FAV_ICON_HIT_BOUNDS.h * scale,
  };
  if (!touch) return rect;
  const maxSide = Math.sqrt(cellPx.x * cellPx.y * TOUCH_HIT_AREA_CAP);
  const w = Math.min(Math.max(rect.w, MIN_FAVORITE_HIT_TOUCH), maxSide);
  const h = Math.min(Math.max(rect.h, MIN_FAVORITE_HIT_TOUCH), maxSide);
  return { x: rect.x - (w - rect.w) / 2, y: rect.y - (h - rect.h) / 2, w, h };
}

export function pointInRect(px: number, py: number, rect: Rect): boolean {
  return px >= rect.x && px < rect.x + rect.w && py >= rect.y && py < rect.y + rect.h;
}

/**
 * Whether a screen point lands on the favorite badge's traced SILHOUETTE, not
 * merely `favoriteHitRect`'s bounding box - the same "shape, not a box"
 * argument `centerBookAtPoint` (`center.ts`) makes for the open book.
 * `cellPx`/`sx`/`sy` are the whole tile's own screen geometry (as `render.ts`
 * draws it), since `FAVORITE_TOGGLE_PATH` is traced against the whole tile,
 * not the badge icon alone. Used for the hover highlight only - the tap hit
 * test still goes through `favoriteHitRect`, which exists precisely to be
 * more forgiving than the art's own outline (on touch, considerably more so).
 */
export function favoriteToggleAtPoint(
  px: number,
  py: number,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number
): boolean {
  if (!FAVORITE_TOGGLE_POLYGON) return false;
  return pointInPolygon((px - sx) / cellPx.x, (py - sy) / cellPx.y, FAVORITE_TOGGLE_POLYGON);
}
