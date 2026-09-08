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
 *
 * Unlike `FAV_ICON_SIZE`/`DISTILL_ICON_SIZE`, this overlay's native pixel
 * size is NOT hardcoded - it is read off the decoded art itself
 * (`render.ts`'s `drawClearHistoryBookOverlay` passes `hit.img`'s natural
 * width/height in). Those two are hardcoded because they also anchor a
 * hand-measured hit-test region (`FAV_ICON_HIT_BOUNDS`) that has to be
 * stated in the same units and can't itself be inferred, and because they
 * feed pointer hit-testing that runs every `pointermove` independent of
 * whether the cache has that image loaded yet - a size read off the decoded
 * bitmap would have nothing to report before it loads. This overlay has
 * neither constraint: it carries no hit-test of its own (the book underneath
 * still owns that, via `center.ts`), and it already draws nothing until
 * `cache.get` returns a loaded hit - so reading the real size at that same
 * moment costs nothing and means a differently-sized asset just works
 * instead of silently mis-anchoring until some constant is updated to match.
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
 * The overlay's full screen rect for a tile whose top left corner is at
 * `(sx, sy)` and whose width is `cellPx.x` - anchored to the "forget
 * searches" book's own bottom-right corner (not the whole tile's), scaled by
 * the same factor `render.ts` scales every corner overlay by: a cell's
 * pixels-per-cell-width divided by `BASE_TILE.w`. `iconSize` is the art's own
 * decoded pixel size (see this file's doc comment for why it isn't a
 * constant here). Null when the wall has no books at all (nothing to anchor
 * to).
 */
export function clearHistoryBookScreenRect(
  cellPx: { x: number; y: number },
  sx: number,
  sy: number,
  iconSize: { w: number; h: number }
): Rect | null {
  if (BOOK_COUNT === 0) return null;
  const book = BOOK_RECTS[BOOK_COUNT - 1];
  const scale = cellPx.x / BASE_TILE.w;
  const w = iconSize.w * scale;
  const h = iconSize.h * scale;
  return {
    x: sx + (book.x + book.w) * cellPx.x - w,
    y: sy + (book.y + book.h) * cellPx.y - h,
    w,
    h,
  };
}
