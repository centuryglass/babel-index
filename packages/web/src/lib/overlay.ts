/**
 * Where a corner overlay's art lands on screen: the one anchoring rule every
 * overlay in `manifest.overlays` (`packages/map/overlays.ts`) is placed by.
 *
 * The art's corner named by `anchor` is pinned to the same corner of the
 * tile, and the art is scaled by the factor the tile itself is drawn at:
 * the cell's css width over the reference width of the pyramid level the art
 * came from. One factor covers both axes because overlay art shares the
 * tile's aspect. Where on the tile the visible part of the art sits is
 * carried by the art's own transparent margin, not by code.
 *
 * Hit-testing never reads this. Each control's hit area is traced
 * separately (`favoriteBadge.ts`, `distillToggle.ts`, `center.ts`), so
 * replacement art of another size moves what is drawn but not what is
 * clickable.
 *
 * No DOM, like `favoriteBadge.ts` and `center.ts`.
 */
import type { Pyramid } from './pyramid.ts';
import type { OverlayAnchor } from '../../../map/overlays.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The overlay's screen rect on a tile whose top left corner is at `(sx, sy)`
 * and whose size is `cellPx`. `artSize` is the art's decoded pixel size and
 * `level` the rung of the collection's `pyramid` it came from.
 *
 * The scale denominator is that level's reference width, never the level-0
 * width: a `pyramid` overlay's coarser rung is already scaled down on disk to
 * match a tile drawn at that level, so dividing by the level-0 width would
 * shrink it twice.
 */
export function overlayScreenRect(
  anchor: OverlayAnchor,
  cellPx: { x: number; y: number },
  sx: number,
  sy: number,
  artSize: { w: number; h: number },
  pyramid: Pyramid,
  level = 0
): Rect {
  const scale = cellPx.x / (pyramid.sizeOf(level)?.w ?? pyramid.base.w);
  const w = artSize.w * scale;
  const h = artSize.h * scale;
  const x = anchor === 'top-right' || anchor === 'bottom-right' ? sx + cellPx.x - w : sx;
  const y = anchor === 'bottom-left' || anchor === 'bottom-right' ? sy + cellPx.y - h : sy;
  return { x, y, w, h };
}
