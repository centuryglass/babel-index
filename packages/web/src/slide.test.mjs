import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, shuffledOrder } from '../../map/ordering.js';
import { buildRearrangement, CENTRE, GENERIC as BOARD_GENERIC } from '../../map/board.js';
import { planMoves, applyMove } from '../../map/illusion.js';
import { buildTimeline, createSlideshow, createSlideRenderer, SLIDE_TIMING } from './slide.js';
import { createTileCache, GENERIC } from './tiles.js';
import { CELL_ASPECT } from './camera.js';

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
  cache.pin(GENERIC);
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

test('a conveyor becomes one run, not one run per step', () => {
  const { moves } = rearrangement();
  const { runs } = buildTimeline(moves);

  // The planner emits a column's k rotations separately, each fed by a swap.
  // Animated literally that is k jerks; grouped, it is one ride upward.
  const colRuns = runs.filter((r) => r.kind === 'col');
  assert.ok(colRuns.length > 0);
  for (const run of colRuns)
    assert.ok(run.cells > 1, `column run of ${run.cells} cell(s) was not grouped`);

  const shifts = moves.filter((m) => m.type !== 'swap').length;
  assert.ok(runs.length < shifts, `${runs.length} runs for ${shifts} shifts is no grouping at all`);

  // Every move survives the grouping, in order.
  const flat = runs.flatMap((r) => r.steps.map((s) => s.move));
  assert.deepEqual(flat, moves);
});

test('runs only ever group one line moving one way', () => {
  const { moves } = rearrangement();
  for (const run of buildTimeline(moves).runs) {
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

test('the board absorbs exactly what the motion has passed', () => {
  const { built, moves } = rearrangement();
  const board = { ...built.start, cells: built.start.cells.slice() };
  const show = createSlideshow({ board, moves, apply: applyMove });

  // Sampled finely enough to land inside runs rather than only between them.
  const byRun = new Map(show.runs.map((r) => [r, 0]));
  let sawOffsetOverOne = false;
  for (let t = 0; t <= show.totalMs; t += 7) {
    const { motion } = show.advanceTo(t);
    if (!motion) continue;
    const run = show.runs.find((r) => r.kind === motion.kind && r.index === motion.index);
    assert.ok(motion.offset >= -1e-6, `negative offset ${motion.offset}`);
    // The offset is a remainder, so it can never exceed the run's whole travel
    // however the run is made up. It is not always under one cell: a column run
    // can open with a multi-cell extraction rotation before its conveyor, since
    // the planner frees a trapped value by rotating that column outright.
    assert.ok(motion.offset <= run.cells + 1e-6, `offset ${motion.offset} past a ${run.cells}-cell run`);
    byRun.set(run, Math.max(byRun.get(run) ?? 0, motion.offset));
    if (motion.offset > 1) sawOffsetOverOne = true;
  }
  assert.ok(sawOffsetOverOne, 'no multi-cell slide was ever observed');

  // Most column runs are pure conveyor and do stay inside a cell - if that ever
  // stopped being true the animation would be lurching rather than riding.
  const cols = [...byRun].filter(([r]) => r.kind === 'col');
  const tight = cols.filter(([, peak]) => peak <= 1 + 1e-6).length;
  assert.ok(tight > cols.length / 2, `only ${tight} of ${cols.length} column runs ride smoothly`);

  const { done, motion } = show.advanceTo(show.totalMs + 1);
  assert.equal(done, true);
  assert.equal(motion, null);
  assert.deepEqual(board.cells, built.end.cells, 'the board did not finish on the end board');
});

test('advancing in one jump lands on the same board as advancing smoothly', () => {
  // The animation must not depend on being ticked at any particular rate: a
  // dropped frame, or a tab that was in the background, has to be survivable.
  const { built, moves } = rearrangement(120, 3, 4);
  const boards = [0, 1].map(() => ({ ...built.start, cells: built.start.cells.slice() }));

  const smooth = createSlideshow({ board: boards[0], moves, apply: applyMove });
  for (let t = 0; t <= smooth.totalMs; t += 16) smooth.advanceTo(t);
  smooth.advanceTo(smooth.totalMs);

  const jumped = createSlideshow({ board: boards[1], moves, apply: applyMove });
  jumped.advanceTo(jumped.totalMs);

  assert.deepEqual(boards[0].cells, boards[1].cells);
  assert.deepEqual(boards[0].cells, built.end.cells);
});

test('every visible cell is painted in every frame, including mid-slide', () => {
  const { built, moves } = rearrangement();
  const { cache, settle } = readyCache();
  const board = { ...built.start, cells: built.start.cells.slice() };
  const show = createSlideshow({ board, moves, apply: applyMove });
  const renderer = createSlideRenderer({ cache });
  const cam = { x: 0.5, y: 0.5, zoom: ZOOM };
  const frame = (motion) => {
    const ctx = fakeCtx();
    const stats = renderer.draw({
      ctx, width: 1920, height: 1080, dpr: 1, cam,
      board, origin: built.origin, motion,
    });
    return { ctx, stats };
  };

  frame(null);
  settle(); // the first frame requests; from here the cache answers

  const cellPx = { x: ZOOM, y: ZOOM * CELL_ASPECT };
  for (let t = 0; t <= show.totalMs; t += 37) {
    const { motion } = show.advanceTo(t);
    const { ctx } = frame(motion);

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
    assert.equal(frame(motion).stats.blank, 0, `still blank after settling, at t=${t}`);
  }
});

test('the centre room is never drawn anywhere but the centre', () => {
  // The whole point of the fixed tile. If a slide ever carried it, it would
  // appear off-centre in some frame, and this is what would see it.
  const { built, moves } = rearrangement();
  const { cache, settle } = readyCache();
  const board = { ...built.start, cells: built.start.cells.slice() };
  const show = createSlideshow({ board, moves, apply: applyMove });
  const renderer = createSlideRenderer({ cache });
  settle();

  const centreIndex = built.origin.y * built.width + built.origin.x;
  for (let t = 0; t <= show.totalMs; t += 23) {
    show.advanceTo(t);
    assert.equal(board.cells[centreIndex], CENTRE, `the centre moved at t=${t}`);
    const elsewhere = board.cells.filter((v) => v === CENTRE).length;
    assert.equal(elsewhere, 1, `${elsewhere} centre rooms on the board at t=${t}`);
  }
  assert.ok(renderer);
});

test('duration is set by the viewport, not by the corpus', () => {
  const small = createSlideshow({
    board: { width: 1, height: 1, cells: [] },
    moves: rearrangement(50, 1, 2).moves,
    apply: () => {},
  });
  const large = createSlideshow({
    board: { width: 1, height: 1, cells: [] },
    moves: rearrangement(800, 1, 2).moves,
    apply: () => {},
  });
  // Not identical: a few slides either way come from values that happened to
  // need rotating out of the region, which depends on the data. What matters is
  // that a 16x corpus moves this by a tenth and not by sixteen.
  const ratio = large.totalMs / small.totalMs;
  assert.ok(ratio > 0.8 && ratio < 1.25, `a 16x corpus changed the duration by ${ratio.toFixed(2)}x`);
  // And it is a showpiece, not a stall: seconds, not tens of seconds.
  assert.ok(small.totalMs < 12000, `${Math.round(small.totalMs)}ms is too long to sit through`);
});

test('a narrow viewport costs proportionally less', () => {
  const phone = buildRearrangement({
    before: arrangement(200, shuffledOrder(200, 1)),
    after: arrangement(200, shuffledOrder(200, 2)),
    view: { x0: -1, y0: -3, x1: 2, y1: 4 },
    aspect: CELL_ASPECT,
  });
  const moves = planMoves(phone.start, phone.end, phone.bounds, phone.fixed);
  const { totalMs } = buildTimeline(moves, SLIDE_TIMING);
  const desktop = createSlideshow({
    board: { width: 1, height: 1, cells: [] },
    moves: rearrangement().moves,
    apply: () => {},
  });
  assert.ok(totalMs < desktop.totalMs, 'a phone should not take longer than a desktop');
  assert.ok(BOARD_GENERIC === 'generic');
});
