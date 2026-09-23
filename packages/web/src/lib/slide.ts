/**
 * The rearrangement animation: a second renderer, for the one moment the map
 * is not a map.
 *
 * `render.ts` draws an infinite world under a camera the reader controls; this
 * draws a finite board under a camera parked for the animation's duration,
 * with one row or column part-way through a slide. The loops stay separate
 * because a shared one would thread "is something sliding" through every
 * other decision; `main.tsx` picks which is drawing, and the animation ends
 * by handing back.
 *
 * ### A run is a whole line's worth of motion, not one step
 *
 * The planner's conveyor emits a column's k steps as k separate rotations,
 * each preceded by a swap that feeds the next value in below the camera.
 * Animated literally that is k discrete jerks. But the swaps all land off
 * camera and at whole-cell boundaries, so the *motion* can be continuous
 * while the *state* advances a step at a time: the column slides k cells in
 * one gesture, and each swap is applied as the slide crosses the
 * corresponding cell. What the viewer sees is a column of tiles riding
 * upward with fresh rooms arriving from below the screen edge.
 *
 * Grouping consecutive same-line, same-direction shifts into one run is all
 * it takes, and it gives the right answer for both shapes the planner emits:
 * a conveyor becomes one long slide, and phase 1's single multi-cell row
 * shift becomes one slide of that many cells.
 *
 * ### A wave, not a queue
 *
 * The planner's `wave` flag marks the stages whose lines are independent -
 * see the *primitives* block in `illusion.ts` for what makes them so. Those
 * play concurrently, one lane per line, set off a stagger apart and ordered
 * outward from the center, so a batch of columns sweeps across together
 * instead of queuing one after another. Unmarked stages stay strictly
 * ordered.
 *
 * ### Why the offset is a remainder
 *
 * A run's visual offset is `progress - applied`: how far it has travelled,
 * less what the board has already absorbed. For a conveyor that stays inside
 * one cell, because a step is applied the moment the slide crosses it. For a
 * single six-cell row shift nothing is absorbed until the end, so the offset
 * runs all the way to six. One rule, both behaviours, no case analysis.
 *
 * ### Timing comes from config
 *
 * The five durations are by-feel numbers, so they live in `packages/config`,
 * and this file states no fallback for them - the same rule
 * `useMapCamera.ts` gives for the flight duration, and docs/agents/map.md's
 * "Consuming files state no fallback defaults". What this file owns is how a
 * plan is laid out in time; what the numbers should be is somebody else's
 * question.
 *
 * The visible cost is the region's, not the corpus's: only lines crossing the
 * on-camera rectangle ever slide. The duration is set by the viewport, and
 * corpus size does not enter into it.
 */
import { PYRAMID, type Pyramid } from './pyramid.ts';
import { pxPerCell, type Camera } from './camera.ts';
import { CENTER, FAV_ON, FAV_OFF, genericId, genericDistillId, type RoomId, type TileCache } from './tiles.ts';
import { CENTER as BOARD_CENTER, GENERIC as BOARD_GENERIC } from '../../../map/board.ts';
import type { Board, BoardValue, Motion, Move, Point } from '../../../map/moves.ts';
import type { Config } from '../../../config/config.ts';
import type { SortMode } from '../../../map/favorites.ts';
import {
  drawFavoriteBadge, drawFavoriteSwitch, drawDistillToggle, drawClearHistoryBookOverlay, drawGenericFade,
  SMOOTHING_MAX_DOWNSCALE, type DrawContext,
} from './render.ts';
import { areSpinesLegible } from './center.ts';

/**
 * The cache id for a board value at its home map cell.
 *
 * The board carries one interchangeable `GENERIC` value wherever a generic
 * tile sits (`board.ts` and `illusion.ts` never distinguish one from
 * another), so the actual tile is resolved here, positionally, from the home
 * cell - never from wherever the slide has pushed the value. That is what
 * lets a generic tile carry its own face across a ride instead of flipping
 * mid-slide.
 */
const idFor = (
  value: BoardValue,
  homeMx: number,
  homeMy: number,
  genericIndexAt: (x: number, y: number) => number
): RoomId =>
  value === BOARD_CENTER
    ? CENTER
    : value === BOARD_GENERIC
      ? genericId(genericIndexAt(homeMx, homeMy))
      : value;

/** One step of a run: the move it carries and where along the run it applies. */
interface Step {
  move: Move;
  /** cells travelled before this step may be applied. */
  at: number;
  /** whether this step counts toward the run's absorbed distance - see `pushMove`. */
  absorbs?: boolean;
}

/**
 * One continuous slide: consecutive shifts of the same line in the same
 * direction, with the swaps that feed them attached. `kind: 'none'` is a lane
 * that has only ever seen swaps (no shift has opened a real run yet).
 */
interface Run {
  kind: 'row' | 'col' | 'none';
  index: number;
  dir: number;
  cells: number;
  steps: Step[];
  stepIndex: number;
  absorbed: number;
  durMs: number;
  startMs: number;
  progress: number;
}

/** A line's worth of work within a stage - see `buildTimeline`. */
interface Lane {
  runs: Run[];
  endMs: number;
}

/** A barrier: nothing in a later stage is guaranteed until this one has landed. */
interface Stage {
  stage: number;
  wave: boolean;
  moves: Move[];
  startMs: number;
  lanes: Lane[];
  endMs: number;
}

/** A move list laid out in time - `buildTimeline`'s return. */
export interface Timeline {
  stages: Stage[];
  totalMs: number;
}

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
 * @param moves from `planMoves`
 * @param timing from `packages/config`
 */
export function buildTimeline(moves: Move[], timing: Config['slide']): Timeline {
  const stages: Stage[] = [];
  for (const move of moves) {
    const last = stages[stages.length - 1];
    if (!last || last.stage !== move.stage)
      stages.push({ stage: move.stage, wave: Boolean(move.wave), moves: [move], startMs: 0, lanes: [], endMs: 0 });
    else last.moves.push(move);
  }

  let at = 0;
  for (const stage of stages) {
    // One lane per line when the stage says its lines are independent; a single
    // lane otherwise, which is the sequential case and also what a stage of
    // pure off-camera swaps collapses to.
    const lanes: Lane[] = [];
    const byLine = new Map<string, Lane>();
    for (const move of stage.moves) {
      const key = stage.wave && move.line ? `${move.line.kind}${move.line.index}` : '';
      let lane = byLine.get(key);
      if (!lane) byLine.set(key, (lane = { runs: [], endMs: 0 }));
      pushMove(lane, move);
    }
    lanes.push(...byLine.values());

    stage.startMs = at;
    stage.lanes = lanes;
    let end = at;
    lanes.forEach((lane, i) => {
      // A wave's lanes are independent, so each sets off a stagger after the
      // last and runs its own course.
      //
      // A sequential lane cascades instead: its runs start a beat apart and
      // overlap on screen, but each is forced to finish no earlier than the
      // one before it. Since a run's moves are applied as it passes them and
      // the last of them at its completion, ordered completions are ordered
      // application - the plan is honoured to the letter while the picture
      // stops being a queue. The extraction rotations ride on this: a small
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
 * applied. For a shift that is the far end of its own motion; for a swap it
 * is wherever the run already stands, so a swap emitted after a shift lands
 * at that shift's completion, not at the next run's start. While runs play
 * strictly in sequence the distinction is invisible; once they overlap it is
 * load-bearing - see the cascade in `buildTimeline`.
 */
function pushMove(lane: Lane, move: Move): void {
  let run = lane.runs[lane.runs.length - 1];

  if (move.type === 'swap') {
    // A swap has no motion of its own. Before the lane's first shift it lands
    // at once; after one, it lands when that shift finishes.
    if (!run) {
      run = { kind: 'none', index: -1, dir: 0, cells: 0, steps: [], stepIndex: 0, absorbed: 0, durMs: 0, startMs: 0, progress: 0 };
      lane.runs.push(run);
    }
    run.steps.push({ move, at: run.cells });
    return;
  }

  const kind = move.type === 'shiftRow' ? 'row' : 'col';
  const index = move.type === 'shiftRow' ? move.row : move.col;
  const dir = Math.sign(move.distance);
  if (!run || run.kind !== kind || run.index !== index || run.dir !== dir) {
    run = { kind, index, dir, cells: 0, steps: [], stepIndex: 0, absorbed: 0, durMs: 0, startMs: 0, progress: 0 };
    lane.runs.push(run);
  }
  run.cells += Math.abs(move.distance);
  run.steps.push({ move, at: run.cells, absorbs: true });
}

/** Smooth the ends of a run so a line does not start and stop dead. */
const ease = (t: number): number => t * t * (3 - 2 * t);

export interface CreateSlideshowOpts {
  /** mutated in place */
  board: Board;
  moves: Move[];
  /** usually `applyMove` */
  apply: (board: Board, move: Move) => void;
  /** from `packages/config` */
  timing: Config['slide'];
}

/**
 * Drive a plan over a board.
 *
 * Owns the mutable board and how much of the plan has been absorbed into it.
 * `advanceTo` is the whole interface: hand it a time, and it applies whatever
 * the board should have absorbed by then and answers with every line
 * currently in motion. There can be several - that is the point of a wave -
 * and they can never overlap on screen, because a wave stage's lines are all
 * the same kind.
 */
export function createSlideshow({ board, moves, apply, timing }: CreateSlideshowOpts) {
  const { stages, totalMs } = buildTimeline(moves, timing);
  let stageIndex = 0;

  /** Absorb every step this run has travelled past. Returns true if it is blocked. */
  function absorb(run: Run, progress: number): boolean {
    while (run.stepIndex < run.steps.length) {
      const step = run.steps[run.stepIndex];
      if (progress < step.at - 1e-9) return true;
      apply(board, step.move);
      if (step.absorbs) run.absorbed = step.at;
      run.stepIndex++;
    }
    return false;
  }

  // Only reached with `run.cells > 0`, which by construction of `pushMove`
  // means the run carries at least one shift and so `kind` is 'row' or 'col',
  // never the swap-only 'none'.
  const motionOf = (run: Run): Motion | null =>
    run.cells === 0
      ? null
      : { kind: run.kind as 'row' | 'col', index: run.index, dir: run.dir, offset: run.progress - run.absorbed };

  /**
   * Bring the board up to `elapsed`, and report the motion to draw.
   */
  function advanceTo(elapsed: number): { done: boolean; motions: Motion[] } {
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

      const motions: Motion[] = [];
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

export interface CreateSlideRendererOpts {
  cache: TileCache;
  pyramid?: Pyramid;
}

export interface SlideDrawOpts {
  ctx: DrawContext;
  /** css pixels */
  width: number;
  /** css pixels */
  height: number;
  dpr: number;
  /** parked on the center */
  cam: Camera;
  board: Board;
  /** board index of map cell (0, 0) */
  origin: Point;
  /**
   * from `advanceTo` - several at once during a wave, and never overlapping
   * on screen; see `createSlideshow`'s doc for why
   */
  motions?: Motion[];
  /**
   * which generic tile a generic cell shows, by map coordinate (the same
   * positional chooser the main renderer uses, so the tile matches across
   * the handoff)
   */
  genericIndexAt?: (x: number, y: number) => number;
  /** the center-room marker */
  chrome?: boolean;
  /** overlay a favorite badge on every real room's tile - see `render.ts`'s `DrawOpts.favorites` */
  favorites?: { isFavorite: (id: number) => boolean } | null;
  /** which ranking is in force, for the center tile's favorites-sort switch - see `render.ts`'s `DrawOpts.sortMode` */
  sortMode?: SortMode;
  /** distill mode's crossfade over generic tiles - see `render.ts`'s `DrawOpts.genericFade` */
  genericFade?: number;
  /** whether distill mode is on - see `render.ts`'s `DrawOpts.distillMode` */
  distillMode?: boolean;
  /** whether the pointer is over the distill toggle - see `render.ts`'s `DrawOpts.hoveredDistill` */
  hoveredDistill?: boolean;
  /**
   * Whether the "forget searches" book's slot is claimed - the caller's
   * reduction of `centreSlots[BOOK_COUNT - 1]?.action === 'forgetHistory'`,
   * the check `render.ts`'s loop makes directly. This renderer receives no
   * `centreSlots` at all: it draws no spine text.
   */
  clearHistoryAvailable?: boolean;
}

export interface SlideDrawResult {
  drawn: number;
  blank: number;
  level: number;
  cells: number;
}

/**
 * Draw one frame of the animation.
 *
 * Takes a 2d context and the state of the board, the same way `render.ts`
 * takes one and the state of the world, so a frame's decisions are
 * assertable without a browser.
 */
export function createSlideRenderer({ cache, pyramid = PYRAMID }: CreateSlideRendererOpts) {
  function draw({
    ctx, width: w, height: h, dpr, cam, board, origin, motions = [], genericIndexAt = () => -1, chrome = true,
    favorites = null, sortMode = 'relevance', genericFade = 0, distillMode, hoveredDistill = false,
    clearHistoryAvailable = false,
  }: SlideDrawOpts): SlideDrawResult {
    cache.beginFrame();

    // No full-viewport clear: same reasoning as `render.ts`'s draw loop - the
    // still field plus the moving lines' padded ranges cover the whole
    // viewport with no gaps (`slide.test.ts`'s "every visible cell is painted
    // in every frame, including mid-slide" asserts it), and every cell paints
    // something.
    const cellPx = pxPerCell(cam);
    const level = pyramid.pickLevel({ w: cellPx.x * dpr, h: cellPx.y * dpr }, null);

    // The same smoothing gate `render.ts`'s draw applies.
    const src = pyramid.sizeOf(level);
    ctx.imageSmoothingEnabled = !src || src.w <= cellPx.x * dpr * SMOOTHING_MAX_DOWNSCALE;

    const halfW = w / 2 / cellPx.x;
    const halfH = h / 2 / cellPx.y;
    const x0 = Math.floor(cam.x - halfW);
    const x1 = Math.ceil(cam.x + halfW);
    const y0 = Math.floor(cam.y - halfH);
    const y1 = Math.ceil(cam.y + halfH);

    const W = board.width;
    const H = board.height;
    const valueAt = (bx: number, by: number): BoardValue =>
      board.cells[(((by % H) + H) % H) * W + (((bx % W) + W) % W)];
    // +1 on each axis kills hairline gaps from rounding, as in `render.ts`.
    const cw = cellPx.x + 1;
    const ch = cellPx.y + 1;

    let drawn = 0;
    let blank = 0;
    const wanted: RoomId[] = [];

    const paint = (value: BoardValue, homeMx: number, homeMy: number, drawMx: number, drawMy: number): void => {
      const sx = (drawMx - cam.x) * cellPx.x + w / 2;
      const sy = (drawMy - cam.y) * cellPx.y + h / 2;
      const id = idFor(value, homeMx, homeMy, genericIndexAt);
      const distillId = value === BOARD_GENERIC ? genericDistillId(genericIndexAt(homeMx, homeMy)) : null;
      // The fully-faded skip `render.ts`'s loop makes too: under a complete
      // fade the base tile's art is never seen, so it is not drawn - though
      // the prefetch pass still warms it.
      if (value === BOARD_GENERIC && genericFade >= 1) {
        drawGenericFade(ctx, cache, distillId!, genericFade, sx, sy, cw, ch, level);
        wanted.push(id);
        return;
      }
      const hit = cache.get(id, level);
      if (hit) {
        if (hit.rect) {
          const { sx: rx, sy: ry, sw, sh } = hit.rect;
          ctx.drawImage(hit.img, rx, ry, sw, sh, sx, sy, cw, ch);
        } else {
          ctx.drawImage(hit.img, sx, sy, cw, ch);
        }
        drawn++;
      } else {
        ctx.fillStyle = '#15120f';
        ctx.fillRect(sx, sy, cw, ch);
        blank++;
      }
      if (value === BOARD_GENERIC && genericFade) drawGenericFade(ctx, cache, distillId!, genericFade, sx, sy, cw, ch, level);
      // The favorite badge rides along with a sliding tile. Only real rooms
      // carry one - which is when `value` is a numeric id rather than one of
      // the two shared board values.
      if (favorites && typeof value === 'number')
        drawFavoriteBadge(ctx, cache, favorites.isFavorite(value) ? FAV_ON : FAV_OFF, cellPx, sx, sy, level);
      wanted.push(id);
    };

    // The still field. Lines in motion are skipped here and drawn after, so
    // their tiles land on top of their neighbours rather than under them.
    const movingRows = new Set<number>();
    const movingCols = new Set<number>();
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
      // The center tile's controls, drawn for the whole animation - see
      // `drawFavoriteSwitch`'s doc for why the handoff needs them. The gates
      // are the ones `render.ts`'s loop uses: a favorite store and legible
      // spines for the switch, an opted-in `distillMode` for the toggle,
      // `clearHistoryAvailable` for the black spine.
      //
      // The center room itself has not moved, by construction.
      const sx = (0 - cam.x) * cellPx.x + w / 2;
      const sy = (0 - cam.y) * cellPx.y + h / 2;
      if (favorites && areSpinesLegible({ x: sx, y: sy, w: cellPx.x, h: cellPx.y }))
        drawFavoriteSwitch(ctx, cache, sortMode, cellPx, sx, sy);
      if (distillMode !== undefined) drawDistillToggle(ctx, cache, distillMode, hoveredDistill, cellPx, sx, sy);
      if (clearHistoryAvailable) drawClearHistoryBookOverlay(ctx, cache, cellPx, sx, sy);
    }

    return { drawn, blank, level, cells: wanted.length };
  }

  return { draw };
}
