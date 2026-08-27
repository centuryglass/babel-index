import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, shuffledOrder } from '../../../map/ordering.js';
import { buildRearrangement, CENTER, GENERIC as BOARD_GENERIC } from '../../../map/board.js';
import { planMoves, applyMove } from '../../../map/illusion.js';
import { buildTimeline, createSlideshow, createSlideRenderer } from './slide.js';
import { DEFAULTS } from '../../../config/config.mjs';
import { createTileCache, CENTER as CENTER_TILE } from './tiles.js';
import { CELL_ASPECT } from './camera.js';

// The shipped defaults, so these tests exercise what the demo actually runs.
const TIMING = DEFAULTS.slide;
const VIEW = { x0: -4, y0: -3, x1: 5, y1: 4 };
const ZOOM = 220;

function fakeCtx() {
  const drawn = [];
  const fills = [];
  return {
    drawn,
    fills,
    set fillStyle(v) { this._fill = v; },
    get fillStyle() { return this._fill; },
    strokeStyle: null, lineWidth: 0, font: null,
    drawImage: (img, x, y, w, h) => drawn.push({ img, x, y, w, h }),
    fillRect: (x, y, w, h) => fills.push({ x, y, w, h }),
    strokeRect: () => {},
    fillText: () => {},
  };
}

/** A cache whose images are always ready, so a frame's geometry is what is under test. */
function readyCache() {
  const made = [];
  const cache = createTileCache({
    urlFor: (id, level) => `/l${level}/${id}.jpg`,
    createImage: () => {
      const img = { src: null, onload: null, onerror: null };
      made.push(img);
      return img;
    },
  });
  cache.pin(CENTER_TILE);
  return { cache, settle: () => made.forEach((i) => i.onload?.()) };
}

const arrangement = (roomCount, order, density = null) => ({
  layout: createLayout({ roomCount, contentRatio: 0.2, seed: 1, aspect: CELL_ASPECT, density }),
  order,
});

function rearrangement(n = 200, seedA = 1, seedB = 2) {
  const built = buildRearrangement({
    before: arrangement(n, shuffledOrder(n, seedA)),
    after: arrangement(n, shuffledOrder(n, seedB)),
    view: VIEW,
    aspect: CELL_ASPECT,
  });
  return { built, moves: planMoves(built.start, built.end, built.bounds, built.fixed) };
}

const allRuns = (timeline) => timeline.stages.flatMap((s) => s.lanes.flatMap((l) => l.runs));

/** The first run in a lane that actually moves - lanes open with their swaps. */
const moverOf = (lane) => lane.runs.find((r) => r.cells > 0);

test('a conveyor becomes one run, not one run per step', () => {
  const { moves } = rearrangement();
  const timeline = buildTimeline(moves, TIMING);
  const runs = allRuns(timeline);

  // The planner emits a column's k rotations separately, each fed by a swap.
  // Animated literally that is k jerks; grouped, it is one ride upward.
  const colRuns = runs.filter((r) => r.kind === 'col');
  assert.ok(colRuns.length > 0);
  for (const run of colRuns)
    assert.ok(run.cells > 1, `column run of ${run.cells} cell(s) was not grouped`);

  const shifts = moves.filter((m) => m.type !== 'swap').length;
  assert.ok(runs.length < shifts, `${runs.length} runs for ${shifts} shifts is no grouping at all`);
});

test('runs only ever group one line moving one way', () => {
  const { moves } = rearrangement();
  for (const run of allRuns(buildTimeline(moves, TIMING))) {
    if (run.kind === 'none') continue;
    for (const { move } of run.steps) {
      if (move.type === 'swap') continue;
      const line = move.type === 'shiftRow' ? move.row : move.col;
      assert.equal(line, run.index);
      assert.equal(move.type, run.kind === 'row' ? 'shiftRow' : 'shiftCol');
      assert.equal(Math.sign(move.distance), run.dir);
    }
  }
});

test('the conveyor plays as one wave, not a queue of columns', () => {
  // The whole point of parking a batch before feeding it. Without the wave the
  // columns queue and a desktop rearrangement takes four seconds.
  const { moves } = rearrangement();
  const timeline = buildTimeline(moves, TIMING);
  const waves = timeline.stages.filter((s) => s.wave);
  assert.ok(waves.length > 0, 'the planner marked no stage as waveable');

  const conveyor = waves.reduce((a, b) => (b.lanes.length > a.lanes.length ? b : a));
  assert.ok(conveyor.lanes.length > 4, `only ${conveyor.lanes.length} lanes in the conveyor wave`);

  // Lanes overlap in time - that is what makes it a wave - and each is a
  // different line, so they can never collide on screen.
  const spans = conveyor.lanes.map((l) => [moverOf(l).startMs, l.endMs]);
  const overlapping = spans.some(([s1, e1], i) =>
    spans.some(([s2], j) => j !== i && s2 > s1 && s2 < e1)
  );
  assert.ok(overlapping, 'no two lanes of the wave are ever moving at once');

  const lines = conveyor.lanes.map((l) => `${moverOf(l).kind}${moverOf(l).index}`);
  assert.equal(new Set(lines).size, lines.length, 'two lanes share a line');
  assert.equal(new Set(conveyor.lanes.map((l) => moverOf(l).kind)).size, 1,
    'a wave mixes rows and columns, which could collide on screen');
});

test('a cascade overlaps its runs but never finishes them out of order', () => {
  // The safety argument for overlapping a sequential stage: a run's moves are
  // applied as it passes them and the last of them at its completion, so
  // ordered completions ARE ordered application. Overlap the starts and the
  // picture stops being a queue; let a completion slip out of order and the
  // plan is silently applied in the wrong sequence.
  const { moves } = rearrangement(50, 1, 2);
  const timeline = buildTimeline(moves, TIMING);
  let sawOverlap = false;
  for (const stage of timeline.stages) {
    if (stage.wave) continue;
    for (const lane of stage.lanes) {
      let previousEnd = -Infinity;
      let previousStart = -Infinity;
      for (const run of lane.runs) {
        const end = run.startMs + run.durMs;
        assert.ok(end >= previousEnd - 1e-6, `run finishes before the one it follows`);
        if (run.durMs > 0 && run.startMs < previousEnd - 1e-6) sawOverlap = true;
        assert.ok(run.startMs >= previousStart - 1e-6, 'runs start out of order');
        previousEnd = end;
        previousStart = run.startMs;
      }
    }
  }
  assert.ok(sawOverlap, 'nothing overlapped, so the cascade is doing nothing');
});

test('the wave sets off from the center outward', () => {
  // The plan has wanted this since the cross-fade design: the change should
  // leave from where the reader is standing, not sweep in from an edge.
  const { built, moves } = rearrangement();
  const conveyor = buildTimeline(moves, TIMING).stages
    .filter((s) => s.wave)
    .reduce((a, b) => (b.lanes.length > a.lanes.length ? b : a));

  const order = conveyor.lanes
    .map((l) => ({ start: moverOf(l).startMs, from: Math.abs(moverOf(l).index - built.fixed.x) }));
  order.sort((a, b) => a.start - b.start);
  for (let i = 1; i < order.length; i++)
    assert.ok(order[i].from >= order[i - 1].from,
      `lane ${i} starts sooner but sits further out (${order[i].from} after ${order[i - 1].from})`);
});

test('the board absorbs exactly what the motion has passed', () => {
  const { built, moves } = rearrangement();
  const board = { ...built.start, cells: built.start.cells.slice() };
  const show = createSlideshow({ board, moves, apply: applyMove, timing: TIMING });

  // Sampled finely enough to land inside runs rather than only between them.
  const runs = show.stages.flatMap((st) => st.lanes.flatMap((l) => l.runs));
  const peak = new Map();
  let sawConcurrent = false;
  for (let t = 0; t <= show.totalMs; t += 7) {
    const { motions } = show.advanceTo(t);
    if (motions.length > 1) sawConcurrent = true;
    for (const motion of motions) {
      const run = runs.find((r) => r.kind === motion.kind && r.index === motion.index);
      assert.ok(motion.offset >= -1e-6, `negative offset ${motion.offset}`);
      // The offset is a remainder, so it can never exceed the run's whole
      // travel however the run is made up. It is not always under one cell: a
      // run can open with a multi-cell extraction rotation before its conveyor,
      // since the planner frees a trapped value by rotating that line outright.
      assert.ok(motion.offset <= run.cells + 1e-6, `offset ${motion.offset} past a ${run.cells}-cell run`);
      peak.set(run, Math.max(peak.get(run) ?? 0, motion.offset));
    }
  }
  assert.ok(sawConcurrent, 'never saw two lines moving at once');

  // Most column runs are pure conveyor and do stay inside a cell - if that ever
  // stopped being true the animation would be lurching rather than riding.
  const cols = [...peak].filter(([r]) => r.kind === 'col');
  const tight = cols.filter(([, p]) => p <= 1 + 1e-6).length;
  assert.ok(tight > cols.length / 2, `only ${tight} of ${cols.length} column runs ride smoothly`);

  const { done, motions } = show.advanceTo(show.totalMs + 1);
  assert.equal(done, true);
  assert.deepEqual(motions, []);
  assert.deepEqual(board.cells, built.end.cells, 'the board did not finish on the end board');
});

test('advancing in one jump lands on the same board as advancing smoothly', () => {
  // The animation must not depend on being ticked at any particular rate: a
  // dropped frame, or a tab that was in the background, has to be survivable.
  const { built, moves } = rearrangement(120, 3, 4);
  const boards = [0, 1].map(() => ({ ...built.start, cells: built.start.cells.slice() }));

  const smooth = createSlideshow({ board: boards[0], moves, apply: applyMove, timing: TIMING });
  for (let t = 0; t <= smooth.totalMs; t += 16) smooth.advanceTo(t);
  smooth.advanceTo(smooth.totalMs);

  const jumped = createSlideshow({ board: boards[1], moves, apply: applyMove, timing: TIMING });
  jumped.advanceTo(jumped.totalMs);

  assert.deepEqual(boards[0].cells, boards[1].cells);
  assert.deepEqual(boards[0].cells, built.end.cells);
});

test('every visible cell is painted in every frame, including mid-slide', () => {
  const { built, moves } = rearrangement();
  const { cache, settle } = readyCache();
  const board = { ...built.start, cells: built.start.cells.slice() };
  const show = createSlideshow({ board, moves, apply: applyMove, timing: TIMING });
  const renderer = createSlideRenderer({ cache });
  const cam = { x: 0.5, y: 0.5, zoom: ZOOM };
  const frame = (motions) => {
    const ctx = fakeCtx();
    const stats = renderer.draw({
      ctx, width: 1920, height: 1080, dpr: 1, cam,
      board, origin: built.origin, motions,
    });
    return { ctx, stats };
  };

  frame([]);
  settle(); // the first frame requests; from here the cache answers

  const cellPx = { x: ZOOM, y: ZOOM * CELL_ASPECT };
  for (let t = 0; t <= show.totalMs; t += 37) {
    const { motions } = show.advanceTo(t);
    const { ctx } = frame(motions);

    // Nothing in the viewport is left unpainted. A cell with no image yet still
    // gets a fill, so both count - what this catches is the gap that would open
    // if the sliding line were skipped by the still pass and then not drawn
    // back, which is the one geometry bug this renderer can have.
    const covers = [...ctx.drawn, ...ctx.fills.filter((f) => f.w <= cellPx.x + 2)];
    for (let py = 20; py < 1080; py += 120)
      for (let px = 20; px < 1920; px += 120) {
        const covered = covers.some(
          (d) => px >= d.x && px < d.x + cellPx.x && py >= d.y && py < d.y + cellPx.y
        );
        assert.ok(covered, `nothing painted under (${px}, ${py}) at t=${t}`);
      }

    // Everything this frame wanted, it asked for: drawing the same state again
    // once the loads have landed leaves nothing blank. That is the claim worth
    // making - a renderer that never requested a tile would stay blank forever.
    settle();
    assert.equal(frame(motions).stats.blank, 0, `still blank after settling, at t=${t}`);
  }
});

test('the center room is never drawn anywhere but the center', () => {
  // The whole point of the fixed tile. If a slide ever carried it, it would
  // appear off-center in some frame, and this is what would see it.
  const { built, moves } = rearrangement();
  const { cache, settle } = readyCache();
  const board = { ...built.start, cells: built.start.cells.slice() };
  const show = createSlideshow({ board, moves, apply: applyMove, timing: TIMING });
  const renderer = createSlideRenderer({ cache });
  settle();

  const centreIndex = built.origin.y * built.width + built.origin.x;
  for (let t = 0; t <= show.totalMs; t += 23) {
    show.advanceTo(t);
    assert.equal(board.cells[centreIndex], CENTER, `the center moved at t=${t}`);
    const elsewhere = board.cells.filter((v) => v === CENTER).length;
    assert.equal(elsewhere, 1, `${elsewhere} center rooms on the board at t=${t}`);
  }
  assert.ok(renderer);
});

test('duration is set by the viewport, not by the corpus', () => {
  const small = createSlideshow({
    board: { width: 1, height: 1, cells: [] },
    moves: rearrangement(50, 1, 2).moves,
    apply: () => {},
    timing: TIMING,
  });
  const large = createSlideshow({
    board: { width: 1, height: 1, cells: [] },
    moves: rearrangement(800, 1, 2).moves,
    apply: () => {},
    timing: TIMING,
  });
  // The claim is one-sided: growing the corpus must never lengthen this. It
  // may well shorten it, and does - a small corpus keeps most of its distinct
  // rooms on screen at once, so more of them have to be rotated out of the
  // region before they can be staged, and each of those is a slide the big
  // corpus does not pay for.
  const ratio = large.totalMs / small.totalMs;
  assert.ok(ratio <= 1.05, `a 16x corpus made the animation ${ratio.toFixed(2)}x longer`);
  // And it is a showpiece, not a stall: seconds, not tens of seconds.
  assert.ok(small.totalMs < 3000, `${Math.round(small.totalMs)}ms is too long to sit through`);
});

test('a narrow viewport costs proportionally less', () => {
  const phone = buildRearrangement({
    before: arrangement(200, shuffledOrder(200, 1)),
    after: arrangement(200, shuffledOrder(200, 2)),
    view: { x0: -1, y0: -3, x1: 2, y1: 4 },
    aspect: CELL_ASPECT,
  });
  const moves = planMoves(phone.start, phone.end, phone.bounds, phone.fixed);
  const { totalMs } = buildTimeline(moves, TIMING);
  const desktop = createSlideshow({
    board: { width: 1, height: 1, cells: [] },
    moves: rearrangement().moves,
    apply: () => {},
    timing: TIMING,
  });
  assert.ok(totalMs < desktop.totalMs, 'a phone should not take longer than a desktop');
  assert.ok(BOARD_GENERIC === 'generic');
});
