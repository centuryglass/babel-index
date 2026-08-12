import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_ZOOM, MAX_ZOOM } from './camera.js';
import {
  LEVELS,
  FALLBACK_LEVEL,
  HYSTERESIS,
  PREFETCH,
  budgetOf,
  sizeOf,
  idealLevel,
  pickLevel,
  bestAvailable,
  warmLevels,
  prefetchBounds,
} from './pyramid.js';

/** The largest viewport the budgets are sized against, in device pixels. */
const VIEWPORT = { w: 2560, h: 1440 };

/** Cells on screen when each tile covers `demand` device pixels. */
const cellsAt = (demand) =>
  (Math.ceil(VIEWPORT.w / demand) + 1) * (Math.ceil(VIEWPORT.h / demand) + 1);

/** The smallest demand that still selects `level` - where it shows the most cells. */
function lowestDemandFor(level) {
  const i = LEVELS.findIndex((l) => l.level === level);
  const coarser = LEVELS[i + 1];
  // The coarsest level's band is open at the bottom; the camera's own clamp
  // closes it, at dpr 1 since that is the smallest device demand a zoom gives.
  return coarser ? coarser.size + 1 : MIN_ZOOM;
}

test('the ladder is ordered finest-first and halves each step', () => {
  for (let i = 1; i < LEVELS.length; i++) {
    assert.equal(LEVELS[i].level, LEVELS[i - 1].level + 1, 'levels must be contiguous');
    assert.ok(LEVELS[i].size < LEVELS[i - 1].size, 'sizes must decrease');
  }
  assert.equal(FALLBACK_LEVEL, LEVELS[LEVELS.length - 1].level);
});

test('a tile is never upscaled while a big enough level exists', () => {
  for (const { size } of LEVELS)
    for (const demand of [size - 1, size]) {
      const chosen = sizeOf(idealLevel(demand));
      assert.ok(chosen >= demand, `demand ${demand} chose ${chosen}, which upscales`);
    }
});

test('picking never overshoots to a level finer than needed', () => {
  // 65 device pixels needs 128, not 1024: the whole point is bounded bytes.
  assert.equal(sizeOf(idealLevel(65)), 128);
  assert.equal(sizeOf(idealLevel(64)), 64);
  assert.equal(sizeOf(idealLevel(257)), 512);
});

test('every level is reachable within the camera clamp', () => {
  // A level nothing can select is dead weight in the pipeline and a lie in the
  // table. dpr 1 gives the smallest demand a zoom can produce, dpr 2 the
  // largest, so between them they cover everything the camera allows.
  const reachable = new Set();
  for (const dpr of [1, 2])
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom++) reachable.add(idealLevel(zoom * dpr));

  for (const { level, size } of LEVELS)
    assert.ok(reachable.has(level), `level ${level} (${size}px) can never be selected`);
});

test('the coarsest level is what the far-out view actually gets', () => {
  assert.equal(idealLevel(MIN_ZOOM * 1), FALLBACK_LEVEL, 'fully zoomed out, dpr 1');
});

test('every budget holds at least one worst-case screen, plus its prefetch ring', () => {
  // A cache that cannot hold one screen evicts tiles it is still drawing and
  // thrashes within a single frame. This is the assertion that stops a budget
  // from being tuned down into that state by accident.
  for (const { level, size } of LEVELS) {
    const demand = lowestDemandFor(level);
    const visible = cellsAt(demand);
    const withRing = cellsAt(demand) + 2 * PREFETCH.margin * (VIEWPORT.w + VIEWPORT.h) / demand;
    assert.ok(
      budgetOf(level) >= withRing,
      `level ${level} (${size}px) budget ${budgetOf(level)} < ${Math.ceil(withRing)} ` +
        `needed for ${visible} visible cells at ${demand}px/tile`
    );
  }
});

test('coarse levels are budgeted more generously than fine ones', () => {
  // Rule 3, and rule 1 depends on it: the coarse field is what every finer
  // level falls back to, so it must not be the first thing evicted.
  for (let i = 1; i < LEVELS.length; i++)
    assert.ok(
      budgetOf(LEVELS[i].level) > budgetOf(LEVELS[i - 1].level),
      `level ${LEVELS[i].level} must hold more than ${LEVELS[i - 1].level}`
    );
});

test('the first pick has no hysteresis to apply', () => {
  for (const { level, size } of LEVELS) assert.equal(pickLevel(size, null), level);
});

test('a zoom held near a boundary does not oscillate', () => {
  // The failure this prevents: every switch is a full screen of fetches, so a
  // level flickering with the jitter of a trackpad is a fetch storm.
  const boundary = 128;
  let current = idealLevel(boundary);
  const before = current;
  for (const jitter of [0.99, 1.01, 0.98, 1.02, 1.0, 1.03, 0.97]) {
    current = pickLevel(boundary * jitter, current);
    assert.equal(current, before, `jitter x${jitter} switched level`);
  }
});

test('a deliberate zoom does cross, once it is clear of the boundary', () => {
  const start = pickLevel(128, null);
  assert.equal(pickLevel(128 * (1 + HYSTERESIS) + 1, start), start - 1, 'zooming in');

  const coarseStart = pickLevel(129, null);
  assert.equal(pickLevel(128 / (1 + HYSTERESIS) - 1, coarseStart), coarseStart + 1, 'zooming out');
});

test('a big jump lands on the true level, not one step toward it', () => {
  // Creeping a level per frame would show four wrong resolutions on the way to
  // the right one.
  assert.equal(pickLevel(1024, FALLBACK_LEVEL), 0);
  assert.equal(pickLevel(MIN_ZOOM, 0), FALLBACK_LEVEL);
});

test('the wanted level is used when it is ready', () => {
  assert.equal(bestAvailable((l) => l === 2, 2), 2);
});

test('a missing level falls back to the nearest coarser one', () => {
  const ready = new Set([3, 4]);
  assert.equal(bestAvailable((l) => ready.has(l), 1), 3, 'nearest coarser, not the coarsest');
});

test('a finer level is used only when nothing coarser exists', () => {
  const ready = new Set([0, 1]);
  assert.equal(bestAvailable((l) => ready.has(l), 3), 1, 'nearest finer');
});

test('coarser is preferred over finer even when both are ready', () => {
  const ready = new Set([0, 4]);
  assert.equal(bestAvailable((l) => ready.has(l), 2), 4);
});

test('nothing available is the only way to report nothing', () => {
  assert.equal(bestAvailable(() => false, 0), null);
  // Rule 1 in one line: if any level of the room is resident, something draws.
  for (const { level } of LEVELS)
    for (const { level: want } of LEVELS)
      assert.notEqual(bestAvailable((l) => l === level, want), null, `${level} unusable for ${want}`);
});

test('warming reaches one level coarser, and stops at the bottom', () => {
  assert.deepEqual(warmLevels(0), [1]);
  assert.deepEqual(warmLevels(FALLBACK_LEVEL), [], 'nothing is coarser than the fallback');
});

test('the prefetch ring surrounds the viewport on every side', () => {
  const bounds = { x0: -3, y0: 0, x1: 4, y1: 6 };
  const ring = prefetchBounds(bounds, 2);
  assert.deepEqual(ring, { x0: -5, y0: -2, x1: 6, y1: 8 });

  const wide = (b) => b.x1 - b.x0 + 1;
  assert.ok(wide(ring) > wide(bounds), 'the ring must be larger than what it surrounds');
});
