/**
 * The favorite badge's hit-test: the control in a room tile's upper right
 * corner.
 *
 * Its art is the `favorite-badge` overlay (`tiles.ts`'s `FAV_ON`/`FAV_OFF`),
 * placed by `overlay.ts`'s `overlayScreenRect` like every corner overlay.
 * The hit test works in traced tile fractions
 * (`FAVORITE_TOGGLE_BBOX`/`FAVORITE_TOGGLE_PATH`) and never reads the art's
 * size.
 *
 * No DOM - this is the pure hit-test half, split out the same way
 * `picking.ts` and `center.ts` are.
 */
import { layout } from '../../../../tools/center-placement/lib/geometry.ts';
import { flattenPath, pointInPolygon, type Point } from './svgPath.ts';

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
 * pixels and imported the same way `center.ts`'s `CENTER_BOOK_PATH` is:
 * the canonical M/L/C/Z grammar, every coordinate a fraction of the whole
 * tile (not of the badge icon), scaled per axis by the tile's `cellPx`
 * like every other traced rect. Null on a trace with none, in which case a
 * badge draws no hover highlight.
 */
export const FAVORITE_TOGGLE_PATH: string | null = GEOMETRY.favoriteToggle?.d ?? null;

/** `FAVORITE_TOGGLE_PATH` flattened into a polygon once at module load - see `CENTER_BOOK_POLYGON` in `center.ts` for the same tradeoff. */
const FAVORITE_TOGGLE_POLYGON: Point[] | null = FAVORITE_TOGGLE_PATH ? flattenPath(FAVORITE_TOGGLE_PATH) : null;

/**
 * `FAVORITE_TOGGLE_PATH`'s own bounding box, in the same per-axis tile
 * fraction space - `tile_fav_toggle`'s bbox from `shelf_geometry.svg`,
 * imported by `import-shelf-svg.ts` alongside its outline. This is the tap
 * target's geometry (`favoriteHitRect`); the outline itself
 * (`FAVORITE_TOGGLE_POLYGON`) is only for the hover highlight, which can be
 * exact where a tap needs the touch padding below. Null on a trace with
 * none, in which case the badge has no tap target - see `favoriteHitRect`.
 */
const FAVORITE_TOGGLE_BBOX: Rect | null = GEOMETRY.favoriteToggle?.bbox ?? null;

/**
 * Touch-only floor for the badge's tap target, on each axis - a coarse
 * pointer gets its hit rect padded up to at least this size (see
 * `favoriteHitRect`). Mouse/trackpad input is precise enough that the art's
 * own bounds are a fair target, so the floor does not apply there.
 */
export const MIN_FAVORITE_HIT_TOUCH = 20;

/**
 * The padded touch hit rect may never exceed this fraction of the tile's
 * own area - at extreme zoom-out, a tiny badge padded past this would cover
 * most of the tile and turn "tap the tile" into "tap the favorite button".
 */
const TOUCH_HIT_AREA_CAP = 0.1;

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
 * Whether a screen point lands on the favorite badge's traced silhouette,
 * not merely `favoriteHitRect`'s bounding box - the same "shape, not a box"
 * test `centerBookAtPoint` (`center.ts`) makes for the open book.
 * `cellPx`/`sx`/`sy` are the whole tile's own screen geometry (as `render.ts`
 * draws it), since `FAVORITE_TOGGLE_PATH` is traced against the whole tile,
 * not the badge icon alone. Hover highlight only: the tap hit test goes
 * through `favoriteHitRect`, whose box is more forgiving than this outline -
 * on touch, padded further still.
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
