/**
 * Camera maths for the map, as pure functions.
 *
 * World units are CELLS, and a cell is not assumed to be square. The cell at
 * integer (x, y) spans (x, y) to (x+1, y+1) in cell space, and the centre room
 * sits at (0, 0); how many pixels that is on each axis depends on the tile's
 * shape. A camera is `{x, y, zoom}` where x/y are the world point at the centre
 * of the viewport and `zoom` is pixels per cell WIDTH. Cell height follows from
 * the aspect, so one number still drives the whole scale.
 *
 * Keeping world coordinates in cells rather than pixels is what lets the tile
 * change shape without rewriting `packages/map`: slot placement and ranking are
 * in cells and do not care what a cell looks like. That module takes the aspect
 * for one purpose only - measuring distance the way it looks, so the boundary
 * is round on screen rather than round in the index.
 *
 * None of this touches the DOM. `useMapCamera.js` owns the pointer events and
 * the ref that holds the live camera; everything that can be stated as an
 * equation lives here instead, because the interesting properties - the
 * screen/world round-trip, and zoom keeping the point under the cursor fixed -
 * are exact invariants worth asserting.
 */
import { BASE_TILE } from './pyramid.js';

/**
 * Cell height as a multiple of cell width. 0.75 at the current 4:3 tile.
 *
 * Derived from the tile rather than declared, so changing `BASE_TILE` changes
 * the shape of the world along with the shape of the art. A camera may carry
 * its own `aspect` to override it, which is how the tests exercise shapes the
 * corpus is not currently in.
 */
export const CELL_ASPECT = BASE_TILE.h / BASE_TILE.w;

/** Pixels per cell on each axis, for a camera. The one place the aspect is applied. */
export function pxPerCell(cam) {
  const aspect = cam.aspect ?? CELL_ASPECT;
  return { x: cam.zoom, y: cam.zoom * aspect };
}

/**
 * Zoom is clamped so a cell is never smaller than a thumbnail or larger than
 * the screen. In pixels per cell WIDTH - a short tile is free to be shorter
 * than this, which is what "the cell is the unit" means.
 */
export const MIN_ZOOM = 26;
export const MAX_ZOOM = 900;

export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Viewport pixel -> world cell coordinate. `rect` is the canvas bounding box. */
export function screenToWorld(px, py, cam, rect) {
  const perCell = pxPerCell(cam);
  return {
    x: cam.x + (px - rect.width / 2) / perCell.x,
    y: cam.y + (py - rect.height / 2) / perCell.y,
  };
}

/** World cell coordinate -> viewport pixel. The exact inverse of screenToWorld. */
export function worldToScreen(wx, wy, cam, rect) {
  const perCell = pxPerCell(cam);
  return {
    x: (wx - cam.x) * perCell.x + rect.width / 2,
    y: (wy - cam.y) * perCell.y + rect.height / 2,
  };
}

/**
 * Zoom about a viewport point, keeping the world point under it fixed.
 *
 * That fixed point is the whole feel of scroll-to-zoom: the thing you are
 * pointing at is the thing you zoom into. Once the zoom clamps, the camera
 * must not drift either - so the recentre is computed against the clamped
 * zoom, not the requested one.
 *
 * @param {{x: number, y: number, zoom: number}} cam
 * @param {number} px viewport-relative pointer x
 * @param {number} py viewport-relative pointer y
 * @param {number} deltaY wheel delta; positive zooms out
 * @param {{width: number, height: number}} rect
 * @returns {{x: number, y: number, zoom: number}} a new camera
 */
export function zoomAt(cam, px, py, deltaY, rect) {
  const before = screenToWorld(px, py, cam, rect);
  const zoomed = { ...cam, zoom: clampZoom(cam.zoom * Math.exp(-deltaY * 0.0014)) };
  const after = screenToWorld(px, py, zoomed, rect);
  return {
    ...zoomed,
    x: zoomed.x + before.x - after.x,
    y: zoomed.y + before.y - after.y,
  };
}

/**
 * Pan by a pointer movement, damped by the map's resistance at the camera.
 *
 * `damp` is 1 inside the content region and falls toward 0 outside it, so
 * pushing outward gets progressively heavier instead of stopping at a wall.
 * A floor of 0.12 keeps the map from freezing solid however far out you drag.
 *
 * @param {{x: number, y: number, zoom: number}} cam
 * @param {number} dxPx pointer movement in pixels
 * @param {number} dyPx
 * @param {number} damp resistance at the camera, in [0, 1]
 */
export function panByPixels(cam, dxPx, dyPx, damp) {
  const scale = 0.12 + 0.88 * damp;
  const perCell = pxPerCell(cam);
  return {
    ...cam,
    x: cam.x - (dxPx / perCell.x) * scale,
    y: cam.y - (dyPx / perCell.y) * scale,
  };
}

/** Resistance this close to 1 counts as inside the region. */
const GLIDE_EPSILON = 0.999;

/**
 * One frame of the glide back toward the content region, for when the camera
 * is released outside it. The pull is proportional to position, so it eases in
 * rather than snapping. Inside the region the camera is returned unchanged, by
 * identity, so the caller can skip a redraw.
 */
export function glideStep(cam, damp) {
  if (damp >= GLIDE_EPSILON) return cam;
  const pull = (1 - damp) * 0.06 * 0.08;
  return { ...cam, x: cam.x * (1 - pull), y: cam.y * (1 - pull) };
}

/** Centre the camera on a cell - cells are addressed by corner, so aim at the middle. */
export function cameraAtCell(cam, x, y, zoom) {
  return { ...cam, x: x + 0.5, y: y + 0.5, zoom: zoom ? clampZoom(zoom) : cam.zoom };
}
