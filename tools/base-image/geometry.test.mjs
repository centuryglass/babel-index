import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, checkAgainstStory } from './lib/geometry.js';
import { MEASURED, SHELF_COUNT, BOOKS_PER_SHELF } from './lib/measured.js';
import { STORY } from './lib/story.js';

test('the trace still agrees with the story', () => {
  assert.deepEqual(checkAgainstStory(), []);
  assert.equal(SHELF_COUNT, STORY.shelvesPerSide);
  assert.equal(BOOKS_PER_SHELF, STORY.booksPerShelf);
  const total = MEASURED.shelves.reduce((n, s) => n + s.books.length, 0);
  assert.equal(total, STORY.shelvesPerSide * STORY.booksPerShelf, 'expected 160 books per tile');
});

test('measured rects are normalised and inside the tile', () => {
  const all = [
    MEASURED.opening,
    ...MEASURED.uprights,
    ...MEASURED.shelves.flatMap((s) => [s.board, ...s.books]),
  ];
  for (const [x, y, w, h] of all) {
    assert.ok(w > 0 && h > 0, `degenerate rect ${[x, y, w, h]}`);
    assert.ok(x >= 0 && y >= 0 && x + w <= 1.0001 && y + h <= 1.0001, `outside tile: ${[x, y, w, h]}`);
  }
  const { cx, cy, r } = MEASURED.lamp;
  assert.ok(cx - r >= 0 && cx + r <= 1 && cy - r >= 0 && cy + r <= 1);
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
  // Books do NOT sit flush against the board's front face: the view is a
  // shallow perspective, so the further a shelf is from eye level the more of
  // the board's top surface shows between the face and the spines. That gap
  // grows monotonically down the case (0.0003 at the top to 0.0113 at the
  // bottom). What must hold is that each shelf has ONE baseline, and that
  // books rest above their board rather than sinking through it.
  for (const [i, shelf] of MEASURED.shelves.entries()) {
    const bases = new Set(shelf.books.map((b) => +(b[1] + b[3]).toFixed(5)));
    assert.equal(bases.size, 1, `shelf ${i}: expected one baseline, got ${[...bases]}`);
    const base = [...bases][0];
    const boardTop = shelf.board[1];
    assert.ok(base <= boardTop + 1e-6, `shelf ${i}: books sink through the board`);
    assert.ok(boardTop - base < 0.02, `shelf ${i}: books float ${boardTop - base} above the board`);
  }
});

test('layout scales linearly with tile size', () => {
  const a = layout({ width: 512 });
  const b = layout({ width: 1024 });
  assert.equal(a.shelves.length, STORY.shelvesPerSide);
  assert.equal(b.shelves.length, STORY.shelvesPerSide);
  for (let s = 0; s < a.shelves.length; s++)
    for (let i = 0; i < a.shelves[s].books.length; i++) {
      const p = a.shelves[s].books[i];
      const q = b.shelves[s].books[i];
      assert.ok(Math.abs(p.x * 2 - q.x) < 0.02, `x mismatch at shelf ${s} book ${i}`);
      assert.ok(Math.abs(p.w * 2 - q.w) < 0.02, `w mismatch at shelf ${s} book ${i}`);
    }
  assert.ok(Math.abs(a.lamp.r * 2 - b.lamp.r) < 0.02);
});

test('layout exposes 160 addressable books', () => {
  const L = layout({ width: 1024 });
  const books = L.shelves.flatMap((s) => s.books);
  assert.equal(books.length, 160);
  assert.deepEqual(
    L.shelves.map((s) => s.books.map((b) => b.index)).flat().slice(0, 3),
    [0, 1, 2]
  );
});
