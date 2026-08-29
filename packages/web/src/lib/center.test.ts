import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../../../../tools/center-placement/lib/geometry.ts';
import {
  BOOK_COUNT,
  HISTORY_SLOT_COUNT,
  CENTER_SHELF_RECT,
  CENTER_SEARCH_RECT,
  CENTER_OPENING_RECT,
  bookScreenRects,
  searchBoxScreenRect,
  isSearchBoxUsable,
  searchBoxAtPoint,
  centerCellRect,
  bookAtPoint,
  assignTitles,
  pickTags,
  bookNeighbour,
  describeBook,
  areSpinesLegible,
  overlapsViewport,
  BOOK_RECTS,
  minZoomForSearchBox,
} from './center.ts';
import { CELL_ASPECT, fitZoom } from './camera.ts';

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

test('CENTER_OPENING_RECT is the tight bounding union of the shelf and the search box', () => {
  const a = CENTER_SHELF_RECT;
  const b = CENTER_SEARCH_RECT;
  const u = CENTER_OPENING_RECT;
  // Both source rects are fully contained.
  assert.ok(u.x <= a.x && u.y <= a.y && u.x + u.w >= a.x + a.w && u.y + u.h >= a.y + a.h);
  assert.ok(u.x <= b.x && u.y <= b.y && u.x + u.w >= b.x + b.w && u.y + u.h >= b.y + b.h);
  // Tight: each edge is pinned by one of the two source rects, not padded.
  assert.ok([a.x, b.x].includes(u.x));
  assert.ok([a.y, b.y].includes(u.y));
  assert.ok([a.x + a.w, b.x + b.w].includes(u.x + u.w));
  assert.ok([a.y + a.h, b.y + b.h].includes(u.y + u.h));
});

test('searchBoxScreenRect scales the search box onto a cell rect, per axis', () => {
  const cell = { x: 100, y: 50, w: 800, h: 600 };
  const r = searchBoxScreenRect(cell);
  const b = CENTER_SEARCH_RECT;
  assert.ok(Math.abs((r.x - cell.x) / cell.w - b.x) < 1e-9);
  assert.ok(Math.abs((r.y - cell.y) / cell.h - b.y) < 1e-9);
  assert.ok(Math.abs(r.w / cell.w - b.w) < 1e-9);
  assert.ok(Math.abs(r.h / cell.h - b.h) < 1e-9);
});

test('isSearchBoxUsable gates on the box on-screen height', () => {
  const tiny = { x: 0, y: 0, w: 100, h: 100 };
  const huge = { x: 0, y: 0, w: 4000, h: 4000 };
  assert.equal(isSearchBoxUsable(tiny), false);
  assert.equal(isSearchBoxUsable(huge), true);
});

test('searchBoxAtPoint hits the box only when it is usable, and misses outside it', () => {
  const huge = { x: 0, y: 0, w: 4000, h: 4000 };
  const box = searchBoxScreenRect(huge);
  assert.equal(searchBoxAtPoint(box.x + box.w / 2, box.y + box.h / 2, huge), true);
  // Just outside the box, still on the cell.
  assert.equal(searchBoxAtPoint(box.x - 5, box.y + box.h / 2, huge), false);
  assert.equal(searchBoxAtPoint(box.x + box.w / 2, box.y + box.h + 5, huge), false);
  // A point that is geometrically inside the box's fraction, but the cell is
  // too small for the box to be usable, must still miss.
  const tiny = { x: 0, y: 0, w: 100, h: 100 };
  const tinyBox = searchBoxScreenRect(tiny);
  assert.equal(searchBoxAtPoint(tinyBox.x + tinyBox.w / 2, tinyBox.y + tinyBox.h / 2, tiny), false);
});

test('minZoomForSearchBox floors a portrait opening fit that would leave the box unusable', () => {
  // A narrow, tall viewport: fitting CENTER_OPENING_RECT (the shelf+box
  // union, wide relative to the box alone) to a portrait phone screen binds
  // on width, landing a zoom the box's own height minimum does not survive -
  // this is the reported bug. Flooring at minZoomForSearchBox must recover it.
  const portrait = { width: 360, height: 780 };
  const openingZoom = fitZoom({ ...portrait, target: CENTER_OPENING_RECT, margin: 0.94 });
  const cellFromOpeningAlone = { x: 0, y: 0, w: openingZoom, h: openingZoom * CELL_ASPECT };
  assert.equal(isSearchBoxUsable(cellFromOpeningAlone), false);

  const floored = Math.max(openingZoom, minZoomForSearchBox());
  const cellFloored = { x: 0, y: 0, w: floored, h: floored * CELL_ASPECT };
  assert.equal(isSearchBoxUsable(cellFloored), true);
});

test('minZoomForSearchBox is exactly the zoom where the box screen height hits its minimum', () => {
  const z = minZoomForSearchBox();
  const justUnder = { x: 0, y: 0, w: z - 0.01, h: (z - 0.01) * CELL_ASPECT };
  const justOver = { x: 0, y: 0, w: z + 0.01, h: (z + 0.01) * CELL_ASPECT };
  assert.equal(isSearchBoxUsable(justUnder), false);
  assert.equal(isSearchBoxUsable(justOver), true);
});

test('centerCellRect places cell (0,0) and sizes it one cell each axis', () => {
  const cam = { x: 0, y: 0, zoom: 900, aspect: CELL_ASPECT };
  const canvasRect = { width: 1200, height: 800 };
  const cell = centerCellRect(cam, canvasRect);
  assert.equal(cell.x, 600);
  assert.equal(cell.y, 400);
  assert.equal(cell.w, 900);
  assert.equal(cell.h, 900 * CELL_ASPECT);
});

test('bookAtPoint resolves the center of every book, and rejects points off the wall', () => {
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
  // Just past the right edge of book 0, still left of book 1's center.
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

// --- the shelf as a keyboard surface ---------------------------------------

/** A wall where every book carries a title - the ordinary case. */
const FULL = assignTitles({ tags: ['a', 'b', 'c'] });

test('BOOK_RECTS is the flat wall in cell fractions, one rect per slot', () => {
  assert.equal(BOOK_RECTS.length, BOOK_COUNT);
  // Same numbers `bookScreenRects` scales, so the DOM overlay and the canvas
  // cannot describe two different walls.
  const cell = { x: 0, y: 0, w: 1, h: 1 };
  const scaled = bookScreenRects(cell);
  for (let i = 0; i < BOOK_COUNT; i++) {
    assert.ok(Math.abs(scaled[i].x - BOOK_RECTS[i].x) < 1e-12);
    assert.ok(Math.abs(scaled[i].h - BOOK_RECTS[i].h) < 1e-12);
  }
});

test('left and right run the wall as one flat queue, and stop at its ends', () => {
  assert.equal(bookNeighbour(0, { dx: 1 }, FULL), 1);
  assert.equal(bookNeighbour(1, { dx: -1 }, FULL), 0);
  // The ends hold rather than wrap: a wall that wrapped would put the last
  // book one press left of the first, which is not what it looks like.
  assert.equal(bookNeighbour(0, { dx: -1 }, FULL), 0);
  assert.equal(bookNeighbour(BOOK_COUNT - 1, { dx: 1 }, FULL), BOOK_COUNT - 1);
});

test('right crosses a shelf end, because the wall is one queue', () => {
  const firstShelf = GEO.shelves[0].books.length;
  assert.equal(bookNeighbour(firstShelf - 1, { dx: 1 }, FULL), firstShelf);
});

test('up and down move a shelf, holding the column', () => {
  const shelf0 = GEO.shelves[0].books.length;
  const shelf1 = GEO.shelves[1].books.length;
  assert.equal(bookNeighbour(2, { dy: 1 }, FULL), shelf0 + 2);
  assert.equal(bookNeighbour(shelf0 + 2, { dy: -1 }, FULL), 2);
  // And hold at the top and bottom of the wall.
  assert.equal(bookNeighbour(0, { dy: -1 }, FULL), 0);
  const lastRowStart = BOOK_COUNT - GEO.shelves[GEO.shelves.length - 1].books.length;
  assert.equal(bookNeighbour(lastRowStart, { dy: 1 }, FULL), lastRowStart);
  assert.ok(shelf1 > 0);
});

test('Home and End are the same walk, started outside the wall', () => {
  assert.equal(bookNeighbour(-1, { dx: 1 }, FULL), 0);
  assert.equal(bookNeighbour(BOOK_COUNT, { dx: -1 }, FULL), BOOK_COUNT - 1);
});

test('an untitled book is stepped over, not landed on', () => {
  // Two searches and no keyword corpus: the front of the wall is lettered and
  // the rest is blank, which is the only way a blank book happens at all.
  const sparse = assignTitles({ history: ['one', 'two'], tags: [] });
  assert.equal(sparse[2].text, '');
  assert.equal(bookNeighbour(1, { dx: 1 }, sparse), 1, 'no titled book to the right');
  assert.equal(bookNeighbour(BOOK_COUNT, { dx: -1 }, sparse), 1, 'End is the last TITLED book');
  // And a shelf below with nothing on it does not swallow the press.
  assert.equal(bookNeighbour(0, { dy: 1 }, sparse), 0);
});

test('a book says what it is as well as what it says', () => {
  const wall = assignTitles({ history: ['brass'], tags: ['spiral staircase'] });
  assert.match(describeBook(wall[0]), /^brass\b/);
  assert.match(describeBook(wall[0]), /repeat/, 'a history book repeats its search');
  assert.match(describeBook(wall[1]), /^spiral staircase\b/);
  assert.match(describeBook(wall[1]), /search/, 'a tag book runs a new search');
  // An override is its own name - it does not search, so it must not claim to.
  assert.equal(describeBook({ kind: 'override', text: 'artist statement' }), 'artist statement');
  assert.equal(describeBook({ kind: 'empty', text: '' }), '');
});

test('the buttons exist exactly while the titles are legible', () => {
  // The gate is the SPINE's on-screen width, not the cell's, so it tracks the
  // trace rather than a number restated here.
  const spine = BOOK_RECTS[0].w;
  assert.equal(areSpinesLegible({ x: 0, y: 0, w: 4 / spine, h: 100 }), false);
  assert.equal(areSpinesLegible({ x: 0, y: 0, w: 6 / spine, h: 100 }), true);
});

test('overlapsViewport is an overlap, not containment', () => {
  assert.equal(overlapsViewport({ x: -10, y: -10, w: 20, h: 20 }, 100, 100), true);
  assert.equal(overlapsViewport({ x: 100, y: 0, w: 20, h: 20 }, 100, 100), false);
  assert.equal(overlapsViewport({ x: 0, y: -30, w: 20, h: 20 }, 100, 100), false);
});
