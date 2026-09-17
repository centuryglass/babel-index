/**
 * Cut a finite board out of the infinite map so a rearrangement can be planned.
 *
 * `illusion.ts` rearranges values in a rectangle and knows nothing about rooms.
 * This is the half that knows: it turns "the map looked like this and must now
 * look like that" into the two boards, the on-camera rectangle, and the fixed
 * cell, and it is where every assumption connecting the two lives.
 *
 * ### A finite board with a parked camera
 *
 * The map has no edges and the planner's rotations wrap around. Those are
 * compatible because the camera is parked for the whole rearrangement, so the
 * wrap happens off camera, where nothing is drawn from the board at all. Move
 * the camera mid-animation and this stops holding, which is why a board is
 * built per rearrangement and thrown away.
 *
 * ### Two size bounds
 *
 *   - It has to hold every slot of both layouts, because a room the new order
 *     wants on camera has to be findable somewhere. A search reranks the whole
 *     corpus, so the room that lands beside the center may have been at the far
 *     edge a moment ago.
 *   - It has to be at least four times the on-camera rectangle: the cells
 *     outside the region are where values are parked, and a board too small
 *     starves that pool mid-plan. `illusion.ts`'s `validate` refuses it.
 *
 * The second binds on a small corpus and the first on a large one, so the board
 * takes the larger. Neither costs anything to animate: every move outside the
 * region is a swap.
 *
 * ### The end board is pinned only where it can be seen
 *
 * Outside the region the final arrangement is free, and taking that freedom is
 * what keeps the plan short. The end board is the start board with the region
 * overwritten, then repaired to a matching multiset by rewriting as few
 * off-camera cells as possible, so the planner's last phase has a region's
 * worth of work instead of a board's worth. The cost is that the board stops
 * agreeing with the new layout off camera - the part nobody can see, on a board
 * that is discarded when the animation ends.
 *
 * ### When a rearrangement cannot be animated
 *
 * A room the new arrangement wants on camera has to already be somewhere on the
 * board. It always is when the two orders are permutations of the same placed
 * set - the reorder button, and any search at full corpus size. It is not when
 * the "rooms on the map" slider has been pulled back, because then a reorder
 * changes which rooms are placed at all, and a room that was not on the map
 * cannot slide in from a cell it was never in. That case returns null and the
 * caller falls back to an instant rebuild; the alternative is a tile changing
 * its face off camera and arriving as something else.
 */

import type { BoardValue, Rearrangement } from './moves.ts';
import type { MapLayout } from './ordering.ts';

/**
 * The center room's value. Distinct from the wallpaper so the board is
 * self-describing. Its string has to stay `'center'`: `moves.ts`'s `BoardValue`
 * re-declares the literal and cannot import this one.
 */
export const CENTER = 'center';

/** Every generic room. One value, repeated across most of the board, on purpose. */
export const GENERIC = 'generic';

/** One arrangement of the map: its layout and the ranking poured into it. */
interface Arrangement {
  layout: MapLayout;
  order: number[];
}

/** Visible cell bounds, inclusive, in map coordinates - the renderer's own bounds. */
interface View {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface BuildRearrangementOptions {
  /** what is on screen now */
  before: Arrangement;
  /** what it must become */
  after: Arrangement;
  view: View;
  /** cell height / cell width, so the board is as round as the map is */
  aspect: number;
  /**
   * cells of slack around the viewport. Must be at least 1: the planner swaps
   * into the cell just outside the region and then slides it inward, so a
   * region hugging the viewport would put that swap on a partially visible
   * cell and the illusion would break at the edge of the screen
   */
  margin?: number;
}

/**
 * Build the planner's inputs for a rearrangement.
 *
 * @returns null when the rearrangement cannot be animated legally
 */
export function buildRearrangement({
  before,
  after,
  view,
  aspect,
  margin = 1,
}: BuildRearrangementOptions): Rearrangement | null {
  if (!(margin >= 1)) throw new RangeError('margin must be at least 1 - see the doc comment');

  // The on-camera rectangle, in map coordinates.
  const rx0 = view.x0 - margin;
  const rx1 = view.x1 + margin;
  const ry0 = view.y0 - margin;
  const ry1 = view.y1 + margin;
  const regionArea = (rx1 - rx0 + 1) * (ry1 - ry0 + 1);

  // Far enough out to hold every slot either layout uses, and at least one cell
  // clear of the region on every side. `boundaryRadius` is in cell widths, so
  // the vertical reach divides it by `aspect` - the same weighting
  // `cellDistance` gives the y axis.
  const radius = Math.max(before.layout.boundaryRadius, after.layout.boundaryRadius);
  let halfW = Math.max(Math.ceil(radius), Math.abs(rx0), Math.abs(rx1), 5) + 1;
  let halfH = Math.max(Math.ceil(radius / aspect), Math.abs(ry0), Math.abs(ry1), 5) + 1;
  // `validate`'s quarter-board rule, met by growing both axes together so the
  // board keeps the map's shape.
  while (regionArea * 4 >= (2 * halfW + 1) * (2 * halfH + 1)) {
    halfW = Math.ceil(halfW * 1.3) + 1;
    halfH = Math.ceil(halfH * 1.3) + 1;
  }

  const width = 2 * halfW + 1;
  const height = 2 * halfH + 1;
  const at = (mx: number, my: number) => (my + halfH) * width + (mx + halfW);

  const start: BoardValue[] = new Array(width * height);
  for (let by = 0; by < height; by++)
    for (let bx = 0; bx < width; bx++)
      start[by * width + bx] = valueAt(before, bx - halfW, by - halfH);

  // The end board: the start board with the region overwritten by what the new
  // arrangement puts there. Everything outside is still the start board, which
  // is what keeps `repairMultiset`, and so the planner's last phase, small.
  const end = start.slice();
  const delta = new Map<BoardValue, number>();
  const bump = (v: BoardValue, n: number) => delta.set(v, (delta.get(v) ?? 0) + n);
  for (let my = ry0; my <= ry1; my++)
    for (let mx = rx0; mx <= rx1; mx++) {
      const p = at(mx, my);
      end[p] = valueAt(after, mx, my);
      bump(start[p], -1);
      bump(end[p], 1);
    }

  if (!repairMultiset(end, delta, { width, rx0, rx1, ry0, ry1, halfW, halfH }))
    return null;

  return {
    width,
    height,
    start: { width, height, cells: start },
    end: { width, height, cells: end },
    bounds: { xmin: rx0 + halfW, xmax: rx1 + halfW, ymin: ry0 + halfH, ymax: ry1 + halfH },
    // The center room, which never moves. It is map cell (0, 0), reserved by
    // `ordering.ts`, so both boards hold the same value here for free: the
    // planner's precondition is satisfied by the layout's own design.
    fixed: { x: halfW, y: halfH },
    origin: { x: halfW, y: halfH },
  };
}

/** What one arrangement puts at a map cell. */
function valueAt({ layout, order }: Arrangement, mx: number, my: number): BoardValue {
  const cell = layout.roomAt(mx, my, order);
  if (cell.center) return CENTER;
  return cell.generic ? GENERIC : cell.id;
}

interface RepairGeometry {
  width: number;
  rx0: number;
  rx1: number;
  ry0: number;
  ry1: number;
  halfW: number;
  halfH: number;
}

/**
 * Make the two boards agree as multisets, by rewriting off-camera cells.
 *
 * Overwriting the region left `end` holding too many of some values and too few
 * of others; `delta` counts which, since the two boards are identical
 * everywhere else. Every surplus occurrence is an off-camera cell that can be
 * rewritten to a value that is short, and there are always as many of one as of
 * the other because both boards are the same size.
 *
 * The one way this fails is a value that is short but has no surplus occurrence
 * anywhere: a room the new arrangement wants on camera that is not on the board
 * at all. See *When a rearrangement cannot be animated* in the module header.
 *
 * @param end mutated in place
 * @returns whether the repair was possible
 */
function repairMultiset(
  end: BoardValue[],
  delta: Map<BoardValue, number>,
  geom: RepairGeometry
): boolean {
  const { width, rx0, rx1, ry0, ry1, halfW, halfH } = geom;

  const short: BoardValue[] = [];
  for (const [v, d] of delta) for (let i = 0; i < -d; i++) short.push(v);
  if (short.length === 0) return true;

  let taken = 0;
  for (let p = 0; p < end.length && taken < short.length; p++) {
    const bx = p % width;
    const by = (p - bx) / width;
    const mx = bx - halfW;
    const my = by - halfH;
    if (mx >= rx0 && mx <= rx1 && my >= ry0 && my <= ry1) continue; // on camera

    const v = end[p];
    if ((delta.get(v) ?? 0) <= 0) continue; // not a surplus occurrence
    delta.set(v, (delta.get(v) as number) - 1);
    end[p] = short[taken++];
  }

  return taken === short.length;
}
