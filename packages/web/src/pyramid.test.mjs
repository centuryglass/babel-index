import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_ZOOM, MAX_ZOOM } from './camera.js';
import {
  PYRAMID,
  BASE_TILE,
  LEVELS,
  FALLBACK_LEVEL,
  HYSTERESIS,
  PREFETCH,
  createPyramid,
  budgetOf,
  bytesOf,
  sizeOf,
  totalBudgetBytes,
  idealLevel,
  pickLevel,
  bestAvailable,
  warmLevels,
  prefetchBounds,
} from './pyramid.js';

/** The largest viewport the budgets are sized against, in device pixels. */
const VIEWPORT = { w: 2560, h: 1440 };

/**
 * Tile shapes the policy has to work at. The point of the list is that none of
 * the rules below may depend on 1024, on a power of two, or on being square.
 */
const SHAPES = [
  { name: 'the current square tile', base: BASE_TILE },
  { name: 'a 16:9 wall', base: { w: 1280, h: 720 } },
  { name: 'a tall 3:4 tile', base: { w: 768, h: 1024 } },
  { name: 'a small square tile', base: { w: 512, h: 512 } },
  { name: 'an odd non-power-of-two tile', base: { w: 900, h: 675 } },
];

/**
 * Cells on screen when a tile is drawn `demand` device pixels wide, at the
 * aspect of `base`. A short tile fits more rows, so this moves with the shape -
 * which is exactly why the budget check recomputes it instead of trusting the
 * table in the comment.
 */
function cellsAt(demand, base) {
  const cellH = demand * (base.h / base.w);
  return (Math.ceil(VIEWPORT.w / demand) + 1) * (Math.ceil(VIEWPORT.h / cellH) + 1);
}

/** The smallest demand that still selects `level` - where it shows the most cells. */
function lowestDemandFor(p, level) {
  const i = p.levels.findIndex((l) => l.level === level);
  const coarser = p.levels[i + 1];
  // The coarsest level's band is open at the bottom; the camera's own clamp
  // closes it, at dpr 1 since that is the smallest device demand a zoom gives.
  return coarser ? p.sizeOf(coarser.level).w + 1 : MIN_ZOOM;
}

/** Every level some zoom within the camera's clamp can actually select. */
function reachableLevels(p) {
  const seen = new Set();
  for (const dpr of [1, 2])
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom++) seen.add(p.idealLevel(zoom * dpr));
  return seen;
}

// --- the ladder ------------------------------------------------------------

test('the ladder is contiguous and each rung is coarser than the last', () => {
  for (let i = 1; i < LEVELS.length; i++) {
    assert.equal(LEVELS[i].level, LEVELS[i - 1].level + 1, 'levels must be contiguous');
    assert.ok(LEVELS[i].divisor > LEVELS[i - 1].divisor, 'divisors must increase');
  }
  assert.equal(LEVELS[0].divisor, 1, 'level 0 is the source art, undivided');
  assert.equal(FALLBACK_LEVEL, LEVELS[LEVELS.length - 1].level);
});

test('sizes and byte costs are derived from the base tile, not written down', () => {
  // Changing BASE_TILE must move every derived number with it. If this ever
  // needs updating with a literal, something has been hard-coded again.
  for (const { base } of SHAPES) {
    const p = createPyramid({ base });
    assert.deepEqual(p.sizeOf(0), { w: base.w, h: base.h }, 'level 0 is the base tile itself');
    for (const { level, divisor } of p.levels) {
      assert.deepEqual(p.sizeOf(level), {
        w: Math.max(1, Math.round(base.w / divisor)),
        h: Math.max(1, Math.round(base.h / divisor)),
      });
      assert.equal(p.bytesOf(level), p.sizeOf(level).w * p.sizeOf(level).h * 4);
    }
  }
});

test('a tile keeps its aspect at every level', () => {
  for (const { name, base } of SHAPES) {
    const p = createPyramid({ base });
    const aspect = base.w / base.h;
    for (const { level } of p.levels) {
      const size = p.sizeOf(level);
      assert.ok(
        Math.abs(size.w / size.h - aspect) < 0.05,
        `${name}: level ${level} is ${size.w}x${size.h}, off the ${aspect.toFixed(3)} aspect`
      );
    }
  }
});

// --- selection -------------------------------------------------------------

test('a tile is never upscaled while a big enough level exists', () => {
  for (const { name, base } of SHAPES) {
    const p = createPyramid({ base });
    for (const { level } of p.levels) {
      const w = p.sizeOf(level).w;
      for (const demand of [w - 1, w]) {
        const chosen = p.sizeOf(p.idealLevel(demand)).w;
        assert.ok(chosen >= demand, `${name}: demand ${demand} chose ${chosen}, which upscales`);
      }
    }
  }
});

test('picking never overshoots to a level finer than needed', () => {
  // The whole point is bounded bytes: one pixel over a boundary must not jump
  // to the source art.
  for (const { name, base } of SHAPES) {
    const p = createPyramid({ base });
    for (let i = 1; i < p.levels.length; i++) {
      const w = p.sizeOf(p.levels[i].level).w;
      assert.equal(p.idealLevel(w), p.levels[i].level, `${name}: exactly ${w} should fit level ${i}`);
      assert.equal(p.idealLevel(w + 1), p.levels[i - 1].level, `${name}: ${w + 1} needs one finer`);
    }
  }
});

test('demand is measured in device pixels, so retina gets the finer level', () => {
  // The bug this pins: picking on CSS pixels ships half-resolution art to every
  // retina display, and looks fine to anyone developing on a 1x monitor.
  const zoom = 200;
  assert.ok(
    idealLevel(zoom * 2) < idealLevel(zoom * 1),
    'the same zoom at dpr 2 must select a finer level than at dpr 1'
  );
});

test('a cell whose shape differs from the tile is resolved on its hungrier axis', () => {
  // A wide tile drawn into a square cell is stretched vertically; choosing on
  // width alone would under-resolve the axis that was stretched.
  const base = { w: 1280, h: 720 };
  const p = createPyramid({ base });

  // A 300x300 cell holding a 16:9 tile stretches it to 1.78x its natural
  // height, so it needs a strictly finer level than a cell of the same width
  // that matches the aspect. Anything less than strict means the height was
  // ignored.
  const stretched = p.idealLevel({ w: 300, h: 300 });
  const matching = p.idealLevel({ w: 300, h: 300 * (base.h / base.w) });
  assert.ok(
    stretched < matching,
    `a stretched cell chose level ${stretched}, no finer than the aspect-matched ${matching}`
  );

  // And an aspect-matched cell is exactly the plain-width case, so passing a
  // rect is never worse than passing the number.
  assert.equal(p.idealLevel({ w: 300, h: 300 * (base.h / base.w) }), p.idealLevel(300));
});

test('every level is reachable within the camera clamp', () => {
  // A level nothing can select is dead weight in the pipeline and a lie in the
  // table. dpr 1 gives the smallest demand a zoom can produce, dpr 2 the
  // largest, so between them they cover everything the camera allows.
  for (const { name, base } of SHAPES) {
    const p = createPyramid({ base });
    const reachable = reachableLevels(p);
    for (const { level } of p.levels)
      assert.ok(reachable.has(level), `${name}: level ${level} (${p.sizeOf(level).w}px) is unreachable`);
  }
});

test('a tile too large for the camera to ever zoom into is reported', () => {
  // Not a hypothetical: at 4096 the source art can never be selected, because
  // MAX_ZOOM x dpr 2 does not reach half of it. The reachability test is what
  // says so, and this is the proof it is live rather than vacuously true.
  const p = createPyramid({ base: { w: 4096, h: 4096 } });
  assert.ok(!reachableLevels(p).has(0), 'level 0 at 4096 should be unreachable, and flagged');
});

test('the coarsest level is what the far-out view actually gets', () => {
  for (const { name, base } of SHAPES) {
    const p = createPyramid({ base });
    assert.equal(p.idealLevel(MIN_ZOOM), p.fallbackLevel, `${name}: fully zoomed out, dpr 1`);
  }
});

// --- hysteresis ------------------------------------------------------------

test('the first pick has no hysteresis to apply', () => {
  for (const { level } of LEVELS) assert.equal(pickLevel(sizeOf(level).w, null), level);
});

test('a zoom held near a boundary does not oscillate', () => {
  // The failure this prevents: every switch is a full screen of fetches, so a
  // level flickering with the jitter of a trackpad is a fetch storm.
  for (const { name, base } of SHAPES) {
    const p = createPyramid({ base });
    const boundary = p.sizeOf(p.levels[3].level).w;
    let current = p.idealLevel(boundary);
    const before = current;
    for (const jitter of [0.99, 1.01, 0.98, 1.02, 1.0, 1.03, 0.97]) {
      current = p.pickLevel(boundary * jitter, current);
      assert.equal(current, before, `${name}: jitter x${jitter} switched level`);
    }
  }
});

test('a deliberate zoom does cross, once it is clear of the boundary', () => {
  const boundary = sizeOf(3).w;
  const start = pickLevel(boundary, null);
  assert.equal(pickLevel(boundary * (1 + HYSTERESIS) + 1, start), start - 1, 'zooming in');

  const coarseStart = pickLevel(boundary + 1, null);
  assert.equal(
    pickLevel(boundary / (1 + HYSTERESIS) - 1, coarseStart),
    coarseStart + 1,
    'zooming out'
  );
});

test('a big jump lands on the true level, not one step toward it', () => {
  // Creeping a level per frame would show four wrong resolutions on the way to
  // the right one.
  assert.equal(pickLevel(BASE_TILE.w, FALLBACK_LEVEL), 0);
  assert.equal(pickLevel(MIN_ZOOM, 0), FALLBACK_LEVEL);
});

// --- rule 1: never blank ---------------------------------------------------

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

// --- rule 2: load ahead ----------------------------------------------------

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

// --- rule 3: budgets -------------------------------------------------------

test('every budget holds at least one worst-case screen, plus its prefetch ring', () => {
  // A cache that cannot hold one screen evicts tiles it is still drawing and
  // thrashes within a single frame. This is the assertion that stops a budget
  // from being tuned down into that state - or left behind when the tile shape
  // changes, since a shorter tile fits more rows on the same screen.
  for (const { level } of LEVELS) {
    const demand = lowestDemandFor(PYRAMID, level);
    const visible = cellsAt(demand, BASE_TILE);
    const ring = 2 * PREFETCH.margin * (VIEWPORT.w + VIEWPORT.h) / demand;
    assert.ok(
      budgetOf(level) >= visible + ring,
      `level ${level} (${sizeOf(level).w}px) budget ${budgetOf(level)} < ` +
        `${Math.ceil(visible + ring)} needed for ${visible} visible cells at ${demand}px wide`
    );
  }
});

test('the worst-case screen tracks the tile shape', () => {
  // The budget check above is only meaningful if its input moves with the tile.
  // A 16:9 tile is short, so more rows fit and more cells are on screen at the
  // same width - which is what would silently invalidate the budgets.
  const square = cellsAt(64, { w: 1024, h: 1024 });
  const wide = cellsAt(64, { w: 1280, h: 720 });
  assert.ok(wide > square, 'a shorter tile must report more cells per screen');
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

test('the memory cost of a full pyramid is derived, and finite', () => {
  const total = totalBudgetBytes();
  const sum = LEVELS.reduce((n, l) => n + budgetOf(l.level) * bytesOf(l.level), 0);
  assert.equal(total, sum);
  assert.ok(total > 0);
});

test('CACHE_SCALE moves every budget together and never reaches zero', () => {
  const half = createPyramid({ cacheScale: 0.5 });
  const full = createPyramid({ cacheScale: 1 });
  for (const { level } of LEVELS)
    assert.equal(half.budgetOf(level), Math.round(full.budgetOf(level) * 0.5));

  const tiny = createPyramid({ cacheScale: 0.0001 });
  for (const { level } of LEVELS)
    assert.ok(tiny.budgetOf(level) >= 1, 'a budget of zero would disable a level entirely');
});
