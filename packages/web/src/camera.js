/**
 * Camera maths for the map, as pure functions.
 *
 * World units are CELLS, and a cell is not assumed to be square. The cell at
 * integer (x, y) spans (x, y) to (x+1, y+1) in cell space, and the centre room
 * sits at (0, 0); how many pixels that is on each axis depends on the tile's
 * shape. A camera is `{x, y, zoom}` where x/y are the world point at the centre
 * of the viewport and `zoom` is pixels per cell WIDTH. Cell height follows from
 * the aspect, so one number still drives the whole scale. Two optional fields
 * may ride along - `aspect` and `limits` - and every function here preserves
 * them by spreading, which is why callers must do the same.
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
 * The HARD zoom limits: a cell is never smaller than a thumbnail or larger than
 * the screen. In pixels per cell WIDTH - a short tile is free to be shorter than
 * this, which is what "the cell is the unit" means.
 *
 * This is the widest range that can ever be offered, and the range everything
 * derived is checked against - `pyramid.test.mjs` asserts every rung of the
 * ladder is reachable somewhere inside it. Configuration may narrow it (a
 * camera carries its own `limits`, below) but may never widen it, so that
 * assertion keeps covering every state the app can reach at runtime.
 */
export const ZOOM_LIMITS = { min: 26, max: 900 };

export const MIN_ZOOM = ZOOM_LIMITS.min;
export const MAX_ZOOM = ZOOM_LIMITS.max;

/**
 * Clamp a zoom into a range, defaulting to the hard limits.
 *
 * A camera may carry narrower `limits` of its own - the same optional-field
 * pattern as `aspect`, and with the same requirement: spread the old camera
 * rather than rebuilding `{x, y, zoom}`, or the range is lost mid-gesture along
 * with the shape.
 */
export const clampZoom = (z, limits = ZOOM_LIMITS) =>
  Math.min(limits.max, Math.max(limits.min, z));

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
 * Scale the zoom about a viewport point, keeping the world point under it fixed.
 *
 * That fixed point is the whole feel of both zoom gestures: the thing you are
 * pointing at, or the thing between your fingers, is the thing you zoom into.
 * Once the zoom clamps, the camera must not drift either - so the recentre is
 * computed against the clamped zoom, not the requested one.
 *
 * Taking a multiplier rather than a wheel delta is what lets a pinch share this:
 * a pinch knows the ratio its fingers moved and has no delta to invent.
 *
 * @param {{x: number, y: number, zoom: number}} cam
 * @param {number} px viewport-relative anchor x
 * @param {number} py viewport-relative anchor y
 * @param {number} factor multiplier on the zoom; >1 zooms in
 * @param {{width: number, height: number}} rect
 * @returns {{x: number, y: number, zoom: number}} a new camera
 */
export function zoomBy(cam, px, py, factor, rect) {
  const before = screenToWorld(px, py, cam, rect);
  const zoomed = { ...cam, zoom: clampZoom(cam.zoom * factor, cam.limits) };
  const after = screenToWorld(px, py, zoomed, rect);
  return {
    ...zoomed,
    x: zoomed.x + before.x - after.x,
    y: zoomed.y + before.y - after.y,
  };
}

/**
 * How much of a wheel delta becomes zoom. Exponential so the feel is the same
 * at every scale - a notch is a fixed *ratio*, not a fixed number of pixels.
 */
export const WHEEL_ZOOM_RATE = 0.0014;

/**
 * Zoom about a viewport point from a wheel delta; positive `deltaY` zooms out.
 *
 * @param {{x: number, y: number, zoom: number}} cam
 * @param {number} px viewport-relative pointer x
 * @param {number} py viewport-relative pointer y
 * @param {number} deltaY
 * @param {{width: number, height: number}} rect
 */
export function zoomAt(cam, px, py, deltaY, rect) {
  return zoomBy(cam, px, py, Math.exp(-deltaY * WHEEL_ZOOM_RATE), rect);
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
  return { ...cam, x: x + 0.5, y: y + 0.5, zoom: zoom ? clampZoom(zoom, cam.limits) : cam.zoom };
}

/**
 * How long a camera flight takes by default, in milliseconds.
 *
 * The value that ships, not the only statement of it: `packages/config` imports
 * this as `camera.flightMs`, so a `config.json` can retune it and the resolved
 * number rides to the client on the manifest. Stated here because this is where
 * `beginFlight` needs a default, and imported there rather than restated so the
 * two cannot drift.
 *
 * How long a transition should take is a judgement about the map in front of
 * you, which is the same argument that puts the search weights in config. It
 * is emphatically not derived from anything - the tests assert the shape of the
 * curve, never this number - so moving it can invalidate nothing.
 */
export const FLIGHT_MS = 450;

/**
 * Smoothstep: slow at both ends, quickest in the middle, no magic numbers.
 *
 * Zero velocity on arrival is the half that matters - a flight that stops at
 * full speed reads as a jerk, and "centre" is a button people press repeatedly.
 */
export const easeInOut = (t) => t * t * (3 - 2 * t);

/**
 * Begin a flight from one camera to another, as a value.
 *
 * Both endpoints are whole cameras, so `aspect` and `limits` come along without
 * this having to know they exist - build the target with `cameraAtCell` and the
 * clamping has already happened. `from` being the LIVE camera rather than some
 * remembered one is what makes a second flight during a first pick up smoothly
 * from wherever it had got to.
 */
export function beginFlight(from, to, now, ms = FLIGHT_MS) {
  return { from, to, t0: now, ms };
}

/**
 * The camera part way through a flight, and whether it has arrived.
 *
 * **Zoom interpolates geometrically, position linearly**, and the asymmetry is
 * the whole content of this function. Zoom is pixels per cell, so a linear ramp
 * from 26 to 900 spends nearly all of its time close to 900 and the flight
 * looks like a snap followed by a crawl; the ratio is what the eye reads, which
 * is the same reason the wheel is exponential. Position has no such problem
 * over the distances this map flies - tens of cells, not a continent - so the
 * zoom-out-and-back arc that a world-scale flight needs would be machinery
 * bought for a case that does not arise.
 *
 * `ms <= 0` arrives immediately, which is how a caller honouring
 * `prefers-reduced-motion` asks for the old teleport without a second path.
 */
export function flightAt(flight, now) {
  const { from, to, t0, ms } = flight;
  const t = ms > 0 ? (now - t0) / ms : 1;
  // Landing returns the target itself, so a flight ends exactly where it was
  // aimed rather than within a rounding error of it.
  if (t >= 1) return { cam: to, done: true };
  const e = easeInOut(Math.max(0, t));
  return {
    cam: {
      ...to,
      x: from.x + (to.x - from.x) * e,
      y: from.y + (to.y - from.y) * e,
      zoom: from.zoom * Math.pow(to.zoom / from.zoom, e),
    },
    done: false,
  };
}
