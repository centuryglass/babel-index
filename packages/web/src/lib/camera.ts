/**
 * Camera maths for the map, as pure functions.
 *
 * World units are cells, and a cell is not square. The cell at integer (x, y)
 * spans to (x+1, y+1), and the center room sits at (0, 0). A camera is
 * `{x, y, zoom}`, where x/y are the world point at the center of the viewport
 * and `zoom` is pixels per cell width; cell height follows from the aspect, so
 * one number still drives the whole scale. `aspect` and `limits` are optional
 * fields that ride on a camera, and every function here preserves them by
 * spreading, which is why callers must spread too.
 *
 * Keeping the base unit a cell rather than a pixel is what lets the tile change
 * shape without rewriting `packages/map`: slot placement and ranking are in
 * cells and do not care what a cell looks like. That module reads the aspect for
 * one purpose, stated in docs/agents/map.md's "packages/map measures distance
 * as it looks".
 *
 * Nothing here touches the DOM; `useMapCamera.ts` owns the pointer events and
 * the ref holding the live camera. What can be stated as an equation is here, so
 * the screen/world round-trip and the fixed point under a zoom can be asserted
 * without a browser.
 */
import { BASE_TILE } from './pyramid.ts';

/** The hard or configured zoom range, riding on a camera as `limits`. */
export interface ZoomLimits {
  min: number;
  max: number;
}

/**
 * The map camera. `x`/`y` are the world cell at the center of the viewport;
 * `zoom` is pixels per cell *width*. `aspect` and `limits` are optional, and
 * once present every operation in this file carries them through by spreading.
 */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
  aspect?: number;
  limits?: ZoomLimits;
}

/** A viewport-relative pixel rect - the canvas bounding box. */
export interface ViewportRect {
  width: number;
  height: number;
}

/** A world point, in cells. */
export interface WorldPoint {
  x: number;
  y: number;
}

/** A screen point, in viewport-relative pixels. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** A camera flight in progress, as a value - see `beginFlight`/`flightAt`. */
export interface Flight {
  from: Camera;
  to: Camera;
  t0: number;
  ms: number;
}

/** `flightAt`'s result: the camera part way through, and whether it has arrived. */
export interface FlightState {
  cam: Camera;
  done: boolean;
}

/** 'cell' or 'region': what kind of thing the cursor names at a given zoom. */
export type CursorGranularity = 'cell' | 'region';

// --- the cell's shape, the zoom range, and fitting a view to it ------------

/**
 * Cell height as a multiple of cell width, derived from `BASE_TILE` so a change
 * to the art's shape changes the shape of the world with it. A camera may carry
 * its own `aspect` to override this, which is how the tests exercise shapes the
 * corpus is not in.
 */
export const CELL_ASPECT = BASE_TILE.h / BASE_TILE.w;

/** Pixels per cell on each axis, for a camera. The one place the aspect is applied. */
export function pxPerCell(cam: Camera): { x: number; y: number } {
  const aspect = cam.aspect ?? CELL_ASPECT;
  return { x: cam.zoom, y: cam.zoom * aspect };
}

/**
 * How far past the tile's native resolution the camera may zoom, as a multiple
 * of the tile width. At 1x a cell is drawn at the art's own size; past that the
 * flat base tile is upscaled and softens, so 2x is the practical ceiling -
 * enough for a spine to be comfortably readable, before the blur outruns the
 * benefit.
 *
 * Raise it once the center tile earns a finer-than-level-0 pyramid rung (see
 * issue #268). The page-load view is capped at 1x separately,
 * by `openingZoom` in `center.ts`, so a load is never already upscaled while a
 * reader may still zoom to this ceiling by hand.
 */
export const MAX_ZOOM_FACTOR = 2;

/**
 * The hard zoom limits, as pixels per cell width: never smaller than a
 * thumbnail, never past `MAX_ZOOM_FACTOR` times the tile's native width. The
 * max derives from `BASE_TILE` so it tracks the art's resolution rather than
 * restating it, and a short tile is free to be shorter than the min - that is
 * what "the cell is the unit" means.
 *
 * This is the widest range that can ever be offered, and the range everything
 * derived is checked against: `pyramid.test.ts` asserts every rung of the ladder
 * is reachable somewhere inside it. Configuration may narrow it - a camera
 * carries its own `limits` - but never widen it, so that assertion keeps
 * covering every state the app can reach at runtime.
 */
export const ZOOM_LIMITS: ZoomLimits = { min: 26, max: BASE_TILE.w * MAX_ZOOM_FACTOR };

export const MIN_ZOOM = ZOOM_LIMITS.min;
export const MAX_ZOOM = ZOOM_LIMITS.max;

/** Clamp a zoom into a range, defaulting to `ZOOM_LIMITS` when a camera carries none. */
export const clampZoom = (z: number, limits: ZoomLimits = ZOOM_LIMITS): number =>
  Math.min(limits.max, Math.max(limits.min, z));

/**
 * The zoom at which a target rectangle fills a viewport without overflowing it.
 *
 * `target` is in cell fractions - `{w, h}` where `w` is a fraction of the cell
 * *width* and `h` of the cell *height*, the same basis `layout({width: 1,
 * height: 1})` returns. On screen that rect is `zoom*w` wide and
 * `zoom*aspect*h` tall, so the fit is the smaller of the two axis ratios: the
 * axis that would spill off the edge first. The result is clamped into
 * `limits`, so a target that wants more zoom than the camera allows opens at
 * the cap. A `margin` below 1 leaves breathing room - 0.94 fills 94% of the
 * binding axis - so "fits" is not "jammed to the edge".
 *
 * Which of the map's two opening views uses this, and which uses
 * `overviewZoom`, is docs/agents/map.md's "Two opening views".
 */
export function fitZoom({
  width,
  height,
  target,
  aspect = CELL_ASPECT,
  limits = ZOOM_LIMITS,
  margin = 1,
}: {
  width: number;
  height: number;
  target: { w: number; h: number };
  aspect?: number;
  limits?: ZoomLimits;
  margin?: number;
}): number {
  const byWidth = (width * margin) / target.w;
  const byHeight = (height * margin) / (aspect * target.h);
  return clampZoom(Math.min(byWidth, byHeight), limits);
}

/**
 * The zoom that shows at least `cellsPerAxis` whole rows and columns on a
 * canvas - `fitZoom` with an n x n target, so a narrow phone and a wide monitor
 * each zoom out only as far as their own shape requires. This is what the "center"
 * button, a room double-tap, and the rearrangement's park zoom out to, at
 * `config.camera.overviewCellsPerAxis`.
 *
 * Takes the canvas itself (or `null`, before the first paint) rather than a
 * `ViewportRect`, so a call site can pass `canvasRef.current` without checking
 * it first; with nothing to measure it falls back to the camera's own zoom.
 */
export function overviewZoom(
  canvas: { clientWidth: number; clientHeight: number } | null,
  cellsPerAxis: number,
  cam: Camera
): number {
  if (!canvas) return cam.zoom;
  return fitZoom({
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    target: { w: cellsPerAxis, h: cellsPerAxis },
    aspect: cam.aspect ?? CELL_ASPECT,
    limits: cam.limits ?? ZOOM_LIMITS,
  });
}

// --- screen/world mapping, and the two zoom gestures -----------------------

/** Viewport pixel -> world cell coordinate. `rect` is the canvas bounding box. */
export function screenToWorld(px: number, py: number, cam: Camera, rect: ViewportRect): WorldPoint {
  const perCell = pxPerCell(cam);
  return {
    x: cam.x + (px - rect.width / 2) / perCell.x,
    y: cam.y + (py - rect.height / 2) / perCell.y,
  };
}

/** World cell coordinate -> viewport pixel. The exact inverse of screenToWorld. */
export function worldToScreen(wx: number, wy: number, cam: Camera, rect: ViewportRect): ScreenPoint {
  const perCell = pxPerCell(cam);
  return {
    x: (wx - cam.x) * perCell.x + rect.width / 2,
    y: (wy - cam.y) * perCell.y + rect.height / 2,
  };
}

/**
 * Scale the zoom about a viewport point, keeping the world point under it fixed.
 *
 * The wheel and the pinch share this one implementation, which takes a
 * multiplier rather than a delta because a pinch knows the ratio its fingers
 * moved and has no delta to invent.
 *
 * Once the zoom clamps, the camera must not drift either, so the recentring is
 * computed against the clamped zoom, not the requested one.
 *
 * @param px viewport-relative anchor x
 * @param py viewport-relative anchor y
 * @param factor multiplier on the zoom; >1 zooms in
 */
export function zoomBy(cam: Camera, px: number, py: number, factor: number, rect: ViewportRect): Camera {
  const before = screenToWorld(px, py, cam, rect);
  const zoomed: Camera = { ...cam, zoom: clampZoom(cam.zoom * factor, cam.limits) };
  const after = screenToWorld(px, py, zoomed, rect);
  return {
    ...zoomed,
    x: zoomed.x + before.x - after.x,
    y: zoomed.y + before.y - after.y,
  };
}

/**
 * How much of a wheel delta becomes zoom. Exponential so the feel is the same at
 * every scale: a notch is a fixed *ratio*, not a fixed number of pixels.
 *
 * The by-feel camera constants in this file are stated at the code that uses
 * them, and `packages/config` imports each as its `camera.*` default, so a
 * `config.json` can retune one without a second copy of the number drifting.
 */
export const WHEEL_ZOOM_RATE = 0.0014;

/**
 * How much one discrete zoom step scales the camera - PageUp/PageDown, and a
 * two-finger tap on the map. One constant so a step means the same ratio
 * whichever input asked for it.
 */
export const ZOOM_STEP_FACTOR = 1.6;

/**
 * Zoom about a viewport point from a wheel delta; positive `deltaY` zooms out.
 *
 * @param px viewport-relative pointer x
 * @param py viewport-relative pointer y
 * @param rate `camera.wheelZoomRate` from config; defaults to the shipped rate
 *   for callers (tests, mostly) with no config to hand.
 */
export function zoomAt(
  cam: Camera, px: number, py: number, deltaY: number, rect: ViewportRect, rate: number = WHEEL_ZOOM_RATE
): Camera {
  return zoomBy(cam, px, py, Math.exp(-deltaY * rate), rect);
}

// --- panning, resistance, and the glide ------------------------------------

/**
 * Resistance this close to 1 counts as being inside the content region.
 *
 * Shared by the glide, which has nothing to correct inside, and by a keyboard
 * nudge, which lands cell-centered inside and damps continuously outside. One
 * threshold, so the two cannot disagree about where "inside" ends.
 */
const INSIDE_EPSILON = 0.999;

/**
 * Pan by a pointer movement, damped by the map's resistance at the camera.
 *
 * `damp` is 1 inside the content region and falls toward 0 outside it, so
 * pushing outward gets progressively heavier instead of stopping at a wall. The
 * scale has a floor so a fully resisted drag still moves: a drag that produced
 * no movement at all reads as a broken map rather than a heavy one, and a hand
 * can only travel so far in one stroke, so the floor costs nothing in reach.
 *
 * @param dxPx pointer movement in pixels
 * @param damp resistance at the camera, in [0, 1]
 */
export function panByPixels(cam: Camera, dxPx: number, dyPx: number, damp: number): Camera {
  const scale = 0.12 + 0.88 * damp;
  const perCell = pxPerCell(cam);
  return {
    ...cam,
    x: cam.x - (dxPx / perCell.x) * scale,
    y: cam.y - (dyPx / perCell.y) * scale,
  };
}

/**
 * Pan by a whole-cell delta - the keyboard's half of `panByPixels`, with two
 * differences that come from the input rather than the map.
 *
 * - The sign is opposite. A drag delta is where the hand went, so
 *   `panByPixels` subtracts it; `dx`/`dy` here are where the reader asked to go.
 * - There is no floor, which is why this is a separate function. A drag is
 *   bounded by how far a hand can travel in one stroke, so `panByPixels` can
 *   afford one. A held arrow key is bounded only by patience: the browser
 *   repeats `keydown` about thirty times a second while it is down, so any
 *   non-zero floor is a constant outward velocity that never stops. Measured, a
 *   floor the size of the pointer's let a six-second hold reach thirty-one cells
 *   past a boundary a mouse could barely push eleven past.
 *
 * Scaling straight from `damp` makes the step approach zero as the resistance
 * does, so a hold settles about a screen out - where the pointer lands too.
 * Inside the content region `damp` is 1, so a press moves one whole cell and
 * leaves the camera centered on its destination; only outside does the camera
 * come off the grid.
 *
 * @param dx cells, signed - the direction the reader asked to move
 * @param damp resistance at the camera, in [0, 1]
 */
export function panByCells(cam: Camera, dx: number, dy: number, damp: number): Camera {
  // Inside the region, land on the destination cell's center rather than adding
  // a raw delta. Both move one cell from a cell-centered camera, but only a snap
  // recovers from a trip outside: the damped steps out there are fractional by
  // design, and the glide stops wherever it happens to cross back in, so a raw
  // delta would carry that offset forever - every press advancing one cell while
  // the cell itself sat visibly off-center, part of it hanging off the screen
  // edge.
  //
  // Both axes snap. The offset a trip outward leaves is rarely axis-aligned, so
  // pressing Left has to fix the vertical drift too, or an offset nothing moves
  // along survives every press a reader can make.
  if (damp >= INSIDE_EPSILON) {
    return { ...cam, x: Math.floor(cam.x) + dx + 0.5, y: Math.floor(cam.y) + dy + 0.5 };
  }
  return { ...cam, x: cam.x + dx * damp, y: cam.y + dy * damp };
}

/**
 * One frame of the glide back toward the content region, for when the camera
 * is released outside it. The pull is proportional to position, so it eases in
 * rather than snapping. Inside the region the camera is returned unchanged, by
 * identity, so the caller can skip a redraw.
 */
export function glideStep(cam: Camera, damp: number): Camera {
  if (damp >= INSIDE_EPSILON) return cam;
  const pull = (1 - damp) * 0.06 * 0.08;
  return { ...cam, x: cam.x * (1 - pull), y: cam.y * (1 - pull) };
}

/**
 * How many `glideStep` iterations `glideToRest` runs before calling it settled.
 * The pull shrinks slowly near the rest point, so a bound that stops early
 * returns a camera the animated glide would still be moving; a step here is
 * arithmetic rather than a paint, so a wide bound is cheap. `camera.test.ts`
 * checks the answer against thousands of real `glideStep` calls.
 */
const GLIDE_REST_MAX_STEPS = 20_000;

/**
 * Where the glide would eventually settle, computed rather than animated - the
 * `prefers-reduced-motion` reading of the same physics `glideStep` eases toward
 * one frame at a time. There is no closed form for the rest point: the pull
 * shrinks as `resistanceAt` climbs back toward 1, which is what makes the eased
 * version smooth. So this iterates that same step function to convergence, and
 * motion-on and motion-off end in the same place, one visibly and one not.
 *
 * Iterating is bounded by `GLIDE_REST_MAX_STEPS` rather than run to exact
 * convergence.
 */
export function glideToRest(cam: Camera, resistanceAt: (x: number, y: number) => number): Camera {
  let next = cam;
  for (let i = 0; i < GLIDE_REST_MAX_STEPS; i++) {
    const stepped = glideStep(next, resistanceAt(next.x, next.y));
    if (stepped === next) break;
    if (Math.abs(stepped.x - next.x) < 1e-6 && Math.abs(stepped.y - next.y) < 1e-6) {
      next = stepped;
      break;
    }
    next = stepped;
  }
  return next;
}

/** Center the camera on a cell - cells are addressed by corner, so aim at the middle. */
export function cameraAtCell(cam: Camera, x: number, y: number, zoom?: number): Camera {
  return { ...cam, x: x + 0.5, y: y + 0.5, zoom: zoom ? clampZoom(zoom, cam.limits) : cam.zoom };
}

/**
 * The cell a screen reader's cursor stands on: whatever is under the camera
 * center. Costs nothing - `cam.x`/`cam.y` are already world cells, and
 * `cameraAtCell`'s `+ 0.5` is the same convention stated the other way round.
 *
 * Panning moves this cursor, which is what lets a pointer pan and a keyboard pan
 * agree on "where am I" without a second notion of position to keep in step.
 */
export function cursorCell(cam: Camera): { x: number; y: number } {
  return { x: Math.floor(cam.x), y: Math.floor(cam.y) };
}

/**
 * Below this many device pixels per cell width, a cell is too small on screen to
 * be a specific place to stand, and the announcement goes regional instead of
 * naming one cell. A by-feel number, like the chrome thresholds elsewhere.
 */
export const CURSOR_GRANULARITY_PX = 24;

/**
 * How much `CURSOR_GRANULARITY_PX` moves once picked, so a zoom held near it
 * does not flicker.
 */
export const GRANULARITY_HYSTERESIS = 0.35;

/**
 * 'cell' or 'region': what kind of thing the cursor names at this zoom.
 *
 * Current-state-aware in the same way `pyramid.ts`'s `pickLevel` is: a zoom held
 * near the boundary is biased toward staying where it is rather than picked
 * fresh every frame. The flicker here costs an announcement that alternates
 * between naming a cell and naming a region, which is worse than either held
 * steady.
 *
 * @param cellPx device pixels per cell width, e.g. `pxPerCell(cam).x * dpr`
 * @param current the granularity last announced
 * @param threshold `config.camera.cursorGranularityPx`
 * @param hysteresis `config.camera.granularityHysteresis`
 */
export function pickGranularity(
  cellPx: number,
  current: CursorGranularity | null = null,
  threshold: number = CURSOR_GRANULARITY_PX,
  hysteresis: number = GRANULARITY_HYSTERESIS
): CursorGranularity {
  const ideal: CursorGranularity = cellPx >= threshold ? 'cell' : 'region';
  if (current == null || current === ideal) return ideal;

  const biased = ideal === 'region' ? cellPx * (1 + hysteresis) : cellPx / (1 + hysteresis);
  const rebiased: CursorGranularity = biased >= threshold ? 'cell' : 'region';
  return rebiased === current ? current : ideal;
}

// --- flights ---------------------------------------------------------------

/**
 * How long a camera flight takes by default, in milliseconds. A by-feel number:
 * nothing derives from it, and this is where `beginFlight` needs a default, so
 * `packages/config` imports it rather than restating it. The tests assert the
 * shape of the curve, not this value.
 */
export const FLIGHT_MS = 450;

/**
 * Smoothstep: slow at both ends, quickest in the middle.
 *
 * Zero velocity on arrival is the half that matters: a flight that stops at full
 * speed reads as a jerk, and "center" is a button people press repeatedly.
 */
export const easeInOut = (t: number): number => t * t * (3 - 2 * t);

/**
 * Begin a flight from one camera to another, as a value.
 *
 * Both endpoints are whole cameras, so `aspect` and `limits` come along without
 * this having to know they exist: build the target with `cameraAtCell` and the
 * clamping has already happened. `from` is the live camera, so a second flight
 * during a first picks up from wherever it had got to.
 */
export function beginFlight(from: Camera, to: Camera, now: number, ms: number = FLIGHT_MS): Flight {
  return { from, to, t0: now, ms };
}

/**
 * The camera part way through a flight, and whether it has arrived.
 *
 * Zoom interpolates geometrically, position linearly. Zoom is pixels per cell,
 * so a linear ramp from `MIN_ZOOM` to `MAX_ZOOM` spends nearly all of its time
 * near the top of the range and the flight reads as a snap followed by a crawl;
 * the ratio is what the eye reads, which is why the wheel is exponential too.
 * Position has no such problem over the distances this map flies - tens of
 * cells - so the zoom-out-and-back arc a world-scale flight would need is not
 * implemented.
 *
 * `ms <= 0` arrives immediately, which is how a caller honouring
 * `prefers-reduced-motion` asks for an instant move without a second path.
 */
export function flightAt(flight: Flight, now: number): FlightState {
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
