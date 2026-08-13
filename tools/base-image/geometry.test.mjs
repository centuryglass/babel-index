import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, checkAgainstStory, TILE_ASPECT } from './lib/geometry.js';
import { geometryManifest } from './lib/render.js';
import { MEASURED, SHELF_COUNT, BOOKS_PER_SHELF } from './lib/measured.js';
import { STORY } from './lib/story.js';
import { BASE_TILE } from '../../packages/web/src/pyramid.js';

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

// --- tile shape ------------------------------------------------------------

test('the lamp is a circle at every tile shape', () => {
  // Deliberate, and the one thing not stretched with the tile: a single scalar
  // radius, never an rx/ry pair. A globe that became an ellipse because the
  // wall got wider would read as a mistake rather than as a wider wall.
  for (const [width, height] of [[1024, 1024], [1280, 720], [768, 1024], [900, 675]]) {
    const { lamp } = layout({ width, height });
    assert.equal(typeof lamp.r, 'number', `${width}x${height}: radius must stay scalar`);
    assert.ok(lamp.r > 0);
    assert.equal(lamp.rx, undefined, 'an rx/ry pair would mean an ellipse');
    assert.equal(lamp.ry, undefined);
  }

  // Sized off the width alone, so stretching the tile vertically moves the lamp
  // without resizing it. Scaling by height too is what would make it an oval.
  const short = layout({ width: 1024, height: 512 });
  const tall = layout({ width: 1024, height: 2048 });
  assert.equal(short.lamp.r, tall.lamp.r, 'height must not touch the radius');
  assert.notEqual(short.lamp.cy, tall.lamp.cy, 'but it must still move with the wall');
});

test('the glow is concentric with the globe and scales with it', () => {
  const square = layout({ width: 1024, height: 1024 }).lamp;
  const baseline = square.glow / square.r;

  for (const [width, height] of [[1280, 720], [640, 360], [768, 1024]]) {
    const { lamp } = layout({ width, height });
    // Concentric: the renderer draws both at (cx, cy), so a glow that drifted
    // would halo off to one side.
    assert.ok(lamp.glow > lamp.r, `${width}x${height}: the glow must be the larger circle`);
    // And a fixed multiple of the globe, so it is a circle for the same reason
    // the globe is. Rounding is at 1e-4, so compare with a tolerance.
    assert.ok(
      Math.abs(lamp.glow / lamp.r - baseline) < 1e-4,
      `${width}x${height}: glow ratio ${lamp.glow / lamp.r} drifted from ${baseline}`
    );
  }
});

test('rects stretch with the tile, on each axis independently', () => {
  // The other half of the lamp rule: everything that is not the lamp DOES
  // follow the tile's shape, because it was traced as part of the wall.
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
  // landing on the books. Everything in assets/base-tile/ was generated that
  // way and came out 1024x1024 from a 4:3 trace.
  const L = layout({ width: 1024 });
  assert.equal(L.height, Math.round(1024 * TILE_ASPECT));
  assert.notEqual(L.height, L.width, 'the trace is 4:3; a square layout is the old bug');
  assert.ok(Math.abs(TILE_ASPECT - BASE_TILE.h / BASE_TILE.w) < 0.01, "and it is BASE_TILE's shape");
});

test('the manifest round-trips the trace, normalised per axis', () => {
  // The manifest is the trace re-expressed, so normalising it must invert the
  // scaling layout() applied: x against width, y against height. Dividing both
  // by one number survives a square tile and corrupts every other one, so this
  // is asserted at a shape where the two divisors differ.
  const { features, shelves } = geometryManifest({ width: 1024, height: 768 });
  const close = (got, want, what) =>
    assert.ok(Math.abs(got - want) < 1e-4, `${what}: ${got} should round-trip to ${want}`);

  features.opening.forEach((v, i) => close(v, MEASURED.opening[i], `opening[${i}]`));
  MEASURED.uprights.forEach((u, i) =>
    u.forEach((v, j) => close(features.uprights[i][j], v, `upright ${i}[${j}]`))
  );

  // The lamp is the exception in the same direction it always is: cx and r are
  // fractions of WIDTH, cy of height, because the globe is a circle.
  close(features.lamp[0], MEASURED.lamp.cx, 'lamp cx');
  close(features.lamp[1], MEASURED.lamp.cy, 'lamp cy');
  close(features.lamp[2], MEASURED.lamp.r, 'lamp r');

  const book = shelves[0].books[0];
  MEASURED.shelves[0].books[0].forEach((v, i) => close(book[i], v, `first book[${i}]`));
});

test('the manifest records the shape it was rendered at', () => {
  const m = geometryManifest({ width: 1024, height: 768 });
  assert.deepEqual(m.pixel, { width: 1024, height: 768 });
  // Read by a human deciding whether these numbers apply to their tile, so a
  // manifest that misreports its own shape is worse than no manifest.
  assert.deepEqual(geometryManifest({ width: 512 }).pixel, {
    width: 512,
    height: Math.round(512 * TILE_ASPECT),
  });
});

test('the trace records the shape it was made at', () => {
  // Without this the normalisation is lossy in the one way that matters, and
  // the check above has nothing to compare against.
  assert.ok(MEASURED.tile, 'measured.js must carry its traced dimensions');
  assert.ok(MEASURED.tile.w > 0 && MEASURED.tile.h > 0);
  assert.ok(Math.abs(MEASURED.tile.aspect - MEASURED.tile.h / MEASURED.tile.w) < 1e-4);
});
