/**
 * The "forget searches" book's black spine overlay, anchored to that book's
 * own bottom-right corner within the center tile.
 *
 * Unlike `favoriteBadge.ts`/`distillToggle.ts`, which anchor to a whole TILE
 * corner, this anchors to one BOOK's corner - the bottom-right slot
 * `useCenterShelf.ts` reserves for "forget searches" (`center.ts`'s
 * `BOOK_RECTS[BOOK_COUNT - 1]`). Corner-anchored and mostly transparent
 * rather than stretched to fit that book's rect exactly, for the same reason
 * the favorite badge and distill toggle are: real art bleeds shading past a
 * silhouette's own outline into the surrounding surface, and fitting exactly
 * to a rect turns that bleed into a per-pixel alignment problem instead of a
 * non-issue the transparent margin absorbs for free.
 *
 * No DOM - this is the pure geometry half, split out the same way
 * `favoriteBadge.ts` and `distillToggle.ts` are.
 */
import { BOOK_RECTS, BOOK_COUNT } from './center.ts';
import { BASE_TILE } from './pyramid.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Placeholder native pixel size of `clear_history_book.png`, matching the
 * checked-in 1x1 placeholder's stand-in footprint - update this to the real
 * art's actual pixel dimensions once it replaces the placeholder (see
 * `render.ts`'s `drawClearHistoryBookOverlay`).
 */
export const CLEAR_HISTORY_ICON_SIZE = { w: 80, h: 200 };

/**
 * The overlay's full screen rect for a tile whose top left corner is at
 * `(sx, sy)` and whose width is `cellPx.x` - anchored to the "forget
 * searches" book's own bottom-right corner (not the whole tile's), scaled by
 * the same factor `render.ts` scales every corner overlay by: a cell's
 * pixels-per-cell-width divided by `BASE_TILE.w`. Null when the wall has no
 * books at all (nothing to anchor to).
 */
export function clearHistoryBookScreenRect(cellPx: { x: number; y: number }, sx: number, sy: number): Rect | null {
  if (BOOK_COUNT === 0) return null;
  const book = BOOK_RECTS[BOOK_COUNT - 1];
  const scale = cellPx.x / BASE_TILE.w;
  const w = CLEAR_HISTORY_ICON_SIZE.w * scale;
  const h = CLEAR_HISTORY_ICON_SIZE.h * scale;
  return {
    x: sx + (book.x + book.w) * cellPx.x - w,
    y: sy + (book.y + book.h) * cellPx.y - h,
    w,
    h,
  };
}
