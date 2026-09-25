/**
 * The favorite badge painted into a tile's upper right corner.
 *
 * `assets/fav_on.png`/`fav_off.png` are fixed, checked-in art that
 * integrates with any tile: anchored to the tile's top right corner and
 * scaled by a cell's pixels-per-cell-width over the reference width the
 * loaded art was itself scaled to match - the same factor `render.ts`/
 * `slide.ts` draw the tile itself at, and the one factor covers both axes
 * because both assets share the tile's aspect. The badge has a pyramid
 * (`manifest.shared.favoriteLevels`), so the scale denominator is
 * not a flat `BASE_TILE.w` - `favoriteIconScreenRect` is the one home for that
 * rule and the double-shrink it prevents.
 *
 * Hit-testing and drawing read different size sources: the hit test works
 * in traced tile fractions (`FAVORITE_TOGGLE_BBOX`/`FAVORITE_TOGGLE_PATH`)
 * and needs no native pixel size, while the drawn icon is placed from the
 * decoded art's pixels - see `favoriteIconScreenRect`.
 *
 * No DOM - this is the pure geometry/hit-test half, split out the same way
 * `picking.ts` and `center.ts` are.
 */
import { layout } from '../../../../tools/center-placement/lib/geometry.ts';
import { flattenPath, pointInPolygon, type Point } from './svgPath.ts';
import { BASE_TILE, sizeOf as pyramidSizeOf } from './pyramid.ts';

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
 * The badge's full screen rect for a tile whose top left corner is at
 * `(sx, sy)` and whose width is `cellPx.x`, anchored to the tile's upper
 * right corner and scaled by the same factor the tile itself is drawn at.
 * `iconSize` is the decoded art's pixel size, read by `render.ts`'s
 * `drawFavoriteBadge` once the tile cache reports it loaded - unrelated to
 * `FAVORITE_TOGGLE_BBOX`, which sizes the tap target instead.
 *
 * `level` is which pyramid rung `iconSize` came from - the badge's
 * pyramid (`manifest.shared.favoriteLevels`), not necessarily the room
 * tile's. The scale factor is `cellPx.x` over that level's reference
 * width (`pyramid.sizeOf(level).w`), never a flat `BASE_TILE.w`: a coarser
 * rung's art is already scaled down on disk to match a tile drawn at that
 * level's width, so dividing it by the full-size level-0 width would shrink
 * it twice. Level 0's reference width is `BASE_TILE.w`, so level 0 is
 * unchanged.
 */
export function favoriteIconScreenRect(
  cellPx: { x: number; y: number },
  sx: number,
  sy: number,
  iconSize: { w: number; h: number },
  level = 0
): Rect {
  const scale = cellPx.x / (pyramidSizeOf(level)?.w ?? BASE_TILE.w);
  const w = iconSize.w * scale;
  const h = iconSize.h * scale;
  return { x: sx + cellPx.x - w, y: sy, w, h };
}

/**
 * The favorites-sort switch's full screen rect on the center tile, anchored
 * to its upper left corner - the mirror of `favoriteIconScreenRect`'s upper
 * right - and scaled by the same factor the tile itself is drawn at.
 * `iconSize` is the base plate's own decoded pixel size, read like
 * `favoriteIconScreenRect`'s. The switch's hit regions are traced
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
