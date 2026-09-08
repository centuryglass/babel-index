/**
 * The favorite badge painted into a tile's upper right corner.
 *
 * `assets/fav_on.png`/`fav_off.png` are fixed, checked-in art, designed to
 * integrate with any tile when anchored to its top right corner and scaled
 * by the same factor `render.ts`/`slide.ts` scale the tile itself - a cell's
 * pixels-per-cell-width divided by `BASE_TILE.w`, since both assets share the
 * tile's aspect and so need no per-axis split.
 *
 * Hit-testing and drawing are independent here, and that's deliberate:
 * `favoriteHitRect`/`favoriteToggleAtPoint` size and place the tap/hover
 * target from `FAVORITE_TOGGLE_BBOX`/`FAVORITE_TOGGLE_PATH` alone - both
 * traced straight off the art's own non-transparent pixels in
 * `shelf_geometry.svg`, in the same per-axis tile-fraction space as every
 * other traced rect - so neither needs the art's native pixel size at all.
 * `favoriteIconScreenRect` is the one place a size is needed, purely to place
 * the drawn icon, and it takes that size as a parameter (the decoded art's
 * own natural width/height, read by `render.ts`'s `drawFavoriteBadge` once
 * the tile cache reports it loaded) rather than a hardcoded constant, so a
 * differently-sized asset just works. This used to be one hardcoded pixel
 * rect doing both jobs, before the hit region was traced into the SVG - now
 * that it is, there's no reason left for the two to be coupled.
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

/**
 * `FAVORITE_TOGGLE_PATH`'s own bounding box, in the same per-axis tile
 * fraction space - `tile_fav_toggle`'s bbox from `shelf_geometry.svg`,
 * imported by `import-shelf-svg.ts` alongside its outline. This is the tap
 * target's geometry (`favoriteHitRect`); the outline itself
 * (`FAVORITE_TOGGLE_POLYGON`) is only for the hover highlight, which can
 * afford to be exact where a tap needs the touch padding below. Null on a
 * trace with none, in which case the badge has no tap target of its own -
 * see `favoriteHitRect`.
 */
const FAVORITE_TOGGLE_BBOX: Rect | null = GEOMETRY.favoriteToggle?.bbox ?? null;

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
 * `iconSize` is the art's own decoded pixel size (see this file's doc
 * comment for why it isn't a constant here) - unrelated to
 * `FAVORITE_TOGGLE_BBOX`, which sizes the tap target instead.
 */
export function favoriteIconScreenRect(
  cellPx: { x: number; y: number },
  sx: number,
  sy: number,
  iconSize: { w: number; h: number }
): Rect {
  const scale = cellPx.x / BASE_TILE.w;
  const w = iconSize.w * scale;
  const h = iconSize.h * scale;
  return { x: sx + cellPx.x - w, y: sy, w, h };
}

/**
 * The favorites-sort switch's full screen rect on the CENTER tile, anchored
 * to its upper LEFT corner - the mirror of `favoriteIconScreenRect`'s upper
 * right, scaled by the same factor the tile itself is drawn at. `iconSize` is
 * the base plate's own decoded pixel size, same reasoning as
 * `favoriteIconScreenRect`'s. The switch's own hit regions are traced
 * separately (`center.ts`'s `CENTER_MINE_TOGGLE_RECT`/
 * `CENTER_COUNT_TOGGLE_RECT`/`CENTER_SHUFFLE_RECT`); this is only where the
 * art is drawn.
 */
export function favoriteSwitchScreenRect(
  cellPx: { x: number; y: number },
  sx: number,
  sy: number,
  iconSize: { w: number; h: number }
): Rect {
  const scale = cellPx.x / BASE_TILE.w;
  return { x: sx, y: sy, w: iconSize.w * scale, h: iconSize.h * scale };
}

/**
 * The badge's tap target: `FAVORITE_TOGGLE_BBOX` scaled per axis onto this
 * tile, then - for a coarse (touch) pointer only - grown to
 * `MIN_FAVORITE_HIT_TOUCH` on each axis (centered on the art's own bounds)
 * and capped so the result never exceeds `TOUCH_HIT_AREA_CAP` of the tile's
 * area. A mouse/trackpad gets the raw traced bounds back unchanged. Null when
 * the trace has no `tile_fav_toggle` bbox to size from - a badge with no
 * traced region is decoration only, the same "too small/untraced to fairly
 * hit" answer `center.ts`'s `controlUsable` gives its own traced controls.
 */
export function favoriteHitRect(
  cellPx: { x: number; y: number },
  sx: number,
  sy: number,
  touch: boolean
): Rect | null {
  if (!FAVORITE_TOGGLE_BBOX) return null;
  const rect: Rect = {
    x: sx + FAVORITE_TOGGLE_BBOX.x * cellPx.x,
    y: sy + FAVORITE_TOGGLE_BBOX.y * cellPx.y,
    w: FAVORITE_TOGGLE_BBOX.w * cellPx.x,
    h: FAVORITE_TOGGLE_BBOX.h * cellPx.y,
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
