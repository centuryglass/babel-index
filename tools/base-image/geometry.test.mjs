import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, TILE_ASPECT } from './lib/geometry.js';
import { MEASURED, SHELF_COUNT, BOOK_COUNT } from './lib/measured.js';
import { BASE_TILE } from '../../packages/web/src/pyramid.js';

test('measured rects are normalised and inside the tile', () => {
  const all = [MEASURED.opening, MEASURED.searchBox, ...MEASURED.shelves.flatMap((s) => s.books)];
  for (const [x, y, w, h] of all) {
    assert.ok(w > 0 && h > 0, `degenerate rect ${[x, y, w, h]}`);
    assert.ok(x >= 0 && y >= 0 && x + w <= 1.0001 && y + h <= 1.0001, `outside tile: ${[x, y, w, h]}`);
  }
});

test('the trace has as many shelves and books as it says it does', () => {
  assert.equal(MEASURED.shelves.length, SHELF_COUNT);
  const total = MEASURED.shelves.reduce((n, s) => n + s.books.length, 0);
  assert.equal(total, BOOK_COUNT);
});

test('books sit inside the opening, in order, without overlapping', () => {
  const [ox, oy, ow, oh] = MEASURED.opening;
  for (const shelf of MEASURED.shelves) {
    let prevRight = -Infinity;
    for (const [x, y, w, h] of shelf.books) {
      assert.ok(x >= ox - 1e-6 && x + w <= ox + ow + 1e-6, 'book outside opening horizontally');
      assert.ok(y >= oy - 1e-6 && y + h <= oy + oh + 1e-6, 'book outside opening vertically');
      assert.ok(x >= prevRight - 1e-6, 'books must be ordered left to right and not overlap');
      prevRight = x + w;
    }
  }
});

test('every book on a shelf stands on the same line', () => {
  // No board is traced any more, so all that is asserted is that a shelf has
  // ONE baseline - every book on it rests at the same depth, whether or not
  // the shelf's books form one contiguous run.
  for (const [i, shelf] of MEASURED.shelves.entries()) {
    const bases = new Set(shelf.books.map((b) => +(b[1] + b[3]).toFixed(5)));
    assert.equal(bases.size, 1, `shelf ${i}: expected one baseline, got ${[...bases]}`);
  }
});

test('layout scales linearly with tile size', () => {
  const a = layout({ width: 512 });
  const b = layout({ width: 1024 });
  assert.equal(a.shelves.length, b.shelves.length);
  for (let s = 0; s < a.shelves.length; s++)
    for (let i = 0; i < a.shelves[s].books.length; i++) {
      const p = a.shelves[s].books[i];
      const q = b.shelves[s].books[i];
      assert.ok(Math.abs(p.x * 2 - q.x) < 0.02, `x mismatch at shelf ${s} book ${i}`);
      assert.ok(Math.abs(p.w * 2 - q.w) < 0.02, `w mismatch at shelf ${s} book ${i}`);
    }
});

test('layout exposes every book as an addressable slot', () => {
  const L = layout({ width: 1024 });
  const books = L.shelves.flatMap((s) => s.books);
  assert.equal(books.length, BOOK_COUNT);
  assert.deepEqual(
    L.shelves.map((s) => s.books.map((b) => b.index)).flat().slice(0, 3),
    [0, 1, 2]
  );
});

// --- tile shape ------------------------------------------------------------

test('rects stretch with the tile, on each axis independently', () => {
  const square = layout({ width: 1000, height: 1000 });
  const wide = layout({ width: 1000, height: 500 });
  assert.equal(wide.opening.w, square.opening.w, 'width is unchanged');
  assert.ok(
    Math.abs(wide.opening.h - square.opening.h / 2) < 0.02,
    `expected the opening to halve in height, got ${wide.opening.h} from ${square.opening.h}`
  );
});

test('the trace and the tile agree on aspect', () => {
  // Two independent statements of one fact: the SVG's viewBox and BASE_TILE.
  // measured.js normalises x against the traced width and y against the traced
  // height, so if they disagree every measured rect is silently stretched onto
  // art it no longer matches - the books stop landing on the books.
  //
  // The workflow this guards: change the tile's aspect, re-trace in Inkscape,
  // re-run the importer. Do one and forget the other and this is what says so.
  const traced = MEASURED.tile.aspect;
  const tile = BASE_TILE.h / BASE_TILE.w;
  assert.ok(
    Math.abs(traced - tile) < 0.01,
    `the trace is ${MEASURED.tile.w}x${MEASURED.tile.h} (aspect ${traced}) but BASE_TILE is ` +
      `${BASE_TILE.w}x${BASE_TILE.h} (aspect ${tile}). Re-trace shelf_geometry.svg at the ` +
      `new shape and re-run import-shelf-svg.mjs, or put BASE_TILE back.`
  );
});

test('a width with no height gives the traced shape, not a square', () => {
  // The bug this pins: `height = width` as a default. It is silent, because
  // every rect is individually still inside the tile - the books just stop
  // landing on the books, and a 4:3 trace comes out 1024x1024.
  const L = layout({ width: 1024 });
  assert.equal(L.height, Math.round(1024 * TILE_ASPECT));
  assert.notEqual(L.height, L.width, 'the trace is 4:3; a square layout is the old bug');
  assert.ok(Math.abs(TILE_ASPECT - BASE_TILE.h / BASE_TILE.w) < 0.01, "and it is BASE_TILE's shape");
});

test('the trace records the shape it was made at', () => {
  // Without this the normalisation is lossy in the one way that matters, and
  // the check above has nothing to compare against.
  assert.ok(MEASURED.tile, 'measured.js must carry its traced dimensions');
  assert.ok(MEASURED.tile.w > 0 && MEASURED.tile.h > 0);
  assert.ok(Math.abs(MEASURED.tile.aspect - MEASURED.tile.h / MEASURED.tile.w) < 1e-4);
});
