/**
 * Cutting a finite board out of an infinite map, so the illusion can be planned.
 *
 * `illusion.ts` rearranges values in a rectangle and knows nothing about rooms.
 * This is the half that knows: it turns "the map looked like *this* and must now
 * look like *that*" into the two boards, the on-camera rectangle and the fixed
 * cell that the planner takes, and it is where every assumption connecting the
 * two lives.
 *
 * ### Why a finite board is honest here
 *
 * The map has no edges and the planner's rotations wrap around. Those are only
 * compatible because the camera is parked on the center for the duration of a
 * rearrangement: the wrap happens far off camera, where nothing is drawn from
 * the board at all. Let the camera move during the animation and this stops
 * being true - which is why the board is built per rearrangement and thrown
 * away, rather than being a thing the app maintains.
 *
 * ### The board must be big enough for two different reasons
 *
 *   - It has to hold every slot of BOTH layouts, because a room the new order
 *     wants on camera has to be findable somewhere. A search reranks the whole
 *     corpus, so the room that lands beside the center may have been at the far
 *     edge a moment ago.
 *   - It has to be at least four times the on-camera rectangle, which is the
 *     planner's precondition - the cells outside the region are where values are
 *     parked, and too small a board starves that pool mid-plan.
 *
 * The second binds on a small corpus and the first on a large one, so the board
 * takes the larger. Neither costs anything to animate: every move outside the
 * region is a swap, and swaps are invisible by construction.
 *
 * ### The end board is only pinned down where it can be seen
 *
 * Outside the region the final arrangement is *free*, and taking that freedom is
 * what keeps the plan cheap. The end board is therefore the start board with the
 * region overwritten, then the multiset repaired by rewriting as few off-camera
 * cells as possible - so the planner's last phase has a region's worth of work
 * to do rather than a board's worth. What it costs is that the board stops
 * agreeing with the new layout off camera, which is exactly the part nobody can
 * see, and the board is discarded the moment the animation ends.
 *
 * ### When a rearrangement cannot be animated
 *
 * A room the new arrangement wants on camera has to already be somewhere on the
 * board. It always is when the two orders are permutations of the same placed
 * set - the reorder button, and any search at full corpus size. It is not when
 * the "rooms on the map" slider has been pulled back, because then a reorder
 * changes *which* rooms are placed at all, and a room that was not on the map
 * cannot slide in from a cell it was never in. That case returns null, and the
 * caller falls back to the instant rebuild that has always been there. Faking
 * it would mean a tile changing its face off camera and sliding on as something
 * else, which is the one thing this whole approach exists to avoid.
 */

import type { BoardValue, Rearrangement } from './moves.ts';
import type { MapLayout } from './ordering.ts';

/**
 * The center room's value. Distinct from the wallpaper so the board is
 * self-describing. Must agree with `BoardValue` in `moves.ts` - that type
 * contract can't import this runtime constant, so it re-declares the literal.
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
  // the vertical reach is that over the aspect - the same measure the map uses
  // everywhere else.
  const radius = Math.max(before.layout.boundaryRadius, after.layout.boundaryRadius);
  let halfW = Math.max(Math.ceil(radius), Math.abs(rx0), Math.abs(rx1), 5) + 1;
  let halfH = Math.max(Math.ceil(radius / aspect), Math.abs(ry0), Math.abs(ry1), 5) + 1;
  // ... and big enough that the region is under a quarter of it, which is the
  // parking pool the planner needs. Grows both axes so the board keeps its shape.
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
  // is what keeps the repair below - and the planner's last phase - small.
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

  if (!repairMultiset(start, end, delta, { width, rx0, rx1, ry0, ry1, halfW, halfH }))
    return null;

  return {
    width,
    height,
    start: { width, height, cells: start },
    end: { width, height, cells: end },
    bounds: { xmin: rx0 + halfW, xmax: rx1 + halfW, ymin: ry0 + halfH, ymax: ry1 + halfH },
    // The center room, which never moves. It is cell (0, 0) on the map and is
    // reserved by `ordering.ts`, so it holds the same value in both boards for
    // free - the planner's precondition is satisfied by the map's own design.
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
 * of others - `delta` counts exactly which, since the two boards are identical
 * everywhere else. Every surplus occurrence is an off-camera cell that can be
 * rewritten to a value that is short, and there are always as many of one as of
 * the other because both boards are the same size.
 *
 * The one way this fails is a value that is short but has no surplus occurrence
 * anywhere: a room the new arrangement wants on camera that is not on the board
 * at all. See the module comment on when that happens.
 *
 * @param end mutated in place
 * @returns whether the repair was possible
 */
function repairMultiset(
  start: BoardValue[],
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
