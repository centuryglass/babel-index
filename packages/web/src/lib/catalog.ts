/**
 * The catalog's arithmetic: which rooms are on a page, which pages are mounted,
 * how tall a spacer or row is, where to scroll, and which pyramid level a
 * thumbnail asks for. Pure (no DOM, no React), so the list's behavior is
 * tested without a browser; `CatalogView.tsx` renders it.
 *
 * Two rules from AGENTS.md shape it:
 * - Pagination and infinite scroll both slice `order` with `pageOf` and differ
 *   only in `mountedPages`'s `window` ("Pagination and infinite scroll are one
 *   primitive with a different window").
 * - Every paged row is one fixed height, so a spacer's height and the page at
 *   a scroll offset are exact arithmetic ("Rows are a fixed height and the
 *   spacers are arithmetic, not estimates").
 */
import { BASE_TILE, idealLevel, DPR_CAP } from './pyramid.ts';

export interface RankedRoom {
  id: number;
  rank: number;
}

export interface PageRange {
  first: number;
  last: number;
}

/** A rect in this module's shape: `w`/`h`, not a DOMRect's `width`/`height`. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlipTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

/**
 * The rooms on one page, as `{ id, rank }` pairs.
 *
 * `rank` is the position in the whole ranking, not in the page. It names a room
 * (`describeRoom`) and indexes the score breakdown.
 *
 * The last page is short, not padded. A page past the end is empty, not an
 * error, since a corpus can shrink under a stored page number.
 *
 * @param order room ids, best first
 * @param page 0-based
 */
export function pageOf(order: number[], page: number, perPage: number): RankedRoom[] {
  const start = Math.max(0, page) * perPage;
  const end = Math.min(order.length, start + perPage);
  const out: RankedRoom[] = [];
  for (let rank = start; rank < end; rank++) out.push({ id: order[rank], rank });
  return out;
}

/** How many pages a ranking of `total` rooms takes. At least one, even empty. */
export function pageCount(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / perPage));
}

/**
 * Which pages are mounted, given the one the reader is at. Inclusive.
 *
 * `window` pages either side, clamped to the ends. Scrolling mounts a band
 * around the active page; pagination passes `window: 0` and mounts one.
 */
export function mountedPages(active: number, pages: number, window = 1): PageRange {
  const at = Math.min(Math.max(0, active), pages - 1);
  return {
    first: Math.max(0, at - window),
    last: Math.min(pages - 1, at + window),
  };
}

/**
 * The height of the spacer standing in for unmounted pages `from`..`to`.
 * It counts the rows actually there, so a spacer reaching the short last page
 * is not `pages * perPage` rows tall.
 *
 * @param from first unmounted page, inclusive
 * @param to last unmounted page, inclusive
 * @param total rooms in the whole list
 * @param rowPx height of one row
 */
export function spacerHeight(
  from: number,
  to: number,
  total: number,
  perPage: number,
  rowPx: number,
): number {
  if (to < from) return 0;
  const start = Math.min(total, from * perPage);
  const end = Math.min(total, (to + 1) * perPage);
  return Math.max(0, end - start) * rowPx;
}

/**
 * How tall a thumbnail of this width is, from `BASE_TILE`'s aspect (AGENTS.md,
 * "Don't assume the tile aspect ratio; read it from `BASE_TILE`").
 */
export function tileHeight(thumbWidth: number): number {
  return Math.round(thumbWidth * (BASE_TILE.h / BASE_TILE.w));
}

/**
 * A row's height in the ultra-narrow layout (`CatalogView.tsx`'s
 * `ULTRA_NARROW_PX`): a stack, so the sum of its parts, where a wider row
 * takes the taller of two side-by-side columns.
 *
 * @param thumbWidth css pixels, the full-bleed width - see `ultraThumbWidth`
 * @param headPx the rank/title/favorite line
 * @param detailsPx the "keywords & story" link that stands in for the chips and story
 * @param padding the row's vertical padding, both halves
 * @param matPad the thumbnail's paper mat, one side
 * @param gap the space between the picture and the "keywords & story" link
 */
export function stackedRowHeight(
  thumbWidth: number,
  headPx: number,
  detailsPx: number,
  padding = 0,
  matPad = 0,
  gap = 0,
): number {
  return tileHeight(thumbWidth) + 2 * matPad + headPx + detailsPx + padding + gap;
}

/**
 * Which pyramid level a thumbnail of this width should ask for.
 *
 * Delegates to `pyramid.ts`'s `idealLevel`, the one place the ladder lives.
 *
 * No hysteresis, unlike the map: a thumbnail's width changes only on a resize,
 * not continuously under a pinch, so the answer need not depend on the current
 * level.
 *
 * @param cssWidth the width the image is displayed at
 * @param dpr device pixel ratio, capped at `DPR_CAP` as both map renderers cap it
 * @returns a level, which `rooms.ts` may still resolve to null
 */
export function thumbLevel(cssWidth: number, dpr = 1): number {
  const drawn = Math.max(1, cssWidth) * Math.min(DPR_CAP, Math.max(1, dpr));
  return idealLevel({ w: drawn, h: drawn * (BASE_TILE.h / BASE_TILE.w) });
}

/**
 * Which page the reader is at, from how far they have scrolled.
 *
 * Rows are a fixed height, so the page under the top of the viewport is
 * `(scrollTop - leadPx) / (perPage * rowPx)`, floored.
 *
 * @param opts.leadPx height of anything above the paged rows (the center room's row)
 */
export function pageAtScroll(
  scrollTop: number,
  { perPage, rowPx, leadPx = 0 }: { perPage: number; rowPx: number; leadPx?: number },
): number {
  const per = Math.max(1, perPage * rowPx);
  return Math.max(0, Math.floor((scrollTop - leadPx) / per));
}

/**
 * The mount window: the larger of the configured one and what a screenful of
 * rows spans.
 *
 * The configured `windowPages` is a DOM budget. On a tall display with a small
 * `perPage`, a screenful can span more pages than it keeps mounted, and the
 * reader would scroll into a spacer.
 *
 * `viewportPx: 0` returns `configured` untouched. Pagination passes 0 for
 * both, so it always mounts one page.
 */
export function windowFor(
  configured: number,
  { viewportPx, perPage, rowPx }: { viewportPx: number; perPage: number; rowPx: number },
): number {
  if (!viewportPx) return configured;
  const needed = Math.ceil(viewportPx / Math.max(1, perPage * rowPx));
  return Math.max(configured, needed);
}

/**
 * Where to scroll so a given rank's row lands centered in the viewport.
 *
 * `pageAtScroll`'s inverse: a row's top is `leadPx + rank * rowPx` on any
 * page, since paging decides what is mounted, not where it sits.
 *
 * Clamped to 0. A rank near the top would otherwise ask for negative scroll,
 * which a browser clamps by rubber-banding; that scroll event fed back into
 * `pageAtScroll` would read as page 0 for the wrong reason.
 */
export function focusScrollTop(
  rank: number,
  { rowPx, leadPx, viewportPx }: { rowPx: number; leadPx: number; viewportPx: number },
): number {
  const rowTop = leadPx + rank * rowPx;
  return Math.max(0, rowTop - Math.max(0, (viewportPx - rowPx) / 2));
}

/**
 * The catalog's order at rest: every room id, by title, or by filename for a
 * room with none.
 *
 * The map's order at rest is a shuffle, so the two views agree only while a
 * search runs and both use `result.order`.
 *
 * Plain string comparison, not `localeCompare`, to match `scan.ts`'s `.sort()`
 * of the same filenames, which assigns room ids. A second collation of one
 * file list is a bug.
 *
 * @param rooms manifest.rooms, indexed by id
 * @param metadata indexed by room id, as `joinMetadata()` returns; a room
 *   with no entry or no title sorts by its filename instead
 * @returns room ids
 */
export function alphabeticalOrder(
  rooms: { file: string }[],
  metadata?: (import('../../../map/metadata.ts').RoomMeta | null)[] | null
): number[] {
  const keyOf = (id: number) => metadata?.[id]?.title || rooms[id].file;
  return rooms
    .map((room, id) => id)
    .sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

/**
 * A DOMRect converted to `Rect`'s `w`/`h` shape.
 *
 * Convert at the boundary, because passing a DOMRect does not throw: `to.w` is
 * `undefined`, `undefined > 0` is false, and `flipTransform`'s zero-size guard
 * returns a scale of 1. The animation then translates but silently never
 * scales.
 */
export function rectOf(domRect: { x: number; y: number; width: number; height: number }): Rect {
  return { x: domRect.x, y: domRect.y, w: domRect.width, h: domRect.height };
}

/**
 * The transform that puts `to` where `from` is: the invert half of a FLIP.
 *
 * Entering the catalog, `from` is the center tile's rect on the map and `to` is
 * where the first row's thumbnail has landed; the row starts transformed onto
 * the tile and animates to nothing, so the map appears to fold into the list.
 * Leaving, the two swap.
 *
 * Assumes `transform-origin: 0 0`, so the scale does not also move the corner.
 */
export function flipTransform(from: Rect, to: Rect): FlipTransform {
  return {
    x: from.x - to.x,
    y: from.y - to.y,
    scaleX: to.w > 0 ? from.w / to.w : 1,
    scaleY: to.h > 0 ? from.h / to.h : 1,
  };
}

/** `flipTransform` as a css transform string. */
export function flipCss(t: FlipTransform): string {
  return `translate(${t.x}px, ${t.y}px) scale(${t.scaleX}, ${t.scaleY})`;
}

/**
 * How many lines of keyword chips a row has room for, from the height the row
 * leaves over. A flat line count cannot fit every width: on a narrow display the
 * thumbnail shrinks while the name row and story minimum do not.
 *
 * At least one line, because zero would hide a room's keywords outright. Chips
 * that still do not fit are counted and shown as a `+N` chip (AGENTS.md, "What
 * a row cannot show, it counts"). `CatalogView.tsx`'s `CHIP_LINE_PX` is the
 * pixel cost of a line.
 *
 * @param contentPx    the height available to chips and text (`CatalogView`'s flow area)
 * @param reservedPx   the name row, button and one story line
 */
export function chipLines(contentPx: number, reservedPx: number, lineHeightPx: number): number {
  // A line height of 0 (or NaN) means nothing is measured yet, and one line
  // is what an unmeasured row can claim.
  if (!(lineHeightPx > 0)) return 1;
  return Math.max(1, Math.floor((contentPx - reservedPx) / lineHeightPx));
}
