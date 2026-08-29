/**
 * The catalog's arithmetic: which rooms are on a page, which pages are mounted,
 * how tall a row is, and which pyramid level a thumbnail should ask for.
 *
 * The pure half, exactly as `picking.js` and `center.js` are the pure halves of
 * their features - no DOM, no React, so what the list does is assertable without
 * a browser. `CatalogView` is the part that renders; everything it has to be
 * right about is here.
 *
 * ### Why the two paging modes are one primitive
 *
 * Pagination and infinite scroll differ in exactly one thing: how many pages are
 * mounted at once. Both slice `order` with `pageOf`; pagination mounts one page,
 * scrolling mounts a window of them. Writing them as two features would give the
 * catalog two ideas of where a room sits, and the first bug would be a room that
 * appears on page 4 scrolling and page 5 paginated.
 *
 * ### Why rows are a fixed height
 *
 * A windowed list replaces unmounted pages with spacers, and a spacer's height
 * has to be exactly what the rows it stands in for would have occupied. Guess it
 * and the scroll position jumps every time a page recycles - under the reader's
 * hands, mid-scroll. Measuring instead would mean a real virtualiser and a
 * measurement cache.
 *
 * So the row is a fixed height derived from the tile: the image is the tall
 * thing in it, the story beside it is clamped to fit, and the full story is one
 * click away in the room card that already exists. `spacerHeight` is then
 * arithmetic rather than an estimate, which is the property the whole approach
 * rests on.
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
 * Rank is carried rather than recomputed by the caller because it is what names
 * a room (`describeRoom`) and what indexes the score breakdown - and an
 * off-by-one between "position in this page" and "position in the ranking" is
 * exactly the kind of thing that reads as a plausible number and is wrong.
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
 * Which pages are mounted, given the one the reader is at.
 *
 * `window` pages either side, clamped to the ends - so scrolling mounts three
 * pages by default and pagination, at `window: 0`, mounts one. That is the only
 * difference between the two modes, and stating it as a parameter rather than a
 * branch is what stops them drifting apart.
 *
 * Inclusive.
 */
export function mountedPages(active: number, pages: number, window = 1): PageRange {
  const at = Math.min(Math.max(0, active), pages - 1);
  return {
    first: Math.max(0, at - window),
    last: Math.min(pages - 1, at + window),
  };
}

/**
 * How tall the spacer standing in for `pages` unmounted pages must be.
 *
 * Exact, not estimated - see the header. The last page is short, so a spacer
 * that reaches the end of the list has to count the rows that are actually
 * there rather than `pages * perPage` of them.
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
 * How tall a thumbnail of this width is.
 *
 * Derived from `BASE_TILE`'s aspect rather than stated, for the same reason
 * every other size in this app is: the tile is 1024x768 today and the shape is
 * not settled, and a literal here would silently stop matching the art.
 */
export function tileHeight(thumbWidth: number): number {
  return Math.round(thumbWidth * (BASE_TILE.h / BASE_TILE.w));
}

/**
 * A row's height: whichever of its two columns needs more, plus padding.
 *
 * The tile is usually the tall one, which is why this looks like it could just
 * be the tile's height - but on a narrow display the thumbnail shrinks while
 * the story, the chips and the score strip beside it do not, and a row sized to
 * the tile alone clips them. Found by measuring a row against its own
 * scrollHeight rather than by looking at it, which is the only way this kind of
 * thing gets found.
 *
 * Uniform across a page either way, which is all the spacer arithmetic needs -
 * `textMin` changes when a search starts and ends, and every row changes with
 * it together.
 *
 * @param thumbWidth css pixels
 * @param padding the row's vertical padding, both halves
 * @param textMin what the text column needs at minimum
 */
export function rowHeight(thumbWidth: number, padding = 0, textMin = 0): number {
  return Math.max(tileHeight(thumbWidth), Math.round(textMin)) + padding;
}

/**
 * Which pyramid level a thumbnail of this width should ask for.
 *
 * Delegates to the pyramid's own policy rather than restating a ladder here -
 * `pyramid.js` is the one place any of those numbers live, and a second opinion
 * about which level suits a given width is a second policy to keep in step.
 *
 * No hysteresis, unlike the map: a thumbnail's width changes when the window is
 * resized, not sixty times a second under a pinch, so there is nothing to
 * damp - and passing a `current` level would make the answer depend on history
 * for no benefit.
 *
 * @param cssWidth the width the image is displayed at
 * @param dpr device pixel ratio, capped as the renderer caps it
 * @returns a level, which `rooms.js` may still resolve to null
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
 * takes whichever is larger. This is the one place that comparison is made, so
 * it cannot be made differently in two paging modes.
 *
 * Pagination passes `viewportPx: 0`, which leaves its window at 0 - one page,
 * as it must be, whatever the display is doing.
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
 * The catalog's own default order: every room id, by filename.
 *
 * The map's idle order is a shuffle - there is no "index order" worth reading
 * on a wall of tiles nobody can alphabetize by eye. A LIST is exactly the
 * thing alphabetical order suits, so the two views' idle orders are not the
 * same array read two ways, they are two different orders that happen to
 * agree only while a search is running (`result.order` is both). Plain
 * string comparison, not `localeCompare`, to match `scan.mjs`'s own
 * `.sort()` of the same filenames - two different orderings of one file list
 * would be its own bug.
 *
 * @param rooms manifest.rooms, indexed by id
 * @returns room ids
 */
export function alphabeticalOrder(rooms: { file: string }[]): number[] {
  return rooms
    .map((room, id) => id)
    .sort((a, b) => {
      const fa = rooms[a].file;
      const fb = rooms[b].file;
      return fa < fb ? -1 : fa > fb ? 1 : 0;
    });
}

/**
 * A DOMRect in the shape the rest of this app uses.
 *
 * `getBoundingClientRect()` returns `width`/`height`; `centerCellRect` and
 * everything else here says `w`/`h`. Converting at the boundary rather than
 * teaching `flipTransform` two shapes is what keeps ONE rect shape inside the
 * module - and this function exists at all because the mismatch does not throw:
 * `to.w` on a DOMRect is `undefined`, `undefined > 0` is false, and the
 * zero-size guard below then returns a scale of 1. The animation still ran, and
 * still translated correctly, so it looked like a working transition that had
 * simply forgotten to scale. Found by logging the numbers, not by watching it.
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
 * Pure because the arithmetic is the part worth being sure about: a sign error
 * here throws the animation off screen, and that is not something to discover
 * by watching it.
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
 * How many lines of story a row has room for.
 *
 * The clamp was two lines flat, which on a wide display cut a story off with
 * forty visible pixels of nothing under it - the tile is the tall column and
 * the text rarely fills it. So the clamp is derived from what is actually
 * left: the row's height, less everything above and below the story, divided
 * by a line.
 *
 * At least one line, because a clamp of zero hides the story completely rather
 * than shortening it - and on a display narrow enough to leave no room, one
 * clipped line is still the honest answer.
 *
 * @param rowPx        the row's height
 * @param reservedPx   the name row, chips, score strip and padding
 */
export function storyLines(rowPx: number, reservedPx: number, lineHeightPx: number): number {
  // A line height of zero means nothing has been measured yet, and dividing by
  // the 1px floor a `Math.max` would give returns a clamp of a hundred lines -
  // which is not "unclamped", it is a wrong number that happens to look
  // harmless. One line is the honest answer to "I cannot tell yet".
  if (!(lineHeightPx > 0)) return 1;
  return Math.max(1, Math.floor((rowPx - reservedPx) / lineHeightPx));
}
