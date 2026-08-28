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

interface Camera {
  x: number;
  y: number;
  zoom: number;
  aspect?: number;
}

interface Rect {
  width: number;
  height: number;
}

type RoomAtResult =
  | { center: true }
  | { generic: true }
  | { generic: false; id: number; rank: number };

/** The slice of `createLayout()`'s return this pick actually reads. */
interface PickableLayout {
  roomAt(x: number, y: number, order: number[]): RoomAtResult;
}

export type RoomPick = { id: number; rank: number; x: number; y: number } | { generic: true; x: number; y: number };

/**
 * @param px viewport-relative x
 * @param py viewport-relative y
 * @param order the ranking currently on the map
 * @returns null only for the center room - it is the controls, not a room, and
 *   has no description to show.
 */
export function roomAtPoint(
  px: number, py: number, cam: Camera, rect: Rect, layout: PickableLayout, order: number[]
): RoomPick | null {
  const world = screenToWorld(px, py, cam, rect);
  const x = Math.floor(world.x);
  const y = Math.floor(world.y);

  const at = layout.roomAt(x, y, order);
  if ('center' in at) return null;
  if (at.generic === true) return { generic: true, x, y };
  return { id: at.id, rank: at.rank, x, y };
}
