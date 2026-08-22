/**
 * The catalog's arithmetic: which rooms are on a page, which pages are mounted,
 * how tall a row is, and which pyramid level a thumbnail should ask for.
 *
 * The pure half, exactly as `picking.js` and `centre.js` are the pure halves of
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
import { BASE_TILE, idealLevel } from './pyramid.js';

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
 * @param {number[]} order room ids, best first
 * @param {number} page 0-based
 * @param {number} perPage
 * @returns {{id: number, rank: number}[]}
 */
export function pageOf(order, page, perPage) {
  const start = Math.max(0, page) * perPage;
  const end = Math.min(order.length, start + perPage);
  const out = [];
  for (let rank = start; rank < end; rank++) out.push({ id: order[rank], rank });
  return out;
}

/** How many pages a ranking of `total` rooms takes. At least one, even empty. */
export function pageCount(total, perPage) {
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
 * @returns {{first: number, last: number}} inclusive
 */
export function mountedPages(active, pages, window = 1) {
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
 * @param {number} from first unmounted page, inclusive
 * @param {number} to last unmounted page, inclusive
 * @param {number} total rooms in the whole list
 * @param {number} perPage
 * @param {number} rowPx height of one row
 */
export function spacerHeight(from, to, total, perPage, rowPx) {
  if (to < from) return 0;
  const start = Math.min(total, from * perPage);
  const end = Math.min(total, (to + 1) * perPage);
  return Math.max(0, end - start) * rowPx;
}

/**
 * A row's height, from the width its thumbnail is given.
 *
 * Derived from `BASE_TILE`'s aspect rather than stated, for the same reason
 * every other size in this app is: the tile is 1024x768 today and the shape is
 * not settled, and a literal here would silently stop matching the art.
 *
 * @param {number} thumbWidth css pixels
 * @param {number} [padding] the row's vertical padding, both halves
 */
export function rowHeight(thumbWidth, padding = 0) {
  return Math.round(thumbWidth * (BASE_TILE.h / BASE_TILE.w)) + padding;
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
 * @param {number} cssWidth the width the image is displayed at
 * @param {number} [dpr] device pixel ratio, capped as the renderer caps it
 * @returns {number} a level, which `rooms.js` may still resolve to null
 */
export function thumbLevel(cssWidth, dpr = 1) {
  const drawn = Math.max(1, cssWidth) * Math.min(2, Math.max(1, dpr));
  return idealLevel({ w: drawn, h: drawn * (BASE_TILE.h / BASE_TILE.w) });
}
