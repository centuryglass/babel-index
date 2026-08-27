/**
 * Ctrl+arrow's walk: the next room in a straight line, skipping wallpaper.
 *
 * The wallpaper problem's answer without a mode (accessibility-plan.md §4.2a) -
 * arrow is a cell, ctrl+arrow is the next thing worth stopping at, exactly as
 * arrow is a character and ctrl+arrow is a word in a text editor. A movement,
 * not a toggle, so nothing has to be remembered between keypresses.
 *
 * No DOM, no imports - `layout.rankOf` is a Map lookup, so the walk is cheap
 * enough to bound generously rather than tune tightly.
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
 * @param direction one of the four axis directions; exactly one of `dx`/`dy`
 *   should be nonzero
 * @returns the nearest room strictly in that direction, or null if none is
 *   found before the walk gives up
 */
export function nextRoom(layout: WalkableLayout, from: Cell, { dx, dy }: Direction): Cell | null {
  // A room can sit anywhere within `boundaryRadius` of the ORIGIN, not of
  // `from` - so a cursor standing at one edge of the content region can need
  // to cross close to the full span to reach a room at the other edge. Steps
  // are cheap (one Map lookup each), so the bound is generous on purpose
  // rather than tuned tight; accessibility-plan.md §8 item 5 leaves the exact
  // number an open, by-feel question.
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
