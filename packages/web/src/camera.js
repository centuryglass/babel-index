/**
 * Camera maths for the map, as pure functions.
 *
 * World units are tiles: the cell at integer (x, y) occupies the unit square
 * from (x, y) to (x+1, y+1), and the centre room sits at (0, 0). A camera is
 * `{x, y, zoom}` where x/y are the world point at the centre of the viewport
 * and zoom is pixels per tile.
 *
 * None of this touches the DOM. `useMapCamera.js` owns the pointer events and
 * the ref that holds the live camera; everything that can be stated as an
 * equation lives here instead, because the interesting properties - the
 * screen/world round-trip, and zoom keeping the point under the cursor fixed -
 * are exact invariants worth asserting.
 */

/** Zoom is clamped so a tile is never smaller than a thumbnail or larger than the screen. */
export const MIN_ZOOM = 26;
export const MAX_ZOOM = 900;

export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Viewport pixel -> world tile coordinate. `rect` is the canvas bounding box. */
export function screenToWorld(px, py, cam, rect) {
  return {
    x: cam.x + (px - rect.width / 2) / cam.zoom,
    y: cam.y + (py - rect.height / 2) / cam.zoom,
  };
}

/** World tile coordinate -> viewport pixel. The exact inverse of screenToWorld. */
export function worldToScreen(wx, wy, cam, rect) {
  return {
    x: (wx - cam.x) * cam.zoom + rect.width / 2,
    y: (wy - cam.y) * cam.zoom + rect.height / 2,
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
    x: zoomed.x + before.x - after.x,
    y: zoomed.y + before.y - after.y,
    zoom: zoomed.zoom,
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
  return {
    x: cam.x - (dxPx / cam.zoom) * scale,
    y: cam.y - (dyPx / cam.zoom) * scale,
    zoom: cam.zoom,
  };
}

/**
 * One frame of the glide back toward the content region, for when the camera
 * is released outside it. The pull is proportional to position, so it eases in
 * rather than snapping, and it is a no-op inside the region where damp is 1.
 */
export function glideStep(cam, damp) {
  if (damp >= GLIDE_EPSILON) return cam;
  const pull = (1 - damp) * 0.06 * 0.08;
  return { x: cam.x * (1 - pull), y: cam.y * (1 - pull), zoom: cam.zoom };
}

/** Resistance this close to 1 is inside the region for practical purposes. */
const GLIDE_EPSILON = 0.999;

/** Centre the camera on a cell - cells are addressed by corner, so aim at the middle. */
export function cameraAtCell(cam, x, y, zoom) {
  return { x: x + 0.5, y: y + 0.5, zoom: zoom ? clampZoom(zoom) : cam.zoom };
}
