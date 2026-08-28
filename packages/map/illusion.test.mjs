import test from 'node:test';
import assert from 'node:assert/strict';
import { planMoves, applyMove, normaliseDistance } from './illusion.ts';

/**
 * The verifier is deliberately a second implementation.
 *
 * It re-derives the move semantics from scratch and reads nothing but the
 * emitted list, so a bug in the planner's own bookkeeping - its value index,
 * its lock counters - cannot hide a bug in its output. Everything the illusion
 * depends on is asserted here rather than inside the planner, because the
 * planner asserting its own guarantees only proves it is self-consistent.
 */
function replayAndVerify(start, end, bounds, fixed, moves) {
  const { width: W, height: H } = start;
  const { xmin, xmax, ymin, ymax } = bounds;
  const { x: fx, y: fy } = fixed;
  const b = start.cells.slice();
  const inside = (x, y) => x >= xmin && x <= xmax && y >= ymin && y <= ymax;

  for (const mv of moves) {
    if (mv.type === 'shiftRow') {
      assert.ok(!(mv.row === fy && mv.distance % W !== 0), 'fixed tile displaced by a row shift');
      const d = ((mv.distance % W) + W) % W;
      const base = mv.row * W;
      const old = b.slice(base, base + W);
      for (let x = 0; x < W; x++) b[base + x] = old[(x - d + W) % W];
    } else if (mv.type === 'shiftCol') {
      assert.ok(!(mv.col === fx && mv.distance % H !== 0), 'fixed tile displaced by a column shift');
      const d = ((mv.distance % H) + H) % H;
      const old = [];
      for (let y = 0; y < H; y++) old.push(b[y * W + mv.col]);
      for (let y = 0; y < H; y++) b[y * W + mv.col] = old[(y - d + H) % H];
    } else if (mv.type === 'swap') {
      assert.ok(
        !inside(mv.a.x, mv.a.y) && !inside(mv.b.x, mv.b.y),
        'swap with an endpoint inside the illusion bounds'
      );
      assert.ok(
        !(mv.a.x === fx && mv.a.y === fy) && !(mv.b.x === fx && mv.b.y === fy),
        'fixed tile swapped'
      );
      const p = mv.a.y * W + mv.a.x;
      const q = mv.b.y * W + mv.b.x;
      [b[p], b[q]] = [b[q], b[p]];
    } else {
      assert.fail(`unknown move ${mv.type}`);
    }
  }

  assert.deepEqual(b, end.cells, 'final board does not match the end board');
  return b;
}

/** Plan, verify against the independent replay, and check `applyMove` agrees. */
function planAndVerify(start, end, bounds, fixed) {
  const moves = planMoves(start, end, bounds, fixed);
  const replayed = replayAndVerify(start, end, bounds, fixed, moves);

  const live = { ...start, cells: start.cells.slice() };
  for (const mv of moves) applyMove(live, mv);
  assert.deepEqual(live.cells, replayed, 'applyMove disagrees with the independent replay');

  return moves;
}

/** Deterministic PRNG, so a failure is reproducible from its seed alone. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) ^ (s >>> 7)) >>> 0;
    return s / 4294967296;
  };
}

const randInt = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

const board = (W, H, cells) => ({ width: W, height: H, cells });

/**
 * A valid (start, end) pair.
 *
 * `end` is a permutation of `start` leaving the fixed cell alone by
 * construction, which satisfies both preconditions - same multiset, fixed tile
 * agreeing - without any repair afterwards. `alphabet` is kept small on
 * purpose: a board dense with duplicates is the case an approach that inverts a
 * permutation would quietly get wrong, and it is also what the real map looks
 * like, where most cells hold the same generic room.
 */
function makeCase(r, W, H, fixed, alphabet) {
  const cells = Array.from({ length: W * H }, () => Math.floor(r() * alphabet));
  const movable = [];
  for (let p = 0; p < cells.length; p++) if (p !== fixed.y * W + fixed.x) movable.push(p);
  const vals = movable.map((p) => cells[p]);
  for (let i = vals.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [vals[i], vals[j]] = [vals[j], vals[i]];
  }
  const out = cells.slice();
  movable.forEach((p, i) => (out[p] = vals[i]));
  return [board(W, H, cells), board(W, H, out)];
}

/** An interior rectangle covering less than a quarter of the board. */
function randomBounds(r, W, H) {
  let w;
  let k;
  do {
    w = randInt(r, 1, W - 2);
    k = randInt(r, 1, H - 2);
  } while (w * k * 4 >= W * H);
  const xmin = randInt(r, 1, W - 1 - w);
  const ymin = randInt(r, 1, H - 1 - k);
  return { xmin, xmax: xmin + w - 1, ymin, ymax: ymin + k - 1 };
}

test('normaliseDistance takes the shorter way round', () => {
  assert.equal(normaliseDistance(97, 100), -3);
  assert.equal(normaliseDistance(3, 100), 3);
  assert.equal(normaliseDistance(-97, 100), 3);
  assert.equal(normaliseDistance(0, 100), 0);
  // Exactly half stays positive, so the choice is at least deterministic.
  assert.equal(normaliseDistance(5, 10), 5);
});

test('randomized boards transform legally and land exactly', () => {
  const r = rng(7);
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const W = randInt(r, 10, 26);
    const H = randInt(r, 10, 26);
    const bounds = randomBounds(r, W, H);
    const fixed = { x: randInt(r, 0, W - 1), y: randInt(r, 0, H - 1) };
    const [start, end] = makeCase(r, W, H, fixed, randInt(r, 2, 8));
    const moves = planAndVerify(start, end, bounds, fixed);
    worst = Math.max(worst, moves.length / (W * H));
  }
  // The reference measures ~1.15x the board size; a regression that made this
  // quadratic would still be correct, and this is what would notice.
  assert.ok(worst < 2, `move count ${worst.toFixed(2)}x board size is too high`);
});

test('the fixed tile survives every placement relative to the region', () => {
  const r = rng(11);
  for (let i = 0; i < 150; i++) {
    const W = randInt(r, 10, 24);
    const H = randInt(r, 10, 24);
    const bounds = randomBounds(r, W, H);
    const outsideX = [...Array(W).keys()].filter((x) => x < bounds.xmin || x > bounds.xmax);
    const outsideY = [...Array(H).keys()].filter((y) => y < bounds.ymin || y > bounds.ymax);

    // The three cases exercise different paths: inside the region (phase 1
    // skips its row), in a region column but off camera (phase 1 runs for every
    // region row), and in a region row (phase 1 never runs, but that row is
    // unshiftable and must be filled by phase 2's conveyor).
    const fixed = [
      { x: randInt(r, bounds.xmin, bounds.xmax), y: randInt(r, bounds.ymin, bounds.ymax) },
      { x: randInt(r, bounds.xmin, bounds.xmax), y: outsideY[randInt(r, 0, outsideY.length - 1)] },
      { x: outsideX[randInt(r, 0, outsideX.length - 1)], y: randInt(r, bounds.ymin, bounds.ymax) },
    ][i % 3];

    const [start, end] = makeCase(r, W, H, fixed, randInt(r, 2, 5));
    planAndVerify(start, end, bounds, fixed);
  }
});

test('regions larger than half the board in one axis still work', () => {
  // Both are legal under the bounds rule and both defeat any approach that
  // assumes a region line can be cleared in a single rotation - the conveyor
  // never needs to, which is why it survives them.
  const cases = [
    {
      label: 'tall and thin',
      W: 100, H: 10,
      bounds: { xmin: 50, xmax: 50, ymin: 1, ymax: 8 },
      fixtures: [{ x: 50, y: 4 }, { x: 50, y: 9 }, { x: 0, y: 3 }],
    },
    {
      label: 'wide and flat',
      W: 100, H: 100,
      bounds: { xmin: 5, xmax: 94, ymin: 40, ymax: 41 },
      fixtures: [{ x: 50, y: 40 }, { x: 50, y: 0 }, { x: 0, y: 41 }],
    },
  ];
  for (const { W, H, bounds, fixtures, label } of cases)
    for (const fixed of fixtures) {
      const [start, end] = makeCase(rng(W + H + fixed.x * 31 + fixed.y), W, H, fixed, 4);
      assert.ok(planAndVerify(start, end, bounds, fixed).length > 0, label);
    }
});

test('a board that is mostly one value is the easy case, not a special one', () => {
  // The real map: ~80% generic, a handful of distinct rooms. Nothing here is
  // asked to identify a particular tile, so the duplicates cost nothing.
  const r = rng(3);
  const W = 30;
  const H = 24;
  const fixed = { x: 15, y: 12 };
  const cells = Array.from({ length: W * H }, () => (r() < 0.2 ? Math.floor(r() * 40) : 'generic'));
  const movable = [...Array(W * H).keys()].filter((p) => p !== fixed.y * W + fixed.x);
  const vals = movable.map((p) => cells[p]);
  for (let i = vals.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [vals[i], vals[j]] = [vals[j], vals[i]];
  }
  const out = cells.slice();
  movable.forEach((p, i) => (out[p] = vals[i]));
  planAndVerify(board(W, H, cells), board(W, H, out), { xmin: 10, xmax: 19, ymin: 9, ymax: 14 }, fixed);
});

/**
 * A board whose distinct values are all ON camera at the start.
 *
 * This is the case that makes staging load-bearing, and randomized boards do
 * not reach it: with a handful of values spread over a few hundred cells, every
 * value has a copy off camera and `makeAvailable` never has to extract one. Here
 * nothing can be sourced by a swap, so every insertion first rotates a copy out
 * of the region - and rotating a region column is exactly what would undo the
 * conveyor's partial progress if the column's values were gathered one at a
 * time rather than all parked in advance.
 *
 * It is also the shape of a real search: the density gradient packs distinct
 * rooms against the center, which is precisely the viewport.
 */
function trappedCase(W, H, bounds, fixed, permuteWithinRegion, r) {
  const cells = new Array(W * H).fill('generic');
  const regionCells = [];
  for (let y = bounds.ymin; y <= bounds.ymax; y++)
    for (let x = bounds.xmin; x <= bounds.xmax; x++) regionCells.push(y * W + x);
  regionCells.forEach((p, i) => (cells[p] = `room${i}`));

  const out = cells.slice();
  const fixedAt = fixed.y * W + fixed.x;
  // Where the distinct values are allowed to land: inside the region only, or
  // anywhere on the board - the second being what a search really does, since
  // it changes which cells are content at all.
  const targets = (permuteWithinRegion ? regionCells : [...Array(W * H).keys()]).filter(
    (p) => p !== fixedAt
  );
  const sources = regionCells.filter((p) => p !== fixedAt);
  const values = sources.map((p) => cells[p]);
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  for (const p of targets) out[p] = 'generic';
  targets.slice(0, values.length).forEach((p, i) => (out[p] = values[i]));
  return [board(W, H, cells), board(W, H, out)];
}

test('every distinct value trapped on camera at the start', () => {
  const bounds = { xmin: 10, xmax: 19, ymin: 9, ymax: 14 };
  // The center room's cell, which is what the map pins: inside the region, so
  // phase 1 runs for its column and skips only its own row.
  const fixed = { x: 14, y: 11 };
  for (const within of [true, false])
    for (const seed of [1, 2, 3]) {
      const [start, end] = trappedCase(30, 24, bounds, fixed, within, rng(seed));
      planAndVerify(start, end, bounds, fixed);
    }
});

test('only the region is ever slid; everything else is swapped', () => {
  // The property the animation depends on: visible work is bounded by the
  // viewport, not by the corpus. A shift of a line that does not cross the
  // region would be wasted motion off camera, and there are none.
  const r = rng(5);
  const W = 40;
  const H = 30;
  const bounds = { xmin: 16, xmax: 23, ymin: 12, ymax: 17 };
  const fixed = { x: 20, y: 14 };
  const [start, end] = makeCase(r, W, H, fixed, 6);
  const moves = planAndVerify(start, end, bounds, fixed);

  const slides = moves.filter((m) => m.type !== 'swap');
  for (const m of slides) {
    if (m.type === 'shiftRow') assert.ok(m.row >= bounds.ymin && m.row <= bounds.ymax);
    else assert.ok(m.col >= bounds.xmin && m.col <= bounds.xmax);
  }
  // One row shift per region row for the fixed column, then the conveyor.
  const rows = bounds.ymax - bounds.ymin + 1;
  const cols = bounds.xmax - bounds.xmin + 1;
  assert.ok(slides.length <= (rows - 1) + (cols - 1) * rows, `${slides.length} slides is more than the conveyor needs`);
});

test('preconditions are refused loudly rather than mis-planned', () => {
  const W = 12;
  const H = 12;
  const flat = (v) => board(W, H, Array.from({ length: W * H }, () => v));
  const ok = { xmin: 4, xmax: 6, ymin: 4, ymax: 6 };
  const fixed = { x: 1, y: 1 };

  assert.throws(() => planMoves(board(8, 8, new Array(64).fill(0)), board(8, 8, new Array(64).fill(0)), ok, fixed), RangeError);
  // Touching an edge: the "just outside" cells would wrap to the far side.
  assert.throws(() => planMoves(flat(0), flat(0), { xmin: 0, xmax: 3, ymin: 4, ymax: 6 }, fixed), RangeError);
  assert.throws(() => planMoves(flat(0), flat(0), { xmin: 4, xmax: 6, ymin: 4, ymax: H - 1 }, fixed), RangeError);
  // Too much of the board on camera starves the parking pool mid-plan.
  assert.throws(() => planMoves(flat(0), flat(0), { xmin: 1, xmax: 10, ymin: 1, ymax: 10 }, fixed), RangeError);
  // A fixed tile that does not agree between the boards.
  const a = flat(0);
  const b = flat(0);
  b.cells[fixed.y * W + fixed.x] = 1;
  assert.throws(() => planMoves(a, b, ok, fixed), RangeError);
});
