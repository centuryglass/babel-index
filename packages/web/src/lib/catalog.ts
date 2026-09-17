/**
 * The catalog's arithmetic: which rooms are on a page, which pages are mounted,
 * how tall a row is, and which pyramid level a thumbnail should ask for.
 *
 * The pure half of the catalog, as `picking.ts` and `center.ts` are the pure
 * halves of their features: no DOM, no React, so what the list does is
 * assertable without a browser. `CatalogView.tsx` is the part that renders.
 *
 * ### Why the two paging modes are one primitive
 *
 * Pagination and infinite scroll differ in how many pages are mounted at once,
 * and nothing else: both slice `order` with `pageOf`, and `mountedPages`'s
 * `window` is where they part. AGENTS.md's "Pagination and infinite scroll are
 * one primitive with a different window" is why: two implementations would put
 * a room at two different positions depending on how the reader pages.
 *
 * ### Why rows are a fixed height
 *
 * A windowed list replaces unmounted pages with spacers, and a spacer's height
 * has to be the height the rows it stands in for would have occupied. An
 * estimate moves the scroll position every time a page recycles, under the
 * reader's hands; measuring instead would mean a real virtualiser and a
 * measurement cache.
 *
 * So a row's height is derived from whichever of its two columns needs more,
 * the content is cut to it, and what a row cannot show is counted rather
 * than dropped. The mechanics of the cut - a floated thumbnail the story wraps,
 * chips clamped by `chipLines`, a `+N` chip for the rest - are AGENTS.md's
 * "Rows are a fixed height and the spacers are arithmetic, not estimates" and
 * "What a row cannot show, it counts".
 */
import { BASE_TILE, idealLevel } from './pyramid.ts';

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
 * Rank is carried rather than recomputed by the caller: it is what names a room
 * (`describeRoom`) and what indexes the score breakdown, and a position in the
 * page is not a position in the ranking.
 *
 * The last page is short rather than padded, and a page past the end is empty
 * rather than an error - a corpus can shrink under a stored page number.
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
 * `window` pages either side, clamped to the ends, so scrolling mounts a band
 * around the active page and pagination mounts one page at `window: 0`. That is
 * the only difference between the two modes, which is why it is a parameter
 * rather than a branch.
 */
export function mountedPages(active: number, pages: number, window = 1): PageRange {
  const at = Math.min(Math.max(0, active), pages - 1);
  return {
    first: Math.max(0, at - window),
    last: Math.min(pages - 1, at + window),
  };
}

/**
 * How tall the spacer standing in for `pages` unmounted pages must be:
 * arithmetic, not an estimate. The last page is short, so a spacer that reaches
 * the end of the list counts the rows actually there rather than
 * `pages * perPage` of them.
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
 * How tall a thumbnail of this width is, derived from `BASE_TILE`'s aspect:
 * AGENTS.md's "Don't assume the tile aspect ratio". A literal here would silently
 * stop matching the art.
 */
export function tileHeight(thumbWidth: number): number {
  return Math.round(thumbWidth * (BASE_TILE.h / BASE_TILE.w));
}

/**
 * A row's height in the ultra-narrow layout, where the picture runs full width
 * beneath the name row rather than beside it - `CatalogView.tsx`'s
 * `ULTRA_NARROW_PX`. A wide row takes the max of two side-by-side columns; this
 * is a stack, so it is their sum. `headPx`/`detailsPx` are the rank/title/favorite
 * line and the "keywords & story" link that replaces the chips and story text an
 * ultra-narrow row has no room to show.
 *
 * @param thumbWidth css pixels, the full-bleed width - see `ultraThumbWidth`
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
 * Delegates to `pyramid.ts`'s `idealLevel`, the one place the ladder lives: a
 * second opinion about which level suits a given width is a second policy to
 * keep in step.
 *
 * No hysteresis, unlike the map. A thumbnail's width changes when the window is
 * resized, not continuously under a pinch, and passing a `current` level would
 * make the answer depend on history for no benefit.
 *
 * @param cssWidth the width the image is displayed at
 * @param dpr device pixel ratio, capped at 2 as both map renderers cap it
 * @returns a level, which `rooms.ts` may still resolve to null
 */
export function thumbLevel(cssWidth: number, dpr = 1): number {
  const drawn = Math.max(1, cssWidth) * Math.min(2, Math.max(1, dpr));
  return idealLevel({ w: drawn, h: drawn * (BASE_TILE.h / BASE_TILE.w) });
}

/**
 * Which page the reader is at, from how far they have scrolled.
 *
 * Fixed-height rows mean this is arithmetic rather than a set of observers
 * watching sentinels go by: the page under the top of the viewport is exactly
 * `scrollTop / (perPage * rowPx)`, once the lead - the center room's row, which
 * sits outside the paging - is taken off.
 *
 * @param opts.leadPx height of anything above the paged rows
 */
export function pageAtScroll(
  scrollTop: number,
  { perPage, rowPx, leadPx = 0 }: { perPage: number; rowPx: number; leadPx?: number },
): number {
  const per = Math.max(1, perPage * rowPx);
  return Math.max(0, Math.floor((scrollTop - leadPx) / per));
}

/**
 * How wide a window has to be for the rows on screen to all be mounted.
 *
 * The configured `windowPages` is a DOM budget, not a correctness guarantee: on
 * a tall display with a small `perPage`, a screenful can span more pages than
 * the window keeps live, and the reader would scroll into a spacer. So the view
 * takes whichever is larger, and this is the one place the two are compared.
 *
 * Pagination passes `viewportPx: 0`, which returns its configured window
 * untouched. That one is 0, so pagination mounts one page whatever the display
 * is doing.
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
 * `pageAtScroll`'s inverse, and arithmetic for the same reason: a row's top is
 * `leadPx + rank * rowPx` whatever page it falls on, since paging decides what
 * is mounted, not where anything sits. Centered rather than flush to the top so
 * a "jump to this room" lands where a reader is already looking.
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
 * The catalog's own default order: every room id, by title, or by filename for a
 * room with none.
 *
 * The map's idle order is a shuffle, because nobody can alphabetize a wall of
 * tiles by eye; a list is the shape an alphabetical order suits. So the two
 * views' idle orders are two orders, and agree only while a search is running,
 * when both use `result.order`.
 *
 * Plain string comparison, not `localeCompare`, to match `scan.ts`'s `.sort()` of
 * the same filenames: room ids are positions in that sorted list, so a second
 * ordering of one file list is a bug of its own.
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
 * A DOMRect in the shape the rest of this app uses.
 *
 * `getBoundingClientRect()` returns `width`/`height`; `Rect` here says `w`/`h`.
 * Convert at the boundary, because the mismatch does not throw: `to.w` on a
 * DOMRect is `undefined`, `undefined > 0` is false, and `flipTransform`'s
 * zero-size guard then returns a scale of 1 - an animation that translates
 * correctly and stops scaling without saying so.
 */
export function rectOf(domRect: { x: number; y: number; width: number; height: number }): Rect {
  return { x: domRect.x, y: domRect.y, w: domRect.width, h: domRect.height };
}

/**
 * The transform that puts `to` exactly where `from` is - the invert half of a
 * FLIP.
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
 * actually leaves over. A flat cap cannot work at an arbitrary width: on a narrow
 * display the thumbnail shrinks while the name row, the score strip and the story
 * minimum do not, so a cap sized for one layout either swallows a keyword in
 * another or leaves row height unspent.
 *
 * At least one line, because a clamp of zero hides a room's keywords outright
 * rather than shortening them. Whatever still does not fit is counted and offered
 * as a `+N` chip - see `CatalogView`'s `chipOverflow`, and `CHIP_LINE_PX` there
 * for the pixel cost of a line.
 *
 * The story is not clamped against this. It flows around the floated thumbnail
 * and is cut by the card's own height, which is the only way its lines can be
 * narrow beside the picture and full width beneath it.
 *
 * @param contentPx    the card's content box height
 * @param reservedPx   the name row, story minimum and score strip
 */
export function chipLines(contentPx: number, reservedPx: number, lineHeightPx: number): number {
  // A line height of 0 means nothing has been measured yet. Treating it as 1px
  // would return a clamp of a hundred lines, which is a wrong number rather than
  // an unclamped one; one line is what an unmeasured row can claim.
  if (!(lineHeightPx > 0)) return 1;
  return Math.max(1, Math.floor((contentPx - reservedPx) / lineHeightPx));
}
