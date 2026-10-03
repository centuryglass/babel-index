/**
 * The rearrangement animation: a second renderer, for the one moment the map
 * is not a map.
 *
 * `framePlan.ts` plans an infinite world under a camera the reader controls;
 * `slidePlan.ts` plans a finite board under a camera parked for the
 * animation's duration, with one row or column part-way through a slide.
 * This file lays the moves out in time and drives the board. The two planners
 * stay separate because a shared one would thread "is something sliding"
 * through every other decision; they share the per-cell and overlay rules.
 * `main.tsx` picks which renderer is drawing, and the animation ends by
 * handing back.
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
 * The durations (config's `slide` section) are by-feel numbers, so they live in `packages/config`,
 * and this file states no fallback for them - the same rule
 * `useMapCamera.ts` gives for the flight duration, and docs/agents/map.md's
 * "Consuming files state no fallback defaults". What this file owns is how a
 * plan is laid out in time; what the numbers should be is somebody else's
 * question.
 *
 * The visible cost is the region's, not the collection's: only lines crossing the
 * on-camera rectangle ever slide. The duration is set by the viewport, and
 * collection size does not enter into it.
 */
import type { Pyramid } from './pyramid.ts';
import type { TileCache } from './tiles.ts';
import type { Board, Motion, Move } from '../../../map/moves.ts';
import type { Config } from '../../../config/config.ts';
import { paintCanvas2D, type DrawContext } from './render.ts';
import { createSlidePlanner, type SlideDrawResult, type SlideFrameOpts } from './slidePlan.ts';
import type { Overlays } from '../../../map/overlays.ts';

export type { SlideDrawResult };

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
      // collection keeps most of its rooms on camera, so it needs many of them.
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
 * strictly in sequence the distinction is invisible; once they overlap it
 * decides when the swap lands - see the cascade in `buildTimeline`.
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
  /** `manifest.overlays` - see `framePlan.ts`'s `CreateMapPlannerOpts`. */
  overlays: Overlays;
  pyramid?: Pyramid;
}

/** `slidePlan.ts`'s `SlideFrameOpts` plus the context to paint on. */
export type SlideDrawOpts = SlideFrameOpts & { ctx: DrawContext };

/**
 * Draw one frame of the animation: `slidePlan.ts` decides it and
 * `render.ts`'s `paintCanvas2D` paints it, so a frame's decisions are
 * assertable without a browser.
 */
export function createSlideRenderer({ cache, overlays, pyramid }: CreateSlideRendererOpts) {
  const planner = createSlidePlanner({ cache, overlays, pyramid });

  function draw({ ctx, ...opts }: SlideDrawOpts): SlideDrawResult {
    const result = planner.plan(opts);
    paintCanvas2D(ctx, planner.list);
    return result;
  }

  return { draw };
}
