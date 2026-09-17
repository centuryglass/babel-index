/**
 * The "forget searches" book's black spine overlay, anchored to the center
 * tile's lower right corner - the same corner `distillToggle.ts` uses.
 *
 * The art is a small image, mostly transparent around the one book spine it
 * paints black, authored so that pinning the image's corner to the tile's
 * corner lands the spine on that book. Where on the shelf the book sits is
 * carried by the art, not the code. Anchoring the image to the book's own
 * traced rect (`center.ts`'s `BOOK_RECTS[BOOK_COUNT - 1]`) would put the
 * image corner deep inside the shelf and shift the spine off the book.
 *
 * No DOM - the pure geometry half, split out the same way
 * `favoriteBadge.ts` and `distillToggle.ts` are. The overlay has no
 * hit-test of its own: the book underneath keeps its hit-test in
 * `center.ts`, unaffected by the overlay's presence or size. `iconSize` is
 * the art's decoded pixel size, read from the image at runtime (see
 * `render.ts`'s `drawClearHistoryBookOverlay`), not a constant.
 */
import { BASE_TILE } from './pyramid.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The overlay's full screen rect for a tile of `cellPx` whose top left
 * corner is at `(sx, sy)`, anchored to the tile's lower right corner.
 * `iconSize` is the art's decoded pixel size, scaled by a cell's
 * pixels-per-cell-width over `BASE_TILE.w` - the factor the tile itself is
 * drawn at; see `favoriteBadge.ts` for why one factor covers both axes.
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
