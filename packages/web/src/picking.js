/**
 * Which room is under a point on screen.
 *
 * Split out of the pointer plumbing for the usual reason: this is the part with
 * a right answer, and it can be asserted without a browser. The hook decides
 * *when* a pick happened - a right-click, a long press that did not become a
 * drag - and this decides *what* was picked.
 *
 * Cells are addressed by their lower corner and span one unit, so the cell
 * holding a world point is that point floored on both axes. `screenToWorld`
 * already applies the camera's aspect, so nothing here needs to know the tile
 * is not square.
 *
 * No DOM.
 */
import { screenToWorld } from './camera.js';

/**
 * @param {number} px viewport-relative x
 * @param {number} py viewport-relative y
 * @param {object} cam
 * @param {{width: number, height: number}} rect
 * @param {object} layout from `createLayout()`
 * @param {number[]} order the ranking currently on the map
 * @returns {{id: number, rank: number, x: number, y: number}|null}
 *   null for the centre room and for generic cells - neither has anything to
 *   show, and opening an empty card over the wallpaper would make the gesture
 *   feel broken rather than empty
 */
export function roomAtPoint(px, py, cam, rect, layout, order) {
  const world = screenToWorld(px, py, cam, rect);
  const x = Math.floor(world.x);
  const y = Math.floor(world.y);

  const at = layout.roomAt(x, y, order);
  if (at.centre || at.generic) return null;
  return { id: at.id, rank: at.rank, x, y };
}
