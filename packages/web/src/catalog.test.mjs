import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pageOf,
  pageCount,
  mountedPages,
  spacerHeight,
  rowHeight,
  thumbLevel,
} from './catalog.js';
import { BASE_TILE, LEVELS, sizeOf } from './pyramid.js';

const order = Array.from({ length: 27 }, (_, i) => 100 + i);

test('a page carries each room with its rank in the whole ranking, not in the page', () => {
  const second = pageOf(order, 1, 10);
  assert.equal(second.length, 10);
  assert.deepEqual(second[0], { id: 110, rank: 10 });
  assert.deepEqual(second[9], { id: 119, rank: 19 });
});

test('the last page is short, and a page past the end is empty rather than an error', () => {
  assert.equal(pageOf(order, 2, 10).length, 7);
  assert.deepEqual(pageOf(order, 9, 10), []);
  // A corpus that shrank under a stored page number must not throw.
  assert.deepEqual(pageOf([], 3, 10), []);
});

test('every room appears exactly once across the pages, in rank order', () => {
  const pages = pageCount(order.length, 10);
  const seen = [];
  for (let p = 0; p < pages; p++) seen.push(...pageOf(order, p, 10));
  assert.deepEqual(seen.map((r) => r.id), order);
  assert.deepEqual(seen.map((r) => r.rank), order.map((_, i) => i));
});

test('an empty ranking is still one page, so the view has something to render', () => {
  assert.equal(pageCount(0, 20), 1);
  assert.deepEqual(mountedPages(0, 1, 1), { first: 0, last: 0 });
});

test('pagination and scrolling are the same slicing with a different window', () => {
  const pages = pageCount(order.length, 5); // 6 pages

  // Pagination: one page mounted, whichever one is active.
  assert.deepEqual(mountedPages(3, pages, 0), { first: 3, last: 3 });

  // Scrolling: a window either side, clamped at both ends.
  assert.deepEqual(mountedPages(3, pages, 1), { first: 2, last: 4 });
  assert.deepEqual(mountedPages(0, pages, 1), { first: 0, last: 1 });
  assert.deepEqual(mountedPages(5, pages, 1), { first: 4, last: 5 });

  // An active page outside the list is clamped rather than trusted.
  assert.deepEqual(mountedPages(99, pages, 1), { first: 4, last: 5 });
  assert.deepEqual(mountedPages(-4, pages, 1), { first: 0, last: 1 });
});

test('spacers stand for exactly the rows they replace, including a short last page', () => {
  const rowPx = 120;

  // Whole pages.
  assert.equal(spacerHeight(0, 1, 27, 10, rowPx), 20 * rowPx);

  // The last page holds 7 rooms, not 10 - a spacer of 10 would leave the list
  // taller than its contents and the scrollbar would never reach the end.
  assert.equal(spacerHeight(2, 2, 27, 10, rowPx), 7 * rowPx);

  // Nothing to stand for.
  assert.equal(spacerHeight(1, 0, 27, 10, rowPx), 0);
  assert.equal(spacerHeight(9, 12, 27, 10, rowPx), 0);
});

test('the mounted rows plus the spacers are exactly the whole list', () => {
  const perPage = 10;
  const rowPx = 120;
  const pages = pageCount(order.length, perPage);
  const { first, last } = mountedPages(1, pages, 1);

  let rows = 0;
  for (let p = first; p <= last; p++) rows += pageOf(order, p, perPage).length;
  const above = spacerHeight(0, first - 1, order.length, perPage, rowPx);
  const below = spacerHeight(last + 1, pages - 1, order.length, perPage, rowPx);

  // The invariant the sliding window rests on: recycling a page must not change
  // the list's total height, or the scroll position moves under the reader.
  assert.equal(rows * rowPx + above + below, order.length * rowPx);
});

test('a row is as tall as the tile is, whatever shape the tile becomes', () => {
  assert.equal(rowHeight(BASE_TILE.w), BASE_TILE.h);
  assert.equal(rowHeight(BASE_TILE.w, 24), BASE_TILE.h + 24);
  // Derived from the aspect, not from a 4:3 literal.
  assert.equal(rowHeight(320), Math.round(320 * (BASE_TILE.h / BASE_TILE.w)));
});

test('a thumbnail asks for a level that can actually cover it', () => {
  for (const cssWidth of [80, 160, 320, 640, 1024]) {
    for (const dpr of [1, 2, 3]) {
      const level = thumbLevel(cssWidth, dpr);
      assert.ok(
        LEVELS.some((l) => l.level === level),
        `level ${level} is on the ladder for ${cssWidth}@${dpr}`
      );
      const drawn = cssWidth * Math.min(2, dpr);
      // Either it covers the drawn width, or it is the finest rung there is -
      // asking for something off the top of the ladder is not an option.
      assert.ok(
        sizeOf(level).w >= drawn || level === 0,
        `level ${level} (${sizeOf(level).w}px) for a ${drawn}px draw`
      );
    }
  }
});

test('a smaller thumbnail asks for a coarser level, and dpr counts', () => {
  assert.ok(thumbLevel(120, 1) > thumbLevel(640, 1), 'small thumbs go coarser');
  assert.ok(thumbLevel(120, 2) <= thumbLevel(120, 1), 'a retina thumb needs at least as much');
  // The renderer caps dpr at 2; a 3x display must not ask for a finer rung than
  // a 2x one, or the catalog would out-demand the map on the same screen.
  assert.equal(thumbLevel(200, 3), thumbLevel(200, 2));
});
