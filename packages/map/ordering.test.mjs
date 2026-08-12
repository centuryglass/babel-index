import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, isContentSlot, shuffledOrder, rankByEmbedding } from './ordering.js';

test('slot density tracks contentRatio', () => {
  for (const ratio of [0.05, 0.2, 0.5]) {
    let hits = 0;
    const span = 120;
    for (let y = -span; y <= span; y++)
      for (let x = -span; x <= span; x++) if (isContentSlot(x, y, { seed: 7, contentRatio: ratio })) hits++;
    const actual = hits / (2 * span + 1) ** 2;
    assert.ok(
      Math.abs(actual - ratio) < ratio * 0.06,
      `ratio ${ratio}: got ${actual.toFixed(4)}`
    );
  }
});

test('layout places every room and orders by distance from centre', () => {
  const L = createLayout({ roomCount: 512, contentRatio: 0.2, seed: 3 });
  assert.equal(L.slots.length, 512);
  for (let i = 1; i < L.slots.length; i++)
    assert.ok(L.slots[i].d >= L.slots[i - 1].d, 'slots must be distance-ordered');

  // Rank 0 must be the closest content slot there is - verified against an
  // independent scan rather than against a guessed radius.
  let best = Infinity;
  for (let y = -40; y <= 40; y++)
    for (let x = -40; x <= 40; x++)
      if (isContentSlot(x, y, { seed: 3, contentRatio: 0.2 })) best = Math.min(best, Math.hypot(x, y));
  assert.equal(L.slots[0].d, best);
});

test('the origin is the centre room, never a corpus slot', () => {
  const L = createLayout({ roomCount: 512, contentRatio: 0.9, seed: 3 });
  assert.equal(isContentSlot(0, 0, { seed: 3, contentRatio: 0.9 }), false);
  assert.ok(!L.slots.some((s) => s.x === 0 && s.y === 0));
  assert.deepEqual(L.roomAt(0, 0, shuffledOrder(512, 1)), { centre: true });
  assert.equal(L.rankOf(0, 0), -1);
});

test('slot positions are stable when the ranking changes', () => {
  const L = createLayout({ roomCount: 200, contentRatio: 0.2, seed: 11 });
  const before = L.slots.map((s) => `${s.x},${s.y}`);
  const orderA = shuffledOrder(200, 1);
  const orderB = shuffledOrder(200, 2);
  assert.notDeepEqual(orderA, orderB);
  // Re-ranking must not move slots - that is what makes the reorder read as
  // the library rearranging rather than reloading.
  assert.deepEqual(L.slots.map((s) => `${s.x},${s.y}`), before);
  const cell = L.cellOfRank(0);
  assert.equal(L.roomAt(cell.x, cell.y, orderA).id, orderA[0]);
  assert.equal(L.roomAt(cell.x, cell.y, orderB).id, orderB[0]);
});

test('same seed reproduces the same layout; different seed does not', () => {
  const a = createLayout({ roomCount: 100, contentRatio: 0.2, seed: 5 });
  const b = createLayout({ roomCount: 100, contentRatio: 0.2, seed: 5 });
  const c = createLayout({ roomCount: 100, contentRatio: 0.2, seed: 6 });
  assert.deepEqual(a.slots, b.slots);
  assert.notDeepEqual(a.slots, c.slots);
});

test('corpus size and ratio are runtime-tweakable without reloading data', () => {
  // Growing the corpus keeps existing slots in place and appends further out:
  // the point of tuning by feel is that the map does not reshuffle underneath.
  const small = createLayout({ roomCount: 100, contentRatio: 0.2, seed: 9 });
  const large = createLayout({ roomCount: 400, contentRatio: 0.2, seed: 9 });
  assert.deepEqual(large.slots.slice(0, 100), small.slots);
  assert.ok(large.boundaryRadius > small.boundaryRadius);

  // Loosening the ratio packs the same rooms into a tighter region.
  const dense = createLayout({ roomCount: 400, contentRatio: 0.5, seed: 9 });
  assert.ok(dense.boundaryRadius < large.boundaryRadius);
});

test('cells outside the corpus are generic', () => {
  const L = createLayout({ roomCount: 50, contentRatio: 0.2, seed: 2 });
  const order = shuffledOrder(50, 1);
  let generic = 0;
  for (let y = -6; y <= 6; y++)
    for (let x = -6; x <= 6; x++) if (L.roomAt(x, y, order).generic) generic++;
  assert.ok(generic > 0, 'most of the map is the base room');
  const far = L.roomAt(9999, 9999, order);
  assert.equal(far.generic, true);
});

test('resistance is flat inside the region and falls off outside', () => {
  const L = createLayout({ roomCount: 200, contentRatio: 0.2, seed: 4 });
  assert.equal(L.resistanceAt(0, 0), 1);
  const r = L.boundaryRadius;
  assert.equal(L.resistanceAt(r - 1, 0), 1);
  const just = L.resistanceAt(r + 3, 0);
  const far = L.resistanceAt(r + 11, 0);
  assert.ok(just < 1 && just > 0, `expected soft falloff, got ${just}`);
  assert.ok(far < just, 'resistance must keep increasing outward');
});

test('rejects nonsense parameters', () => {
  assert.throws(() => createLayout({ roomCount: -1 }), RangeError);
  assert.throws(() => createLayout({ roomCount: 10, contentRatio: 0 }), RangeError);
  assert.throws(() => createLayout({ roomCount: 10, contentRatio: 1.5 }), RangeError);
  assert.throws(() => createLayout({ roomCount: 10, aspect: 0 }), RangeError);
  assert.throws(() => createLayout({ roomCount: 10, aspect: -1 }), RangeError);
  assert.throws(() => createLayout({ roomCount: 10, aspect: Infinity }), RangeError);
});

// --- non-square cells ------------------------------------------------------

/** Cell shapes the layout has to stay round at. */
const ASPECTS = [
  { name: 'square', aspect: 1 },
  { name: '16:9', aspect: 720 / 1280 },
  { name: '3:4 tall', aspect: 1024 / 768 },
];

test('the edge is the same distance away whichever way you set off', () => {
  // The whole reason this module knows the aspect. Equal *apparent* distances
  // must resist equally, so navigation bounds are uniform rather than reaching
  // the edge sooner on the short axis.
  for (const { name, aspect } of ASPECTS) {
    const L = createLayout({ roomCount: 300, contentRatio: 0.2, seed: 5, aspect });
    const past = L.boundaryRadius + 6;

    const east = L.resistanceAt(past, 0);
    const south = L.resistanceAt(0, past / aspect); // the same apparent distance
    assert.ok(Math.abs(east - south) < 1e-12, `${name}: ${east} vs ${south}`);
    assert.ok(east < 1 && east > 0, `${name}: expected soft falloff, got ${east}`);
  }
});

test('a non-square cell resists differently per axis, in raw cell terms', () => {
  // The other side of the same coin, and the assertion that fails if the aspect
  // stops being applied: the same *cell* offset is a different apparent
  // distance on each axis, so it must not resist the same.
  const L = createLayout({ roomCount: 300, contentRatio: 0.2, seed: 5, aspect: 720 / 1280 });
  const past = L.boundaryRadius + 6;
  assert.notEqual(L.resistanceAt(past, 0), L.resistanceAt(0, past));
});

test('the rooms fill a circle on screen, not an ellipse', () => {
  // A circular boundary around an elliptical spread would be a circle with
  // nothing in the top and bottom of it, so placement uses the metric too.
  for (const { name, aspect } of ASPECTS) {
    const L = createLayout({ roomCount: 400, contentRatio: 0.25, seed: 3, aspect });
    const halfW = Math.max(...L.slots.map((s) => Math.abs(s.x)));
    const halfH = Math.max(...L.slots.map((s) => Math.abs(s.y * aspect)));
    assert.ok(
      Math.abs(halfW / halfH - 1) < 0.12,
      `${name}: ${halfW.toFixed(1)} wide by ${halfH.toFixed(1)} tall on screen`
    );
  }
});

test('round on screen means not round in the index', () => {
  // The measurement that shows the metric is doing something: a 16:9 cell
  // spreads the same rooms across far more rows than columns.
  const aspect = 720 / 1280;
  const L = createLayout({ roomCount: 400, contentRatio: 0.25, seed: 3, aspect });
  const cellsW = Math.max(...L.slots.map((s) => Math.abs(s.x)));
  const cellsH = Math.max(...L.slots.map((s) => Math.abs(s.y)));
  assert.ok(cellsH > cellsW * 1.5, `expected a taller spread in cells, got ${cellsW}x${cellsH}`);
});

test('a square cell is exactly the old behaviour', () => {
  // aspect defaults to 1, and 1 must change nothing - otherwise every existing
  // assertion in this file is quietly testing something else.
  const implicit = createLayout({ roomCount: 200, contentRatio: 0.2, seed: 11 });
  const explicit = createLayout({ roomCount: 200, contentRatio: 0.2, seed: 11, aspect: 1 });
  assert.deepEqual(explicit.slots, implicit.slots);
  assert.equal(explicit.boundaryRadius, implicit.boundaryRadius);
});

test('growing the corpus still keeps existing slots, at any cell shape', () => {
  // The property that makes the sliders usable, re-checked per shape: the
  // aspect is fixed for a given tile, so the ordering must stay stable under it.
  for (const { name, aspect } of ASPECTS) {
    const small = createLayout({ roomCount: 100, contentRatio: 0.2, seed: 9, aspect });
    const large = createLayout({ roomCount: 400, contentRatio: 0.2, seed: 9, aspect });
    assert.deepEqual(large.slots.slice(0, 100), small.slots, name);
    assert.ok(large.boundaryRadius > small.boundaryRadius, name);
  }
});

test('embedding ranking sorts by cosine similarity', () => {
  const dim = 4;
  // Room 1 is the exact match, room 0 orthogonal, room 2 opposed.
  const emb = Int8Array.from([0, 127, 0, 0, 127, 0, 0, 0, -127, 0, 0, 0]);
  const query = Float32Array.from([1, 0, 0, 0]);
  assert.deepEqual(rankByEmbedding(emb, dim, query), [1, 0, 2]);
});

test('shuffledOrder is a permutation and is seed-stable', () => {
  const a = shuffledOrder(500, 42);
  assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: 500 }, (_, i) => i));
  assert.deepEqual(a, shuffledOrder(500, 42));
  assert.notDeepEqual(a, shuffledOrder(500, 43));
});
