/**
 * The "forget searches" book's black spine overlay, anchored to the center
 * tile's own bottom-right corner - the same corner `distillToggle.ts`
 * anchors to, and for the same reason: the art is authored with a
 * mostly-transparent margin around the one book it actually paints black, so
 * anchoring the whole image to a fixed tile corner lands that book exactly
 * without the code needing to know where on the shelf it sits. An earlier
 * version of this file anchored to the "forget searches" book's own traced
 * bounding box instead (`center.ts`'s `BOOK_RECTS[BOOK_COUNT - 1]`) - that
 * put the corner deep inside the shelf rather than at the tile's edge, which
 * is why the real art rendered far up and to the left of where it belonged
 * once it replaced the placeholder.
 *
 * No DOM - this is the pure geometry half, split out the same way
 * `favoriteBadge.ts` and `distillToggle.ts` are.
 *
 * Unlike `distillIconScreenRect`'s two states, this overlay has no traced
 * hit-test region of its own to keep independent of its size - the book
 * underneath still owns its hit-test (`center.ts`), unaffected by this
 * overlay's presence. Its native pixel size is read off the decoded art
 * itself (`render.ts`'s `drawClearHistoryBookOverlay` passes `hit.img`'s
 * natural width/height in) rather than hardcoded, exactly as
 * `distillIconScreenRect`'s is.
 */
import { BASE_TILE } from './pyramid.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The overlay's full screen rect for a tile whose top left corner is at
 * `(sx, sy)` and whose width is `cellPx.x` - anchored to the tile's LOWER
 * right corner, scaled by the same factor `render.ts` scales every corner
 * overlay by: a cell's pixels-per-cell-width divided by `BASE_TILE.w`.
 * `iconSize` is the art's own decoded pixel size (see this file's doc
 * comment for why it isn't a constant here).
 */
export function clearHistoryBookScreenRect(
  cellPx: { x: number; y: number },
  sx: number,
  sy: number,
  iconSize: { w: number; h: number }
): Rect {
  const scale = cellPx.x / BASE_TILE.w;
  const w = iconSize.w * scale;
  const h = iconSize.h * scale;
  return { x: sx + cellPx.x - w, y: sy + cellPx.y - h, w, h };
}
