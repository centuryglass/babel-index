/**
 * The rearrangement animation: a second renderer, for the one moment the map is
 * not a map.
 *
 * `render.js` draws an infinite world under a camera the reader controls. This
 * draws a finite board under a camera parked on the center, with one row or
 * column part-way through a slide. Those are different enough jobs that sharing
 * a loop would mean threading "is something sliding" through every decision the
 * other one makes, so they stay separate and `main.jsx` picks which is drawing.
 * The animation ends by handing back, and the board is discarded.
 *
 * ### A run is a whole line's worth of motion, not one step
 *
 * The planner's conveyor emits a column's k steps as k separate rotations, each
 * preceded by a swap that feeds the next value in below the camera. Animated
 * literally that is k discrete jerks. But the swaps all land off camera and all
 * land at whole-cell boundaries, so the *motion* can be continuous while the
 * *state* advances a step at a time: the column slides k cells in one gesture,
 * and each swap is applied as the slide crosses the corresponding cell. What
 * the viewer sees is a column of tiles riding upward with fresh rooms arriving
 * from below the screen edge.
 *
 * Grouping consecutive same-line, same-direction shifts into one run is all it
 * takes, and it gives the right answer for both shapes the planner emits: a
 * conveyor becomes one long slide, and phase 1's single multi-cell row shift
 * becomes one slide of that many cells.
 *
 * ### A wave, not a queue
 *
 * The planner marks the stages whose lines are independent - it parks a whole
 * batch of values before feeding any of them, so no column's ride can disturb
 * another's. Those play concurrently, one lane per line, set off a stagger
 * apart and ordered outward from the center. That is most of the animation: a
 * batch of columns sweeps across together rather than queuing one after another.
 * Stages that are not marked stay strictly ordered, because a parking stage's
 * extraction rotates a line and the swap after it depends on that rotation.
 *
 * ### Why the offset is a remainder
 *
 * A run's visual offset is `progress - applied`: how far it has travelled, less
 * what the board has already absorbed. For a conveyor that stays inside one
 * cell, because a step is applied the moment the slide crosses it. For a single
 * six-cell row shift nothing is absorbed until the end, so the offset runs all
 * the way to six. One rule, both behaviours, and no case analysis.
 *
 * ### Timing comes from config, and there is deliberately no fallback here
 *
 * The five durations are by-feel numbers, so they live in `packages/config`
 * with their reasoning, the way the opening zoom does - and for the same
 * reason `useMapCamera.js` refuses to default one: a fallback in this file
 * would be a second statement of the same fact, and the two would drift. What
 * this file owns is how a plan is laid out in time; what the numbers should be
 * is somebody else's question.
 *
 * The visible cost is the region's, not the corpus's - only lines crossing the
 * on-camera rectangle ever slide - so the duration is set by the viewport and
 * corpus size does not enter into it.
 */
import { PYRAMID } from './pyramid.js';
import { pxPerCell } from './camera.js';
import { CENTER, genericId } from './tiles.js';
import { CENTER as BOARD_CENTER, GENERIC as BOARD_GENERIC } from '../../../map/board.js';

/**
 * The cache id for a board value at its HOME map cell.
 *
 * The board carries one interchangeable `GENERIC` value everywhere a generic
 * tile sits - `board.js` and `illusion.js` never need to know one generic tile
 * from another - so the actual tile is resolved here, positionally, from the
 * cell the value lives at. A generic tile therefore carries its own face as
 * its line slides: `genericIndexAt` is read at the value's board home, not at
 * wherever the slide has pushed it to, so nothing flips face mid-ride.
 *
 * @param {*} value board value: CENTER, GENERIC, or a numeric room id
 * @param {number} homeMx home map x of the board cell holding it
 * @param {number} homeMy home map y
 * @param {(x: number, y: number) => number} genericIndexAt positional generic tile chooser
 */
const idFor = (value, homeMx, homeMy, genericIndexAt) =>
  value === BOARD_CENTER
    ? CENTER
    : value === BOARD_GENERIC
      ? genericId(genericIndexAt(homeMx, homeMy))
      : value;

/**
 * Lay a move list out in time.
 *
 * Three levels, and each exists for a reason the one below it cannot serve:
 *
 *   - a **stage** is a barrier. The planner guarantees nothing about a stage
 *     until every earlier one has been applied, so stages are strictly ordered.
 *   - a **lane** is a line's worth of work within a stage. In a `wave` stage
 *     there is one per line and they run concurrently, staggered; otherwise
 *     there is a single lane and everything in it is sequential.
 *   - a **run** is one continuous slide: consecutive shifts of the same line in
 *     the same direction, with the swaps that feed them attached. This is what
 *     turns a column's ten separate rotations into one ride upward.
 *
 * @param {import('../../../map/moves.ts').Move[]} moves from `planMoves`
 * @param {{base, perCell, gap, stagger, cascade}} timing from `packages/config`
 * @returns {{stages: Array<object>, totalMs: number}}
 */
export function buildTimeline(moves, timing) {
  const stages = [];
  for (const move of moves) {
    const last = stages[stages.length - 1];
    if (!last || last.stage !== move.stage)
      stages.push({ stage: move.stage, wave: Boolean(move.wave), moves: [move] });
    else last.moves.push(move);
  }

  let at = 0;
  for (const stage of stages) {
    // One lane per line when the stage says its lines are independent; a single
    // lane otherwise, which is the sequential case and also what a stage of
    // pure off-camera swaps collapses to.
    const lanes = [];
    const byLine = new Map();
    for (const move of stage.moves) {
      const key = stage.wave && move.line ? `${move.line.kind}${move.line.index}` : '';
      let lane = byLine.get(key);
      if (!lane) byLine.set(key, (lane = { runs: [] }));
      pushMove(lane, move);
    }
    lanes.push(...byLine.values());

    stage.startMs = at;
    stage.lanes = lanes;
    let end = at;
    lanes.forEach((lane, i) => {
      // A wave's lanes are independent, so each simply sets off a stagger after
      // the last and runs its own course.
      //
      // A sequential lane instead CASCADES: its runs start a beat apart and so
      // overlap on screen, but each is forced to finish no earlier than the one
      // before it. Since a run's moves are applied as it passes them, and the
      // last of them at its completion, ordered completions are exactly ordered
      // application - the plan is honoured to the letter while the picture stops
      // being a queue. This is what the extraction rotations ride on: a small
      // corpus keeps most of its rooms on camera, so it needs many of them.
      let cursor = at + (stage.wave ? i * timing.stagger : 0);
      let previousEnd = cursor;
      for (const run of lane.runs) {
        run.durMs = run.cells === 0 ? 0 : timing.base + timing.perCell * run.cells;
        let start = cursor;
        if (!stage.wave && start + run.durMs < previousEnd) start = previousEnd - run.durMs;
        run.startMs = start;
        previousEnd = Math.max(previousEnd, start + run.durMs);
        cursor = stage.wave
          ? previousEnd + (run.cells === 0 ? 0 : timing.gap)
          : cursor + (run.cells === 0 ? 0 : timing.cascade);
      }
      lane.endMs = previousEnd;
      end = Math.max(end, previousEnd);
    });
    stage.endMs = end;
    at = end;
  }

  return { stages, totalMs: at };
}

/**
 * Append a move to a lane, extending its current run or opening a new one.
 *
 * Every step carries the travel the run must have reached before it may be
 * applied. For a shift that is the far end of its own motion; for a swap it is
 * wherever the run already stands, so a swap emitted after a shift lands at
 * that shift's COMPLETION rather than at the next run's start. The distinction
 * is invisible while runs play strictly in sequence and load-bearing the
 * moment they overlap - see the cascade in `buildTimeline`.
 *
 * @param {import('../../../map/moves.ts').Move} move
 */
function pushMove(lane, move) {
  let run = lane.runs[lane.runs.length - 1];

  if (move.type === 'swap') {
    // A swap has no motion of its own. Before the lane's first shift it lands
    // at once; after one, it lands when that shift finishes.
    if (!run) {
      run = { kind: 'none', index: -1, dir: 0, cells: 0, steps: [], stepIndex: 0, absorbed: 0 };
      lane.runs.push(run);
    }
    run.steps.push({ move, at: run.cells });
    return;
  }

  const kind = move.type === 'shiftRow' ? 'row' : 'col';
  const index = move.type === 'shiftRow' ? move.row : move.col;
  const dir = Math.sign(move.distance);
  if (!run || run.kind !== kind || run.index !== index || run.dir !== dir) {
    run = { kind, index, dir, cells: 0, steps: [], stepIndex: 0, absorbed: 0 };
    lane.runs.push(run);
  }
  run.cells += Math.abs(move.distance);
  run.steps.push({ move, at: run.cells, absorbs: true });
}

/** Smooth the ends of a run so a line does not start and stop dead. */
const ease = (t) => t * t * (3 - 2 * t);

/**
 * Drive a plan over a board.
 *
 * Owns the mutable board and how much of the plan has been absorbed into it.
 * `advanceTo` is the whole interface: hand it a time and it applies whatever
 * the board should have absorbed by then, and answers with every line currently
 * in motion. There can be several, which is the point of a wave - and they can
 * never overlap on screen, because a wave stage's lines are all the same kind.
 *
 * @param {object} opts
 * @param {import('../../../map/moves.ts').Board} opts.board mutated in place
 * @param {import('../../../map/moves.ts').Move[]} opts.moves
 * @param {(board: import('../../../map/moves.ts').Board, move: import('../../../map/moves.ts').Move) => void} opts.apply
 *   usually `applyMove`
 * @param {object} opts.timing from `packages/config`
 */
export function createSlideshow({ board, moves, apply, timing }) {
  const { stages, totalMs } = buildTimeline(moves, timing);
  let stageIndex = 0;

  /** Absorb every step this run has travelled past. Returns true if it is blocked. */
  function absorb(run, progress) {
    while (run.stepIndex < run.steps.length) {
      const step = run.steps[run.stepIndex];
      if (progress < step.at - 1e-9) return true;
      apply(board, step.move);
      if (step.absorbs) run.absorbed = step.at;
      run.stepIndex++;
    }
    return false;
  }

  /** @returns {import('../../../map/moves.ts').Motion | null} */
  const motionOf = (run) =>
    run.cells === 0
      ? null
      : { kind: run.kind, index: run.index, dir: run.dir, offset: run.progress - run.absorbed };

  /**
   * Bring the board up to `elapsed`, and report the motion to draw.
   *
   * @returns {{done: boolean, motions: import('../../../map/moves.ts').Motion[]}}
   */
  function advanceTo(elapsed) {
    while (stageIndex < stages.length) {
      const stage = stages[stageIndex];
      if (elapsed >= stage.endMs) {
        // Past it: everything in every lane lands. Lanes are independent within
        // a stage, so the order they are finished off in cannot matter.
        for (const lane of stage.lanes)
          for (const run of lane.runs) {
            run.progress = run.cells;
            absorb(run, run.cells);
          }
        stageIndex++;
        continue;
      }

      const motions = [];
      for (const lane of stage.lanes)
        for (const run of lane.runs) {
          const t = run.durMs === 0 ? 1 : Math.min(1, Math.max(0, (elapsed - run.startMs) / run.durMs));
          if (t <= 0) break; // this lane has not reached this run yet
          run.progress = ease(t) * run.cells;
          absorb(run, run.progress);
          if (t < 1) {
            const motion = motionOf(run);
            if (motion) motions.push(motion);
            break;
          }
        }
      return { done: false, motions };
    }
    return { done: true, motions: [] };
  }

  return { advanceTo, totalMs, stages };
}

/**
 * Draw one frame of the animation.
 *
 * Takes a 2d context and the state of the board, the same way `render.js` takes
 * one and the state of the world - so a frame's decisions are assertable
 * without a browser.
 */
export function createSlideRenderer({ cache, pyramid = PYRAMID } = {}) {
  /**
   * @param {object} opts
   * @param {CanvasRenderingContext2D} opts.ctx
   * @param {number} opts.width  css pixels
   * @param {number} opts.height css pixels
   * @param {number} opts.dpr
   * @param {{x: number, y: number, zoom: number}} opts.cam parked on the center
   * @param {import('../../../map/moves.ts').Board} opts.board
   * @param {import('../../../map/moves.ts').Point} opts.origin board index of
   *   map cell (0, 0)
   * @param {import('../../../map/moves.ts').Motion[]} [opts.motions] from
   *   `advanceTo` - several at once during a wave. They can never overlap on
   *   screen: a wave stage's lines are all rows or all columns, and two rows
   *   share no cell
   * @param {(x: number, y: number) => number} [opts.genericIndexAt] which generic
   *   tile a generic cell shows, by map coordinate (the same positional chooser
   *   the main renderer uses, so the tile matches across the handoff)
   * @param {boolean} [opts.chrome] the center-room marker
   */
  function draw({ ctx, width: w, height: h, dpr, cam, board, origin, motions = [], genericIndexAt = () => -1, chrome = true }) {
    cache.beginFrame();

    ctx.fillStyle = '#0a0908';
    ctx.fillRect(0, 0, w, h);

    const cellPx = pxPerCell(cam);
    const level = pyramid.pickLevel({ w: cellPx.x * dpr, h: cellPx.y * dpr }, null);

    const halfW = w / 2 / cellPx.x;
    const halfH = h / 2 / cellPx.y;
    const x0 = Math.floor(cam.x - halfW);
    const x1 = Math.ceil(cam.x + halfW);
    const y0 = Math.floor(cam.y - halfH);
    const y1 = Math.ceil(cam.y + halfH);

    const W = board.width;
    const H = board.height;
    const valueAt = (bx, by) => board.cells[(((by % H) + H) % H) * W + (((bx % W) + W) % W)];
    // +1 on each axis kills hairline gaps from rounding, exactly as render.js does.
    const cw = cellPx.x + 1;
    const ch = cellPx.y + 1;

    let drawn = 0;
    let blank = 0;
    const wanted = [];

    // A value's generic tile is read at its HOME map cell, which is not always where
    // it is drawn: a sliding line reads its board home but paints at the shifted
    // position, so the tile carries its own face across the ride.
    const paint = (value, homeMx, homeMy, drawMx, drawMy) => {
      const sx = (drawMx - cam.x) * cellPx.x + w / 2;
      const sy = (drawMy - cam.y) * cellPx.y + h / 2;
      const id = idFor(value, homeMx, homeMy, genericIndexAt);
      const hit = cache.get(id, level);
      if (hit) {
        ctx.drawImage(hit.img, sx, sy, cw, ch);
        drawn++;
      } else {
        ctx.fillStyle = '#15120f';
        ctx.fillRect(sx, sy, cw, ch);
        blank++;
      }
      wanted.push(id);
    };

    // The still field. Lines in motion are skipped here and drawn after, so
    // their tiles land on top of their neighbours rather than under them.
    const movingRows = new Set();
    const movingCols = new Set();
    for (const m of motions)
      (m.kind === 'row' ? movingRows : movingCols).add(
        m.kind === 'row' ? m.index - origin.y : m.index - origin.x
      );
    for (let my = y0; my <= y1; my++)
      for (let mx = x0; mx <= x1; mx++) {
        if (movingRows.has(my) || movingCols.has(mx)) continue;
        paint(valueAt(mx + origin.x, my + origin.y), mx, my, mx, my);
      }

    // Each line in motion, extended by however far it has travelled so the
    // cells sliding in from off screen are drawn too.
    for (const m of motions) {
      const shift = m.offset * m.dir;
      const pad = Math.ceil(Math.abs(shift)) + 1;
      if (m.kind === 'row')
        for (let mx = x0 - pad; mx <= x1 + pad; mx++)
          paint(valueAt(mx + origin.x, m.index), mx, m.index - origin.y, mx + shift, m.index - origin.y);
      else
        for (let my = y0 - pad; my <= y1 + pad; my++)
          paint(valueAt(m.index, my + origin.y), m.index - origin.x, my, m.index - origin.x, my + shift);
    }

    // The tiles about to arrive: a ring outside the viewport, at the one level
    // this animation ever uses. Behind everything visible, as always.
    for (let my = y0 - 2; my <= y1 + 2; my++)
      for (let mx = x0 - 2; mx <= x1 + 2; mx++)
        if (my < y0 || my > y1 || mx < x0 || mx > x1)
          cache.prefetch(idFor(valueAt(mx + origin.x, my + origin.y), mx, my, genericIndexAt), level);

    if (chrome) {
      // The center room, which by construction has not moved.
      const sx = (0 - cam.x) * cellPx.x + w / 2;
      const sy = (0 - cam.y) * cellPx.y + h / 2;
      ctx.strokeStyle = 'rgba(200,169,95,0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 1, sy + 1, cellPx.x - 2, cellPx.y - 2);
    }

    return { drawn, blank, level, cells: wanted.length };
  }

  return { draw };
}
