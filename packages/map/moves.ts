/**
 * The rearrangement animation's shared vocabulary: the board `board.js` cuts
 * out of the map, and the move list `illusion.js` plans across it and
 * `packages/web/src/lib/slide.js` lays out in time and replays.
 *
 * `Move` is a discriminated union on purpose - `shiftRow`/`shiftCol`/`swap`
 * carry different fields, and every consumer (the animation's `pushMove`, the
 * renderer's `applyMove`, the test's independent replay) switches on `type`
 * and expects the right shape to fall out. A plain `object` JSDoc type let
 * that fall out of sync silently; this is checked by `tsc --noEmit`
 * (`npm run typecheck`) against every `@type`/`@param` that names it.
 *
 * Type-only, imported through JSDoc (`@type {import('./moves.ts').Move}`),
 * same convention as `manifest.ts` - see AGENTS.md's TypeScript migration
 * note for why this stays a pure type contract rather than a runtime module.
 */

/** A board cell's coordinate, in board-local units (not map coordinates). */
export interface Point {
  x: number;
  y: number;
}

/**
 * Which line a move belongs to, for the animation's staging - see
 * `illusion.js`'s `line`/`wave` comment. `null` on a stage where every move
 * is independent of line grouping (an off-camera swap in phase 3).
 */
export interface LineRef {
  kind: 'row' | 'col';
  index: number;
}

/**
 * What a board cell holds: a room id, or one of `board.js`'s two sentinel
 * values (`CENTER`, `GENERIC`) re-declared here as literal types since a type
 * contract can't import runtime constants from a `.js` module.
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

/** Fields every move carries, regardless of `type` - see `illusion.js`. */
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

/** `board.js`'s output: the planner's inputs for one rearrangement. */
export interface Rearrangement {
  width: number;
  height: number;
  start: Board;
  end: Board;
  bounds: Bounds;
  /** The center room's board cell, held fixed by both `start` and `end`. */
  fixed: Point;
  /** Board index of map cell (0, 0) - what `slide.js` calls `origin`. */
  origin: Point;
}

/**
 * One line currently sliding, as `slide.js`'s `advanceTo` reports it for
 * `createSlideRenderer` to draw - not emitted by the planner itself.
 */
export interface Motion {
  kind: 'row' | 'col';
  index: number;
  dir: number;
  offset: number;
}
