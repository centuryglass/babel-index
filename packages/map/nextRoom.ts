/**
 * Ctrl+arrow's walk: the next room in a straight line, skipping wallpaper.
 *
 * Arrow moves one cell, ctrl+arrow the next thing worth stopping at - the same
 * split as a character and a word in a text editor. A movement rather than a
 * toggle, so nothing has to be remembered between keypresses.
 */

export interface Cell {
  x: number;
  y: number;
}

interface Direction {
  dx: number;
  dy: number;
}

/** The slice of `createLayout()`'s return this walk actually reads. */
interface WalkableLayout {
  boundaryRadius: number;
  rankOf(x: number, y: number): number;
}

/**
 * @param from the cell to walk from - never returned, even if it is itself a room
 * @param direction one of the four axis directions, so exactly one of `dx`/`dy`
 *   is nonzero
 * @returns the nearest room strictly in that direction, or null if none is
 *   found before the walk gives up
 */
export function nextRoom(layout: WalkableLayout, from: Cell, { dx, dy }: Direction): Cell | null {
  // A room can sit anywhere within `boundaryRadius` of the origin, not of
  // `from`, so a cursor at one edge of the content region may have to cross
  // close to the full span to reach a room at the other. Each step is one Map
  // lookup, so the bound is generous rather than tuned - how generous is a
  // feel call.
  const maxSteps = Math.ceil(layout.boundaryRadius * 3) + 8;

  let x = from.x;
  let y = from.y;
  for (let i = 0; i < maxSteps; i++) {
    x += dx;
    y += dy;
    if (layout.rankOf(x, y) !== -1) return { x, y };
  }
  return null;
}
