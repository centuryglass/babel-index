import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellDistance,
  cellHash,
  createLayout,
  embeddingScores,
  isContentSlot,
  rankByEmbedding,
  shuffledOrder,
} from './ordering.js';

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

// --- the search density gradient -------------------------------------------

/** A layout with a certainty profile, holding everything else steady. */
const graded = (certainty, opts = {}) =>
  createLayout({
    roomCount: 200,
    contentRatio: 0.1,
    seed: 17,
    ...opts,
    density: certainty ? { certainty, ...(opts.density ?? {}) } : null,
  });

/** Slots within a given radius - the measurement local density is read from. */
const within = (L, r) => L.slots.filter((s) => s.d <= r).length;

test('no certainty is the uniform map, cell for cell', () => {
  // The property the whole design leans on: clearing the search restores the
  // old layout exactly, so there is no second code path to keep in step.
  const uniform = graded(null);
  assert.deepEqual(graded(new Float32Array(200)).slots, uniform.slots, 'all-zero clusters nothing');
  assert.equal(uniform.gradedCount, 0);

  // And a query nothing is confident about is the same picture as no query,
  // which is the only honest thing for it to look like.
  const hunch = Float32Array.from({ length: 200 }, (_, i) => 0.04 * Math.exp(-i / 50));
  assert.deepEqual(graded(hunch).slots, uniform.slots, 'a hunch under the floor is not a match');
  assert.equal(graded(hunch).gradedCount, 0);
});

test('certain ranks take the cells nearest the centre', () => {
  // Five exact matches, at peak density: they should land in the five nearest
  // cells there are, not the five nearest cells the hash allows.
  const certainty = Float32Array.from({ length: 200 }, (_, i) => (i < 5 ? 1 : 0));
  const L = graded(certainty, { aspect: 1 });

  const nearest = [];
  for (let y = -3; y <= 3; y++)
    for (let x = -3; x <= 3; x++)
      if (x || y) nearest.push({ x, y, d: Math.hypot(x, y), a: Math.atan2(y, x) });
  nearest.sort((p, q) => p.d - q.d || p.a - q.a);

  assert.deepEqual(
    L.slots.slice(0, 5).map((s) => `${s.x},${s.y}`),
    nearest.slice(0, 5).map((s) => `${s.x},${s.y}`)
  );
  assert.equal(L.gradedCount, 5);
});

test('a hard-edged match clusters, and everything after it does not', () => {
  // "yuiop": a handful of rooms tagged with it, and nothing else means a thing.
  // The cluster is dense; past it the map is the baseline scatter it always was.
  const certainty = Float32Array.from({ length: 200 }, (_, i) => (i < 8 ? 1 : 0));
  const L = graded(certainty);
  const uniform = graded(null);

  const core = L.slots[7].d;
  assert.ok(within(uniform, core) < 3, `baseline holds ${within(uniform, core)} rooms that close in`);

  // Beyond the cluster the local density is back to contentRatio: the same
  // number of rooms per unit area as the map with no search at all.
  const ring = (M) => M.slots.filter((s) => s.d > core + 4 && s.d <= core + 10).length;
  assert.ok(
    Math.abs(ring(L) - ring(uniform)) <= Math.max(2, ring(uniform) * 0.25),
    `outside the cluster: ${ring(L)} vs ${ring(uniform)}`
  );
});

test('a gradual certainty spreads the packing out gradually', () => {
  // "red": CLIP's confidence falls off smoothly, so the density should too -
  // measurably tighter than the hard-edged case at every radius past the core.
  const hard = graded(Float32Array.from({ length: 200 }, (_, i) => (i < 8 ? 1 : 0)));
  const soft = graded(Float32Array.from({ length: 200 }, (_, i) => Math.exp(-i / 60)));
  const uniform = graded(null);

  for (const r of [12, 16, 20]) {
    assert.ok(
      within(soft, r) > within(hard, r),
      `r=${r}: gradual ${within(soft, r)} should hold more than hard-edged ${within(hard, r)}`
    );
    assert.ok(within(hard, r) > within(uniform, r), `r=${r}: both must beat the baseline`);
  }
  // A gradient adds density and never takes any away, so the library can only
  // contract - the edge never runs away from a search.
  assert.ok(soft.boundaryRadius < hard.boundaryRadius);
  assert.ok(hard.boundaryRadius <= uniform.boundaryRadius);
});

test('certainty cannot rise with rank', () => {
  // The ordering claims to be best-first, so a rank more certain than the one
  // above it is a contradiction; the running minimum is which to believe.
  const rising = Float32Array.from([1, 0.2, 0.9, 0.9, 0.9, ...new Array(195).fill(0)]);
  const clamped = Float32Array.from([1, 0.2, 0.2, 0.2, 0.2, ...new Array(195).fill(0)]);
  assert.deepEqual(graded(rising).slots, graded(clamped).slots);
});

test('the peak is how much wallpaper survives the surest cluster', () => {
  const certainty = Float32Array.from({ length: 200 }, (_, i) => (i < 20 ? 1 : 0));
  const full = graded(certainty, { density: { peak: 1 } });
  const half = graded(certainty, { density: { peak: 0.5 } });
  assert.ok(full.slots[19].d < half.slots[19].d, 'a lower peak packs the same rooms less tightly');
  assert.ok(half.slots[19].d < graded(null).slots[19].d, 'but still tighter than no gradient');
});

test('a sparser map makes the same search more legible, not less', () => {
  // The point of the feature. The cluster is the same size whatever the ratio,
  // so the sparser the wallpaper the more it stands out against it.
  const certainty = Float32Array.from({ length: 200 }, (_, i) => (i < 10 ? 1 : 0));
  const radii = [0.05, 0.2, 0.6].map((contentRatio) => graded(certainty, { contentRatio }).slots[9].d);
  for (let i = 1; i < radii.length; i++)
    assert.ok(Math.abs(radii[i] - radii[0]) < 1e-9, `cluster moved with the ratio: ${radii}`);
});

test('growing the corpus still keeps existing slots under a gradient', () => {
  // The slider property, re-checked with a profile in play: acceptance for a
  // rank depends only on that rank and the cells before it, so a longer corpus
  // extends the walk rather than redoing it.
  const certainty = Float32Array.from({ length: 400 }, (_, i) => Math.exp(-i / 40));
  const small = graded(certainty.slice(0, 100), { roomCount: 100 });
  const large = graded(certainty, { roomCount: 400 });
  assert.deepEqual(large.slots.slice(0, 100), small.slots);
});

test('the pruned sweep places rooms exactly where an unpruned walk would', () => {
  // collectSlots filters the far field at the baseline rather than at the peak,
  // which is what keeps a search on a sparse map as cheap as no search at all.
  // It is sound only because the graded ranks are checked to have landed inside
  // the core; this is that claim, tested against the walk it stands in for.
  let rng = 12345;
  const rand = () => ((rng = Math.imul(rng ^ (rng >>> 15), 0x2c1b3c6d) >>> 0) / 4294967296);

  for (let trial = 0; trial < 40; trial++) {
    const roomCount = 1 + Math.floor(rand() * 120);
    const contentRatio = [0.03, 0.1, 0.4, 1][Math.floor(rand() * 4)];
    const aspect = [1, 0.75, 1.4][Math.floor(rand() * 3)];
    const seed = Math.floor(rand() * 50);
    const peak = [1, 0.9, 0.4][Math.floor(rand() * 3)];
    const shape = Math.floor(rand() * 4);
    const certainty = Float32Array.from({ length: roomCount }, (_, i) =>
      shape === 0 ? (i < 3 ? 1 : 0)
      : shape === 1 ? Math.exp(-i / (2 + rand() * 30))
      : shape === 2 ? rand()
      : Math.max(0, 1 - i / roomCount)
    );
    const opts = { roomCount, contentRatio, seed, aspect };
    const got = createLayout({ ...opts, density: { certainty, peak } }).slots;
    const want = unprunedWalk({ ...opts, certainty, peak });
    assert.deepEqual(
      got.map((s) => `${s.x},${s.y}`),
      want,
      `trial ${trial}: ${JSON.stringify({ ...opts, peak, shape })}`
    );
  }
});

/**
 * Every cell in a generously wide radius, walked outward, each offered to the
 * rank being placed at that rank's own threshold. The definition the optimised
 * sweep has to agree with, written the slow obvious way.
 */
function unprunedWalk({ roomCount, contentRatio, seed, aspect, certainty, peak, floor = 0.05 }) {
  const ramp = [];
  let cap = 1;
  for (let i = 0; i < roomCount; i++) {
    cap = Math.min(cap, Math.max(0, Math.min(1, certainty[i])));
    ramp.push(cap < floor ? contentRatio : contentRatio + (Math.max(peak, contentRatio) - contentRatio) * cap);
  }

  const R = Math.ceil(Math.sqrt((roomCount * aspect) / (contentRatio * Math.PI)) * 3) + 20;
  const cells = [];
  for (let y = -Math.ceil(R / aspect); y <= Math.ceil(R / aspect); y++)
    for (let x = -Math.ceil(R); x <= Math.ceil(R); x++) {
      if (!x && !y) continue;
      const d = cellDistance(x, y, aspect);
      if (d <= R) cells.push({ x, y, d, h: cellHash(x, y, seed), a: Math.atan2(y * aspect, x) });
    }
  cells.sort((p, q) => p.d - q.d || p.a - q.a);

  const found = [];
  for (const c of cells) {
    if (c.h >= (ramp[found.length] ?? contentRatio)) continue;
    found.push(`${c.x},${c.y}`);
    if (found.length === roomCount) break;
  }
  return found;
}

test('embedding ranking sorts by cosine similarity', () => {
  const dim = 4;
  // Room 1 is the exact match, room 0 orthogonal, room 2 opposed.
  const emb = Int8Array.from([0, 127, 0, 0, 127, 0, 0, 0, -127, 0, 0, 0]);
  const query = Float32Array.from([1, 0, 0, 0]);
  assert.deepEqual(rankByEmbedding(emb, dim, query), [1, 0, 2]);
});

test('embedding scores are cosines, not quantised dot products', () => {
  // The density gradient reads these against absolute thresholds, so the int8
  // scale has to be divided back out here rather than assumed away downstream.
  const emb = Int8Array.from([127, 0, 0, 127, -127, 0]);
  const scores = embeddingScores(emb, 2, Float32Array.from([1, 0]));
  assert.ok(Math.abs(scores[0] - 1) < 1e-6, `a unit match must be 1, got ${scores[0]}`);
  assert.ok(Math.abs(scores[1]) < 1e-6);
  assert.ok(Math.abs(scores[2] + 1) < 1e-6);
});

test('shuffledOrder is a permutation and is seed-stable', () => {
  const a = shuffledOrder(500, 42);
  assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: 500 }, (_, i) => i));
  assert.deepEqual(a, shuffledOrder(500, 42));
  assert.notDeepEqual(a, shuffledOrder(500, 43));
});
