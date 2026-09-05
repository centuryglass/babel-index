/**
 * The distill-mode toggle painted into the center tile's lower right corner.
 *
 * `assets/distill_on.png`/`distill_off.png` are fixed, checked-in art, designed
 * to anchor to the tile's BOTTOM right corner - the favorite badge's mirror
 * corner (`favoriteBadge.ts` anchors to the top right) - scaled by the same
 * factor `render.ts`/`slide.ts` scale every corner overlay by: a cell's
 * pixels-per-cell-width divided by `BASE_TILE.w`.
 *
 * `distill_off`/`distill_on` in `shelf_geometry.svg` are each traced as their
 * own outline over the WHOLE tile (not the icon's own bounds) - one
 * silhouette per state, the same "shape, not a box" treatment
 * `tile_fav_toggle` gets in `favoriteBadge.ts` - so hovering or clicking the
 * CURRENT state's icon tracks its outline exactly, not a rectangle loose
 * enough to also catch the tile art around it.
 *
 * No DOM - this is the pure geometry/hit-test half, split out the same way
 * `favoriteBadge.ts` and `center.ts` are.
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

/** The "enable distillation" icon's traced silhouette - null on a trace with none. */
export const DISTILL_OFF_PATH: string | null = GEOMETRY.distillOff?.d ?? null;
/** The "disable distillation" icon's traced silhouette - null on a trace with none. */
export const DISTILL_ON_PATH: string | null = GEOMETRY.distillOn?.d ?? null;

/** `DISTILL_OFF_PATH`/`DISTILL_ON_PATH` flattened once at module load - see `FAVORITE_TOGGLE_POLYGON` for the same tradeoff. */
const DISTILL_OFF_POLYGON: Point[] | null = DISTILL_OFF_PATH ? flattenPath(DISTILL_OFF_PATH) : null;
const DISTILL_ON_POLYGON: Point[] | null = DISTILL_ON_PATH ? flattenPath(DISTILL_ON_PATH) : null;

/** The native pixel size of distill_on.png/distill_off.png. */
export const DISTILL_ICON_SIZE = { w: 283, h: 206 };

/**
 * The toggle's full screen rect for a tile whose top left corner is at
 * `(sx, sy)` and whose width is `cellPx.x` - anchored to the tile's LOWER
 * right corner, scaled by the same factor the tile itself is drawn at.
 */
export function distillIconScreenRect(cellPx: { x: number; y: number }, sx: number, sy: number): Rect {
  const scale = cellPx.x / BASE_TILE.w;
  const w = DISTILL_ICON_SIZE.w * scale;
  const h = DISTILL_ICON_SIZE.h * scale;
  return { x: sx + cellPx.x - w, y: sy + cellPx.y - h, w, h };
}

/**
 * Whether a screen point lands on the CURRENTLY ACTIVE state's traced
 * silhouette - `distillMode` selects which of the two outlines is live, the
 * same state that picks which overlay PNG is drawn. Used for both the hover
 * highlight and the click hit test.
 */
export function distillToggleAtPoint(
  px: number,
  py: number,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number,
  distillMode: boolean
): boolean {
  const polygon = distillMode ? DISTILL_ON_POLYGON : DISTILL_OFF_POLYGON;
  if (!polygon) return false;
  return pointInPolygon((px - sx) / cellPx.x, (py - sy) / cellPx.y, polygon);
}
