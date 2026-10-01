/**
 * The per-cell decisions of a rearrangement frame, made once for both slide
 * renderers - `framePlan.ts`'s counterpart for `slide.ts` and
 * `glSlideRenderer.ts`.
 *
 * It plans a finite board under a camera parked for the animation, with
 * lines part-way through a slide (`slide.ts`'s `createSlideshow` reports
 * them). Each cell's tile, fade and badge come from `framePlan.ts`'s shared
 * rules, so a sliding tile looks like the still one it hands back to.
 */
import { PYRAMID, type Pyramid } from './pyramid.ts';
import { pxPerCell, type Camera } from './camera.ts';
import { CENTER, genericId, genericDistillId, type RoomId, type TileCache } from './tiles.ts';
import { areSpinesLegible } from './center.ts';
import { createDrawList } from './drawList.ts';
import {
  planCell, planFavoriteBadge, planFavoriteSwitch, planDistillToggle, planClearHistoryBook, smoothingFor,
} from './framePlan.ts';
import { CENTER as BOARD_CENTER, GENERIC as BOARD_GENERIC } from '../../../map/board.ts';
import type { Board, BoardValue, Motion, Point } from '../../../map/moves.ts';
import type { SortMode } from '../../../map/favorites.ts';

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
export const idFor = (
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

/** The state of the board a rearrangement frame is planned from; each renderer adds its context. */
export interface SlideFrameOpts {
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
  /** overlay a favorite badge on every real room's tile - see `framePlan.ts`'s `MapFrameOpts.favorites` */
  favorites?: { isFavorite: (id: number) => boolean } | null;
  /** which ranking is in force, for the center tile's favorites-sort switch - see `framePlan.ts`'s `MapFrameOpts.sortMode` */
  sortMode?: SortMode;
  /** distill mode's crossfade over generic tiles - see `framePlan.ts`'s `MapFrameOpts.genericFade` */
  genericFade?: number;
  /** whether distill mode is on - see `framePlan.ts`'s `MapFrameOpts.distillMode` */
  distillMode?: boolean;
  /** whether the pointer is over the distill toggle - see `framePlan.ts`'s `MapFrameOpts.hoveredDistill` */
  hoveredDistill?: boolean;
  /**
   * Whether the "forget searches" book's slot is claimed - the caller's
   * reduction of `centreSlots[BOOK_COUNT - 1]?.action === 'forgetHistory'`,
   * the check `createMapPlanner` makes directly. This planner receives no
   * `centreSlots` at all: it plans no spine text.
   */
  clearHistoryAvailable?: boolean;
}

export interface SlideDrawResult {
  drawn: number;
  blank: number;
  level: number;
  cells: number;
}

export interface CreateSlidePlannerOpts {
  cache: TileCache;
  pyramid?: Pyramid;
}

/**
 * One renderer's slide planner. `plan()` fills `list` for a frame and returns
 * its stats; the list is reused, so paint it before the next `plan()`.
 */
export function createSlidePlanner({ cache, pyramid = PYRAMID }: CreateSlidePlannerOpts) {
  const list = createDrawList();

  function plan({
    width: w, height: h, dpr, cam, board, origin, motions = [], genericIndexAt = () => -1, chrome = true,
    favorites = null, sortMode = 'relevance', genericFade = 0, distillMode, hoveredDistill = false,
    clearHistoryAvailable = false,
  }: SlideFrameOpts): SlideDrawResult {
    cache.beginFrame();

    // No background fill: same reasoning as `createMapPlanner` - the still
    // field plus the moving lines' padded ranges cover the whole viewport
    // with no gaps (`slide.test.ts`'s "every visible cell is painted in every
    // frame, including mid-slide" asserts it), and every cell plans
    // something.
    const cellPx = pxPerCell(cam);
    const level = pyramid.pickLevel({ w: cellPx.x * dpr, h: cellPx.y * dpr }, null);
    list.reset(dpr, smoothingFor(pyramid, level, cellPx, dpr));

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
    // +1 on each axis kills hairline gaps from rounding, as in `createMapPlanner`.
    const cw = cellPx.x + 1;
    const ch = cellPx.y + 1;

    let drawn = 0;
    let blank = 0;
    let cells = 0;

    const cell = (value: BoardValue, homeMx: number, homeMy: number, drawMx: number, drawMy: number): void => {
      const sx = (drawMx - cam.x) * cellPx.x + w / 2;
      const sy = (drawMy - cam.y) * cellPx.y + h / 2;
      const id = idFor(value, homeMx, homeMy, genericIndexAt);
      const distillId = value === BOARD_GENERIC ? genericDistillId(genericIndexAt(homeMx, homeMy)) : null;
      const outcome = planCell(list, cache, id, distillId, genericFade, level, sx, sy, cw, ch);
      cells++;
      if (outcome === 'faded') return;
      if (outcome === 'blank') blank++;
      else drawn++;
      // The favorite badge rides along with a sliding tile. Only real rooms
      // carry one - which is when `value` is a numeric id rather than one of
      // the two shared board values.
      if (favorites && typeof value === 'number')
        planFavoriteBadge(list, cache, favorites.isFavorite(value), cellPx, sx, sy, level);
    };

    // The still field. Lines in motion are skipped here and planned after, so
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
        cell(valueAt(mx + origin.x, my + origin.y), mx, my, mx, my);
      }

    // Each line in motion, extended by however far it has travelled so the
    // cells sliding in from off screen are planned too.
    for (const m of motions) {
      const shift = m.offset * m.dir;
      const pad = Math.ceil(Math.abs(shift)) + 1;
      if (m.kind === 'row')
        for (let mx = x0 - pad; mx <= x1 + pad; mx++)
          cell(valueAt(mx + origin.x, m.index), mx, m.index - origin.y, mx + shift, m.index - origin.y);
      else
        for (let my = y0 - pad; my <= y1 + pad; my++)
          cell(valueAt(m.index, my + origin.y), m.index - origin.x, my, m.index - origin.x, my + shift);
    }

    // The tiles about to arrive: a ring outside the viewport, at the one level
    // this animation ever uses. Behind everything visible, as always.
    for (let my = y0 - 2; my <= y1 + 2; my++)
      for (let mx = x0 - 2; mx <= x1 + 2; mx++)
        if (my < y0 || my > y1 || mx < x0 || mx > x1)
          cache.prefetch(idFor(valueAt(mx + origin.x, my + origin.y), mx, my, genericIndexAt), level);

    if (chrome) {
      // The center tile's controls, planned for the whole animation - see
      // `planFavoriteSwitch`'s doc for why the handoff needs them. The gates
      // are the ones `createMapPlanner` uses: a favorite store and legible
      // spines for the switch, an opted-in `distillMode` for the toggle,
      // `clearHistoryAvailable` for the black spine.
      //
      // The center room itself has not moved, by construction.
      const sx = (0 - cam.x) * cellPx.x + w / 2;
      const sy = (0 - cam.y) * cellPx.y + h / 2;
      if (favorites && areSpinesLegible({ x: sx, y: sy, w: cellPx.x, h: cellPx.y }))
        planFavoriteSwitch(list, cache, sortMode, cellPx, sx, sy);
      if (distillMode !== undefined) planDistillToggle(list, cache, distillMode, hoveredDistill, cellPx, sx, sy);
      if (clearHistoryAvailable) planClearHistoryBook(list, cache, cellPx, sx, sy);
    }

    return { drawn, blank, level, cells };
  }

  return { plan, list };
}
