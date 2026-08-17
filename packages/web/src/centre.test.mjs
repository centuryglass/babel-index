import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../../../tools/base-image/lib/geometry.js';
import {
  BOOK_COUNT,
  HISTORY_SLOT_COUNT,
  HISTORY_SHELF,
  bookScreenRects,
  centreCellRect,
  bookAtPoint,
  assignTitles,
  pickTags,
} from './centre.js';
import { CELL_ASPECT } from './camera.js';

const GEO = layout({ width: 1, height: 1 });
// The flat id of the first book on the history shelf, shelf-major.
const HISTORY_START = GEO.shelves
  .slice(0, HISTORY_SHELF)
  .reduce((n, s) => n + s.books.length, 0);

test('every book on all five shelves is a slot', () => {
  assert.equal(BOOK_COUNT, 160);
  assert.equal(HISTORY_SLOT_COUNT, 32);
  assert.equal(HISTORY_SHELF, 1);
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

test('history fills the history shelf newest-first, and tags fill the rest', () => {
  const history = ['newest', 'older', 'oldest'];
  const tags = ['a', 'b'];
  const slots = assignTitles({ history, tags });

  assert.equal(slots.length, BOOK_COUNT);
  // History lands on the history shelf, front book first.
  assert.equal(slots[HISTORY_START].kind, 'history');
  assert.deepEqual(
    [slots[HISTORY_START], slots[HISTORY_START + 1], slots[HISTORY_START + 2]].map((s) => s.text),
    ['newest', 'older', 'oldest']
  );
  // Books off the history shelf are tags, never history.
  assert.equal(slots[0].kind, 'tag');
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

test('assignTitles reserves override books and history never overwrites them', () => {
  // Reserve the front book of the history shelf.
  const overrides = { [HISTORY_START]: { text: 'statement', action: 'statement' } };
  const slots = assignTitles({ history: ['h1', 'h2'], tags: [], overrides });

  assert.equal(slots[HISTORY_START].kind, 'override');
  assert.equal(slots[HISTORY_START].action, 'statement');
  assert.equal(slots[HISTORY_START].term, undefined);
  // History skips the reserved book and starts at the next history slot.
  assert.equal(slots[HISTORY_START + 1].text, 'h1');
  assert.equal(slots[HISTORY_START + 2].text, 'h2');
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
