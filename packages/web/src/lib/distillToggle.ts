/**
 * The distill-mode toggle's hit-test: the control in the center tile's lower
 * right corner.
 *
 * Its art is the `distill-toggle` overlay (`tiles.ts`'s
 * `DISTILL_OFF`/`DISTILL_ON`), placed by `overlay.ts`'s `overlayScreenRect`
 * like every corner overlay.
 *
 * `distill_off`/`distill_on` in `shelf_geometry.svg` are each traced as
 * their own outline, one silhouette per state, in whole-tile fractions
 * (not the icon's own bounds) - the same "shape, not a box" treatment
 * `tile_fav_toggle` gets in `favoriteBadge.ts` - so a hover or click lands
 * on the active state's outline, not on a rectangle loose enough to also
 * catch the tile art around it.
 *
 * No DOM - this is the pure hit-test half, split out the same way
 * `favoriteBadge.ts` and `center.ts` are. The keyboard's way in is a DOM
 * button in `MapView.tsx`'s `.center-tile`, over the active state's
 * traced box.
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

/** The "enable distillation" icon's traced silhouette - null on a trace with none. */
export const DISTILL_OFF_PATH: string | null = GEOMETRY.distillOff?.d ?? null;
/** The "disable distillation" icon's traced silhouette - null on a trace with none. */
export const DISTILL_ON_PATH: string | null = GEOMETRY.distillOn?.d ?? null;

/**
 * Each state's traced bounding box, in whole-tile fractions - where
 * `MapView.tsx` places the toggle's DOM button for the keyboard and screen
 * readers. Null on a trace with none, like the paths.
 */
export const DISTILL_OFF_RECT: Rect | null = GEOMETRY.distillOff?.bbox ?? null;
export const DISTILL_ON_RECT: Rect | null = GEOMETRY.distillOn?.bbox ?? null;

/** `DISTILL_OFF_PATH`/`DISTILL_ON_PATH` flattened once at module load - see `FAVORITE_TOGGLE_POLYGON` for the same tradeoff. */
const DISTILL_OFF_POLYGON: Point[] | null = DISTILL_OFF_PATH ? flattenPath(DISTILL_OFF_PATH) : null;
const DISTILL_ON_POLYGON: Point[] | null = DISTILL_ON_PATH ? flattenPath(DISTILL_ON_PATH) : null;

/**
 * Whether a screen point lands on the active state's traced silhouette -
 * `distillMode` selects which of the two outlines is live, the same state
 * that picks which overlay PNG is drawn. Tests tile fractions against the
 * tile's own `cellPx`, so no native pixel size is needed. Used for both the
 * hover highlight and the click hit test.
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
