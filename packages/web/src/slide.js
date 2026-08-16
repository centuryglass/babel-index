/**
 * The rearrangement animation: a second renderer, for the one moment the map is
 * not a map.
 *
 * `render.js` draws an infinite world under a camera the reader controls. This
 * draws a finite board under a camera parked on the centre, with one row or
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
 * ### Why the offset is a remainder
 *
 * A run's visual offset is `progress - applied`: how far it has travelled, less
 * what the board has already absorbed. For a conveyor that stays inside one
 * cell, because a step is applied the moment the slide crosses it. For a single
 * six-cell row shift nothing is absorbed until the end, so the offset runs all
 * the way to six. One rule, both behaviours, and no case analysis.
 *
 * ### Timing is the tuning surface here
 *
 * The visible cost is the region's, not the corpus's - one row shift per region
 * row, then one column slide per region column - so the duration is set by the
 * viewport and nothing else. It is also the part with no right answer, which is
 * why the numbers are collected at the top with their reasoning rather than
 * spread through the code.
 */
import { PYRAMID } from './pyramid.js';
import { pxPerCell } from './camera.js';
import { GENERIC } from './tiles.js';
import { CENTRE } from '../../map/board.js';

/**
 * How long the motion takes.
 *
 * `perCell` dominates: a full rearrangement slides the region's height once per
 * region column, so total travel is roughly the region's area in cells and the
 * whole animation is that times this. At the default zoom a desktop region is
 * about 12 x 10, so ~110 cells of travel - which is why this is 26ms and not
 * the 100ms a single tile sliding would want. A line moving as one piece reads
 * at a speed a single tile would not.
 *
 * `base` is a per-run constant so a one-cell slide is not instantaneous, and
 * `gap` is the beat between runs that keeps them legible as separate moves
 * rather than one continuous churn.
 *
 * These land a desktop rearrangement at about 4 seconds and a phone at under
 * two. The real lever is not here: runs are played strictly one after another
 * because each one's swaps have to be applied after the previous one's last
 * rotation, and the planner's column loop only becomes independent enough to
 * overlap if every column's values are parked before any are inserted. That is
 * a change to the planner rather than to a number, and it is what would take
 * this under two seconds on a desktop - see the note in the implementation plan.
 */
export const SLIDE_TIMING = {
  base: 80,
  perCell: 26,
  gap: 20,
};

/** The cache id for a board value. Centre and generic share the wallpaper image. */
const idOf = (v) => (v === CENTRE ? GENERIC : v);

/**
 * Group a move list into runs of continuous motion.
 *
 * Swaps carry no motion, so each is attached to the run whose first shift
 * follows it - which is where it has to be applied anyway: after the previous
 * run's last rotation, and before the next one starts moving. Trailing swaps
 * (the planner's off-camera cycle sort) become a final run of zero length.
 *
 * @param {Array<object>} moves from `planMoves`
 * @param {object} [timing]
 * @returns {{runs: Array<object>, totalMs: number}}
 */
export function buildTimeline(moves, timing = SLIDE_TIMING) {
  const runs = [];
  let pending = [];
  let current = null;

  for (const move of moves) {
    if (move.type === 'swap') {
      pending.push(move);
      continue;
    }
    const isRow = move.type === 'shiftRow';
    const index = isRow ? move.row : move.col;
    const dir = Math.sign(move.distance);
    if (!current || current.kind !== (isRow ? 'row' : 'col') || current.index !== index || current.dir !== dir) {
      current = { kind: isRow ? 'row' : 'col', index, dir, cells: 0, steps: [] };
      runs.push(current);
    }
    for (const swap of pending) current.steps.push({ move: swap });
    pending = [];
    current.cells += Math.abs(move.distance);
    current.steps.push({ move, at: current.cells });
  }

  // Everything the planner does after the last slide is off camera by
  // construction, so it costs no time and simply lands when the motion stops.
  if (pending.length) runs.push({ kind: 'none', index: -1, dir: 0, cells: 0, steps: pending.map((move) => ({ move })) });

  let at = 0;
  for (const run of runs) {
    run.startMs = at;
    run.durMs = run.cells === 0 ? 0 : timing.base + timing.perCell * run.cells;
    at += run.durMs + (run.cells === 0 ? 0 : timing.gap);
  }

  return { runs, totalMs: at };
}

/** Smooth the ends of a run so a line does not start and stop dead. */
const ease = (t) => t * t * (3 - 2 * t);

/**
 * Drive a plan over a board.
 *
 * Owns the mutable board and how much of the plan has been absorbed into it.
 * `advanceTo` is the whole interface: hand it a time and it applies whatever
 * the board should have absorbed by then, and answers with the line currently
 * in motion and how far it has travelled.
 *
 * @param {object} opts
 * @param {{width: number, height: number, cells: Array}} opts.board mutated in place
 * @param {Array<object>} opts.moves
 * @param {(board: object, move: object) => void} opts.apply usually `applyMove`
 * @param {object} [opts.timing]
 */
export function createSlideshow({ board, moves, apply, timing = SLIDE_TIMING }) {
  const { runs, totalMs } = buildTimeline(moves, timing);
  const absorbed = runs.map(() => 0); // cells of travel each run has committed
  let cursor = 0; // index into the flattened step list
  let runIndex = 0;
  let stepIndex = 0;

  function applyStep(run, ri) {
    const step = run.steps[stepIndex];
    apply(board, step.move);
    if (step.at !== undefined) absorbed[ri] = step.at;
    stepIndex++;
    cursor++;
  }

  /**
   * Bring the board up to `elapsed`, and report the motion to draw.
   *
   * @returns {{done: boolean, motion: object|null}} `motion` is
   *   `{kind, index, dir, offset}` in cells, or null when nothing is moving
   */
  function advanceTo(elapsed) {
    while (runIndex < runs.length) {
      const run = runs[runIndex];
      const t = run.durMs === 0 ? 1 : Math.min(1, Math.max(0, (elapsed - run.startMs) / run.durMs));
      const progress = ease(t) * run.cells;

      // Absorb every step this run has already travelled past. Swaps have no
      // threshold and go as soon as the run is current, which is exactly when
      // they are due: after the previous run's last rotation.
      let blocked = false;
      while (stepIndex < run.steps.length) {
        const step = run.steps[stepIndex];
        if (step.at !== undefined && progress < step.at - 1e-9) {
          blocked = true;
          break;
        }
        applyStep(run, runIndex);
      }

      // Still travelling, or held up waiting to cross the next cell: either way
      // this run is what is on screen.
      if (blocked || t < 1)
        return { done: false, motion: motionOf(run, progress - absorbed[runIndex]) };

      runIndex++;
      stepIndex = 0;
    }
    return { done: true, motion: null };
  }

  const motionOf = (run, offset) =>
    run.cells === 0 ? null : { kind: run.kind, index: run.index, dir: run.dir, offset };

  return { advanceTo, totalMs, runs, cursor: () => cursor };
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
   * @param {{x: number, y: number, zoom: number}} opts.cam parked on the centre
   * @param {{width: number, height: number, cells: Array}} opts.board
   * @param {{x: number, y: number}} opts.origin board index of map cell (0, 0)
   * @param {object|null} opts.motion from `advanceTo`
   * @param {boolean} [opts.chrome] the centre-room marker
   */
  function draw({ ctx, width: w, height: h, dpr, cam, board, origin, motion, chrome = true }) {
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

    const paint = (value, mx, my) => {
      const sx = (mx - cam.x) * cellPx.x + w / 2;
      const sy = (my - cam.y) * cellPx.y + h / 2;
      const hit = cache.get(idOf(value), level);
      if (hit) {
        ctx.drawImage(hit.img, sx, sy, cw, ch);
        drawn++;
      } else {
        ctx.fillStyle = '#15120f';
        ctx.fillRect(sx, sy, cw, ch);
        blank++;
      }
      wanted.push(idOf(value));
    };

    // The still field. The line in motion is skipped here and drawn after, so
    // its tiles land on top of their neighbours rather than under them.
    const movingRow = motion?.kind === 'row' ? motion.index - origin.y : null;
    const movingCol = motion?.kind === 'col' ? motion.index - origin.x : null;
    for (let my = y0; my <= y1; my++)
      for (let mx = x0; mx <= x1; mx++) {
        if (my === movingRow || mx === movingCol) continue;
        paint(valueAt(mx + origin.x, my + origin.y), mx, my);
      }

    // The line in motion, extended by however far it has travelled so the cells
    // sliding in from off screen are drawn too.
    if (motion) {
      const shift = motion.offset * motion.dir;
      const pad = Math.ceil(Math.abs(shift)) + 1;
      if (movingRow !== null)
        for (let mx = x0 - pad; mx <= x1 + pad; mx++)
          paint(valueAt(mx + origin.x, motion.index), mx + shift, movingRow);
      else
        for (let my = y0 - pad; my <= y1 + pad; my++)
          paint(valueAt(motion.index, my + origin.y), movingCol, my + shift);
    }

    // The tiles about to arrive: a ring outside the viewport, at the one level
    // this animation ever uses. Behind everything visible, as always.
    for (let my = y0 - 2; my <= y1 + 2; my++)
      for (let mx = x0 - 2; mx <= x1 + 2; mx++)
        if (my < y0 || my > y1 || mx < x0 || mx > x1)
          cache.prefetch(idOf(valueAt(mx + origin.x, my + origin.y)), level);

    if (chrome) {
      // The centre room, which by construction has not moved.
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
