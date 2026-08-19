import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../../../tools/base-image/lib/geometry.js';
import {
  BOOK_COUNT,
  HISTORY_SLOT_COUNT,
  bookScreenRects,
  centreCellRect,
  bookAtPoint,
  assignTitles,
  pickTags,
} from './centre.js';
import { CELL_ASPECT } from './camera.js';

const GEO = layout({ width: 1, height: 1 });

test('every book on the wall is a slot, and the whole wall is the history queue', () => {
  assert.equal(BOOK_COUNT, 40);
  assert.equal(HISTORY_SLOT_COUNT, BOOK_COUNT);
});

test('book rects scale onto a cell rect, each inside its shelf', () => {
  const cell = { x: 100, y: 50, w: 800, h: 600 };
  const rects = bookScreenRects(cell);
  assert.equal(rects.length, BOOK_COUNT);

  let k = 0;
  for (const shelf of GEO.shelves) {
    for (const b of shelf.books) {
      const r = rects[k++];
      // The rect is this book's fraction scaled onto the cell, per axis.
      assert.ok(Math.abs((r.x - cell.x) / cell.w - b.x) < 1e-9);
      assert.ok(Math.abs((r.y - cell.y) / cell.h - b.y) < 1e-9);
      assert.ok(Math.abs(r.w / cell.w - b.w) < 1e-9);
    }
  }
});

test('centreCellRect places cell (0,0) and sizes it one cell each axis', () => {
  const cam = { x: 0, y: 0, zoom: 900, aspect: CELL_ASPECT };
  const canvasRect = { width: 1200, height: 800 };
  const cell = centreCellRect(cam, canvasRect);
  assert.equal(cell.x, 600);
  assert.equal(cell.y, 400);
  assert.equal(cell.w, 900);
  assert.equal(cell.h, 900 * CELL_ASPECT);
});

test('bookAtPoint resolves the centre of every book, and rejects points off the wall', () => {
  const cell = { x: 0, y: 0, w: 1000, h: 1000 };
  const rects = bookScreenRects(cell);

  for (let i = 0; i < BOOK_COUNT; i++) {
    const r = rects[i];
    assert.equal(bookAtPoint(r.x + r.w / 2, r.y + r.h / 2, cell), i);
  }
  // Above the top shelf and below the bottom shelf is nothing.
  assert.equal(bookAtPoint(rects[0].x, rects[0].y - 50, cell), null);
  const lastRow = rects[BOOK_COUNT - 1];
  assert.equal(bookAtPoint(lastRow.x, lastRow.y + lastRow.h + 50, cell), null);
  // Left of the first book and right of the last on a shelf is nothing.
  const midY = rects[0].y + rects[0].h / 2;
  assert.equal(bookAtPoint(rects[0].x - 50, midY, cell), null);
});

test('a point in the gap between two spines resolves to a book, not null', () => {
  const cell = { x: 0, y: 0, w: 1000, h: 1000 };
  const rects = bookScreenRects(cell);
  // Just past the right edge of book 0, still left of book 1's centre.
  const gapX = rects[0].x + rects[0].w + 0.5;
  const midY = rects[0].y + rects[0].h / 2;
  const hit = bookAtPoint(gapX, midY, cell);
  assert.ok(hit === 0 || hit === 1, `a gap must resolve to an adjacent book, got ${hit}`);
});

test('a gap wider than a book (art breaking up a shelf) is not a book', () => {
  // The middle shelf leaves room for a decorative element mid-shelf, so its
  // books form two runs rather than one. A click over that gap must fall
  // through to null - it must not snap to whichever run was checked first.
  const cell = { x: 0, y: 0, w: 1000, h: 1000 };
  const rects = bookScreenRects(cell);
  let k = 0;
  let sawWideGap = false;
  for (const shelf of GEO.shelves) {
    for (let i = 1; i < shelf.books.length; i++) {
      const prev = rects[k + i - 1];
      const cur = rects[k + i];
      const gap = cur.x - (prev.x + prev.w);
      if (gap <= prev.w) continue;
      sawWideGap = true;
      const midX = prev.x + prev.w + gap / 2;
      const midY = prev.y + prev.h / 2;
      assert.equal(bookAtPoint(midX, midY, cell), null);
    }
    k += shelf.books.length;
  }
  assert.ok(sawWideGap, 'expected the trace to have at least one shelf split into runs');
});

test('history fills the wall newest-first from the top left, and tags fill the rest', () => {
  const history = ['newest', 'older', 'oldest'];
  const tags = ['a', 'b'];
  const slots = assignTitles({ history, tags });

  assert.equal(slots.length, BOOK_COUNT);
  // History lands at the front of the wall, first book first.
  assert.equal(slots[0].kind, 'history');
  assert.deepEqual([slots[0], slots[1], slots[2]].map((s) => s.text), ['newest', 'older', 'oldest']);
  // Books past the history entries are tags, never history.
  assert.equal(slots[3].kind, 'tag');
  assert.ok(slots.every((s) => s && s.text), 'every book carries a title');
  assert.ok(slots.every((s) => s.kind !== 'empty'), 'a non-empty tag pool leaves no blanks');
});

test('tags cycle to fill the whole wall when the pool is smaller than it', () => {
  const slots = assignTitles({ history: [], tags: ['x', 'y'] });
  assert.ok(slots.every((s) => s.text === 'x' || s.text === 'y'));
  // First two distinct, then repeating - the cycle.
  assert.equal(slots[0].text, 'x');
  assert.equal(slots[1].text, 'y');
  assert.equal(slots[2].text, 'x');
});

test('assignTitles reserves override books and the history queue skips them', () => {
  // Reserve the very first book on the wall.
  const overrides = { 0: { text: 'statement', action: 'statement' } };
  const slots = assignTitles({ history: ['h1', 'h2'], tags: [], overrides });

  assert.equal(slots[0].kind, 'override');
  assert.equal(slots[0].action, 'statement');
  assert.equal(slots[0].term, undefined);
  // History skips the reserved book and starts at the next open slot.
  assert.equal(slots[1].text, 'h1');
  assert.equal(slots[2].text, 'h2');
});

test('pickTags is a deduped, stable, bounded selection of corpus keywords', () => {
  const metadata = [
    { keywords: [{ text: 'copper' }, { text: 'art nouveau' }] },
    null,
    { keywords: [{ text: 'copper' }, { text: 'collodion' }] },
  ];
  const a = pickTags(metadata, 1);
  const b = pickTags(metadata, 1);
  assert.deepEqual(a, b); // stable for a seed
  assert.equal(new Set(a).size, a.length); // deduped
  assert.deepEqual([...a].sort(), ['art nouveau', 'collodion', 'copper']);
  assert.ok(a.length <= BOOK_COUNT);
  assert.deepEqual(pickTags(null, 1), []);
});
