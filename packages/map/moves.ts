/**
 * The rearrangement animation's shared vocabulary: the board `board.ts` cuts
 * out of the map, the move list `illusion.ts` plans across it, and
 * `packages/web/src/lib/slide.ts` lays it out in time and replays it.
 *
 * `Move` is a discriminated union because its three variants carry different
 * fields: every consumer - `slide.ts`'s `pushMove`, the renderers' `applyMove`,
 * `illusion.test.ts`'s independent replay - switches on `type` before reading
 * one.
 *
 * Types only, reached through `import type`, like `manifest.ts`.
 */

/** A board cell's coordinate, in board-local units (not map coordinates). */
export interface Point {
  x: number;
  y: number;
}

/**
 * Which line a move belongs to, for the animation's staging - see the staging
 * note in `illusion.ts`'s primitives section. `null` on a stage where line
 * grouping means nothing: phase 3's off-camera swaps.
 */
export interface LineRef {
  kind: 'row' | 'col';
  index: number;
}

/**
 * What a board cell holds: a room id, or one of `board.ts`'s two sentinel
 * values (`CENTER`, `GENERIC`), re-declared here as literal types because a
 * type-only file imports nothing at runtime.
 */
export type BoardValue = number | 'center' | 'generic';

/** A rectangular grid of board values, row-major, `width * height` long. */
export interface Board<V = BoardValue> {
  width: number;
  height: number;
  cells: V[];
}

/** The on-camera rectangle in board coordinates, inclusive on every side. */
export interface Bounds {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

/**
 * Fields every move carries, whatever its `type` - what each one means is in
 * `illusion.ts`'s primitives section.
 */
interface MoveBase {
  stage: number;
  wave: boolean;
  line: LineRef | null;
}

/** Rotate row `row` rightward by `distance` cells (negative is leftward). */
export interface ShiftRowMove extends MoveBase {
  type: 'shiftRow';
  row: number;
  distance: number;
}

/** Rotate column `col` downward by `distance` cells (negative is upward). */
export interface ShiftColMove extends MoveBase {
  type: 'shiftCol';
  col: number;
  distance: number;
}

/** Exchange the values at `a` and `b`, both required to be off camera. */
export interface SwapMove extends MoveBase {
  type: 'swap';
  a: Point;
  b: Point;
}

/** One step of a rearrangement plan, as `planMoves` emits it. */
export type Move = ShiftRowMove | ShiftColMove | SwapMove;

/** `board.ts`'s output: everything `planMoves` takes for one rearrangement. */
export interface Rearrangement {
  width: number;
  height: number;
  start: Board;
  end: Board;
  bounds: Bounds;
  /** The center room's board cell. Same value in `start` and `end`, so the planner never moves it. */
  fixed: Point;
  /** The board cell that map cell (0, 0) lands in - `slide.ts` draws relative to it. */
  origin: Point;
}

/**
 * One line currently sliding, as `slide.ts`'s `advanceTo` reports it for
 * `createSlideRenderer` to draw - not emitted by the planner itself.
 */
export interface Motion {
  kind: 'row' | 'col';
  index: number;
  dir: number;
  offset: number;
}
