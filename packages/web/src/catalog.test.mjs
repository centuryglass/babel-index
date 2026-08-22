import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pageOf,
  pageCount,
  mountedPages,
  spacerHeight,
  rowHeight,
  tileHeight,
  thumbLevel,
  pageAtScroll,
  windowFor,
  flipTransform,
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
  assert.equal(tileHeight(BASE_TILE.w), BASE_TILE.h);
  assert.equal(rowHeight(BASE_TILE.w), BASE_TILE.h);
  assert.equal(rowHeight(BASE_TILE.w, 24), BASE_TILE.h + 24);
  // Derived from the aspect, not from a 4:3 literal.
  assert.equal(rowHeight(320), Math.round(320 * (BASE_TILE.h / BASE_TILE.w)));
});

test('a row never gets shorter than the column of text beside the tile', () => {
  // The tile is usually the tall one...
  assert.equal(rowHeight(320, 0, 100), tileHeight(320));
  // ...but on a narrow display it shrinks and the story does not, and a row
  // sized to the tile alone clips it.
  assert.equal(rowHeight(120, 0, 160), 160);
  assert.equal(rowHeight(120, 22, 160), 182);
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

test('the page under the viewport comes from arithmetic, not from sentinels', () => {
  const geom = { perPage: 10, rowPx: 100, leadPx: 100 }; // a 1000px page, after the centre row

  assert.equal(pageAtScroll(0, geom), 0);
  assert.equal(pageAtScroll(99, geom), 0, 'still inside the lead row');
  assert.equal(pageAtScroll(100, geom), 0, 'the first paged row');
  assert.equal(pageAtScroll(1099, geom), 0);
  assert.equal(pageAtScroll(1100, geom), 1);
  assert.equal(pageAtScroll(5100, geom), 5);

  // Scrolled above the top (rubber-banding on a trackpad) is page 0, not -1.
  assert.equal(pageAtScroll(-400, geom), 0);
});

test('the mounted window grows to cover a screenful, so a reader cannot scroll into a spacer', () => {
  const perPage = 10;
  const rowPx = 100; // a page is 1000px tall

  // A short viewport needs no more than the configured window.
  assert.equal(windowFor(1, { viewportPx: 600, perPage, rowPx }), 1);

  // A viewport taller than the window would otherwise reach unmounted pages.
  assert.equal(windowFor(1, { viewportPx: 2400, perPage, rowPx }), 3);

  // Pagination mounts exactly one page whatever the display is doing.
  assert.equal(windowFor(0, { viewportPx: 0, perPage, rowPx }), 0);
});

test('a scroll position always lands inside the pages the window mounted', () => {
  const perPage = 10;
  const rowPx = 100;
  const total = 250;
  const pages = pageCount(total, perPage);
  const viewportPx = 2400;
  const w = windowFor(1, { viewportPx, perPage, rowPx });

  // The property the two functions exist to hold together: everything visible
  // from any scroll position is inside the mounted range.
  for (let scrollTop = 0; scrollTop < total * rowPx; scrollTop += 137) {
    const active = pageAtScroll(scrollTop, { perPage, rowPx });
    const { first, last } = mountedPages(active, pages, w);
    const lastVisibleRow = Math.min(total - 1, Math.floor((scrollTop + viewportPx) / rowPx));
    const lastVisiblePage = Math.floor(lastVisibleRow / perPage);
    assert.ok(
      first <= active && lastVisiblePage <= last,
      `scrollTop ${scrollTop}: visible pages ${active}-${lastVisiblePage}, mounted ${first}-${last}`
    );
  }
});

test('the flip transform puts the destination exactly where the source was', () => {
  const from = { x: 400, y: 120, w: 600, h: 450 };
  const to = { x: 24, y: 200, w: 200, h: 150 };
  const t = flipTransform(from, to);

  // Applying it to `to` (transform-origin 0 0) must reproduce `from` exactly,
  // or the animation starts somewhere other than where the reader was looking.
  assert.equal(to.x + t.x, from.x);
  assert.equal(to.y + t.y, from.y);
  assert.equal(to.w * t.scaleX, from.w);
  assert.equal(to.h * t.scaleY, from.h);
});

test('the flip is its own inverse, so entering and leaving cannot disagree', () => {
  const a = { x: 400, y: 120, w: 600, h: 450 };
  const b = { x: 24, y: 200, w: 200, h: 150 };
  const there = flipTransform(a, b);
  const back = flipTransform(b, a);
  assert.equal(there.scaleX * back.scaleX, 1);
  assert.equal(there.x, -back.x);
});

test('a zero-sized destination does not produce a divide by zero', () => {
  // A thumbnail measured before layout has settled is 0x0; the animation should
  // be a no-op scale rather than Infinity, which would blank the page.
  const t = flipTransform({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 0 });
  assert.equal(t.scaleX, 1);
  assert.equal(t.scaleY, 1);
});
