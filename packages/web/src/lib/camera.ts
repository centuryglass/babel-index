/**
 * Camera maths for the map, as pure functions.
 *
 * World units are CELLS, and a cell is not assumed to be square. The cell at
 * integer (x, y) spans (x, y) to (x+1, y+1) in cell space, and the center room
 * sits at (0, 0); how many pixels that is on each axis depends on the tile's
 * shape. A camera is `{x, y, zoom}` where x/y are the world point at the center
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
 * None of this touches the DOM. `useMapCamera.ts` owns the pointer events and
 * the ref that holds the live camera; everything that can be stated as an
 * equation lives here instead, because the interesting properties - the
 * screen/world round-trip, and zoom keeping the point under the cursor fixed -
 * are exact invariants worth asserting.
 */
import { BASE_TILE } from './pyramid.ts';

/** The hard or configured zoom range, riding on a camera as `limits`. */
export interface ZoomLimits {
  min: number;
  max: number;
}

/**
 * The map camera. `x`/`y` are the world cell at the center of the viewport;
 * `zoom` is pixels per cell WIDTH. `aspect` and `limits` are optional and, once
 * present, must survive every operation below by spreading - see the module
 * comment.
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
export function pxPerCell(cam: Camera): { x: number; y: number } {
  const aspect = cam.aspect ?? CELL_ASPECT;
  return { x: cam.zoom, y: cam.zoom * aspect };
}

/**
 * How far past the tile's native resolution the camera may zoom, as a multiple
 * of the tile width. At 1x a spine is drawn 1:1; past that the flat base tile is
 * upscaled and softens, so 2x is the practical ceiling - enough to turn a ~32px
 * spine into a comfortable ~64px to read, before the blur outruns the benefit.
 *
 * Raise this only once the center tile earns a finer-than-level-0 pyramid rung
 * (the LOD step in the plan); until then the OPENING view is separately capped
 * at 1x in main.jsx, so a page never loads already upscaled, while a reader may
 * still zoom in to the 2x ceiling by hand.
 */
export const MAX_ZOOM_FACTOR = 2;

/**
 * The HARD zoom limits, as pixels per cell WIDTH. A cell is never smaller than a
 * thumbnail (min), nor zoomed past MAX_ZOOM_FACTOR times the tile's native width
 * (max) - the point beyond which the flat base tile is being upscaled. The max
 * derives from BASE_TILE so it tracks the tile's resolution rather than restating
 * it; a short tile is free to be shorter than the min, which is what "the cell is
 * the unit" means.
 *
 * This is the widest range that can ever be offered, and the range everything
 * derived is checked against - `pyramid.test.mjs` asserts every rung of the
 * ladder is reachable somewhere inside it. Configuration may narrow it (a
 * camera carries its own `limits`, below) but may never widen it, so that
 * assertion keeps covering every state the app can reach at runtime.
 */
export const ZOOM_LIMITS: ZoomLimits = { min: 26, max: BASE_TILE.w * MAX_ZOOM_FACTOR };

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
export const clampZoom = (z: number, limits: ZoomLimits = ZOOM_LIMITS): number =>
  Math.min(limits.max, Math.max(limits.min, z));

/**
 * The zoom at which a target rectangle fills a viewport without overflowing it.
 *
 * `target` is measured in CELL FRACTIONS - `{w, h}` where `w` is a fraction of
 * the cell WIDTH and `h` of the cell HEIGHT, the same basis
 * `layout({width: 1, height: 1})` returns. On screen that rect is `zoom*w` wide
 * and `zoom*aspect*h` tall, so the fit is the smaller of the two axis ratios:
 * the axis that would spill off the edge first. The result is clamped into
 * `limits`, so a target that wants more zoom than the camera allows simply opens
 * at the cap. A `margin` below 1 leaves breathing room - 0.94 fills 94% of the
 * binding axis - so "fits" is not "jammed to the edge".
 *
 * Pure and DOM-free, so the opening view can be reasoned about at any viewport
 * without a browser.
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
 * That fixed point is the whole feel of both zoom gestures: the thing you are
 * pointing at, or the thing between your fingers, is the thing you zoom into.
 * Once the zoom clamps, the camera must not drift either - so the recentre is
 * computed against the clamped zoom, not the requested one.
 *
 * Taking a multiplier rather than a wheel delta is what lets a pinch share this:
 * a pinch knows the ratio its fingers moved and has no delta to invent.
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
 * How much of a wheel delta becomes zoom. Exponential so the feel is the same
 * at every scale - a notch is a fixed *ratio*, not a fixed number of pixels.
 */
export const WHEEL_ZOOM_RATE = 0.0014;

/**
 * How much one discrete zoom "step" scales the camera - PageUp/PageDown on the
 * keyboard, and a two-finger tap on the map. One constant so a step means the
 * same ratio regardless of which input asked for it.
 */
export const ZOOM_STEP_FACTOR = 1.6;

/**
 * Zoom about a viewport point from a wheel delta; positive `deltaY` zooms out.
 *
 * @param px viewport-relative pointer x
 * @param py viewport-relative pointer y
 */
export function zoomAt(cam: Camera, px: number, py: number, deltaY: number, rect: ViewportRect): Camera {
  return zoomBy(cam, px, py, Math.exp(-deltaY * WHEEL_ZOOM_RATE), rect);
}

/**
 * Resistance this close to 1 counts as being inside the content region.
 *
 * Shared by the two things that need to know: the glide (which has nothing to
 * correct inside) and a keyboard nudge (which lands cell-centered inside, and
 * damped continuously outside). One threshold, so the two can never disagree
 * about where "inside" ends.
 */
const INSIDE_EPSILON = 0.999;

/**
 * Pan by a pointer movement, damped by the map's resistance at the camera.
 *
 * `damp` is 1 inside the content region and falls toward 0 outside it, so
 * pushing outward gets progressively heavier instead of stopping at a wall.
 * A floor of 0.12 keeps the map from freezing solid however far out you drag:
 * a drag that produced no movement at all would read as a broken map rather
 * than a heavy one, and a hand can only travel so far in one go anyway, so
 * the floor costs nothing in reach.
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
 * Pan by a whole-cell delta, damped by the same resistance a drag feels - the
 * keyboard's half of `panByPixels`.
 *
 * Two deliberate differences from the pointer, both about the input rather
 * than the map:
 *
 * **The sign is opposite.** A drag delta is where the HAND went (drag right,
 * the map goes left); `dx`/`dy` here are where the READER asked to go, so
 * they add.
 *
 * **There is no floor**, and that is the whole point of a separate function.
 * A drag is bounded by how far a hand can physically travel in one stroke, so
 * `panByPixels`'s 0.12 floor costs nothing - you run out of screen long before
 * you run out of map. A HELD arrow key is bounded only by patience: the
 * browser repeats `keydown` about thirty times a second for as long as it is
 * down, so any non-zero floor is a constant outward velocity that never stops.
 * Measured, a 0.12 floor let a six-second hold reach thirty-one cells past a
 * boundary a mouse could barely push eleven past. Scaling straight from
 * `damp` makes the step approach zero as the resistance does, so a hold
 * settles a screen or so out - which is where the pointer lands too.
 *
 * Inside the content region `damp` is exactly 1, so this moves exactly `dx`
 * cells: a camera that started cell-centered stays cell-centered, and one arrow
 * press remains exactly one room. Only outside does the camera come off the
 * grid, and every press still advances the cursor a full cell once back
 * inside, because a scale of 1 preserves whatever offset it picked up.
 *
 * @param dx cells, signed - the direction the reader asked to move
 * @param damp resistance at the camera, in [0, 1]
 */
export function panByCells(cam: Camera, dx: number, dy: number, damp: number): Camera {
  // Inside the region, land CENTERED on the destination cell rather than adding
  // a raw delta. Both do move exactly one cell from a cell-centered camera, but
  // only this one recovers: a trip outside leaves the camera off the grid (the
  // damped steps out there are fractional by design, and the glide stops
  // wherever it happens to cross back in), and a raw delta would carry that
  // offset forever - every press advancing one cell while the cell itself sat
  // visibly off-center, part of it hanging off the screen edge.
  //
  // Snapping both axes is deliberate, not incidental: the offset a trip
  // outward leaves is rarely axis-aligned, so pressing Left has to fix the
  // vertical drift too, or an offset nothing happens to move along survives
  // every press a reader can make.
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
 * However many frames `glideStep` would take, without taking them. High
 * because the pull can shrink very slowly near the rest point - `camera.test.mjs`
 * measures the gap directly against thousands of real `glideStep` calls - and
 * because every "frame" here is arithmetic, not a paint: tens of thousands of
 * them cost microseconds, which is cheap next to a reader stranded short of
 * where the animated version would actually have settled.
 */
const GLIDE_REST_MAX_STEPS = 20_000;

/**
 * Where the glide would eventually settle, computed rather than animated - the
 * `prefers-reduced-motion` reading of the same physics `glideStep` eases
 * toward one frame at a time. There is no closed form for the rest point (the
 * pull shrinks as `resistanceAt` climbs back toward 1, which is exactly what
 * makes the eased version smooth), so this iterates the same step function to
 * convergence instead of inventing a different endpoint - motion-on and
 * motion-off end up in the same place, one visibly and one not.
 *
 * Bounded rather than run to exact convergence: the pull can shrink for a long
 * time before crossing `INSIDE_EPSILON`, and every step here is arithmetic, not
 * a frame, so five hundred of them cost nothing next to getting the reader
 * stranded on a value that never quite settles.
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
 * center (accessibility-plan.md §4.2). Costs nothing - `cam.x`/`cam.y` are
 * already world cells, and `cameraAtCell`'s `+ 0.5` above is the same
 * convention stated the other way round. Panning IS moving this cursor, which
 * is what lets a pointer pan and a keyboard pan agree on "where am I" without
 * a second notion of position to keep in step.
 */
export function cursorCell(cam: Camera): { x: number; y: number } {
  return { x: Math.floor(cam.x), y: Math.floor(cam.y) };
}

/**
 * Below this many device pixels per cell width, a cell is too small on screen
 * to be a specific place to stand - the announcement goes regional instead of
 * naming one cell (§3.1's "semantic zoom on the announcement"). A by-feel
 * number, like the chrome thresholds elsewhere: nothing derives from it and no
 * test pins its value.
 */
const CURSOR_GRANULARITY_PX = 24;

/** How much the threshold moves once picked, so a zoom held near it does not flicker. */
const GRANULARITY_HYSTERESIS = 0.35;

/**
 * 'cell' or 'region': what kind of thing the cursor names at this zoom.
 *
 * Same shape as `pyramid.js`'s `pickLevel` - current-state-aware, and a zoom
 * held near the boundary is biased toward staying where it is rather than
 * picked fresh every frame. Here the cost of flicker is sharper than a texture
 * swap: an announcement that alternates between naming a cell and naming a
 * region is worse than either one held steady.
 *
 * @param cellPx device pixels per cell width, e.g. `pxPerCell(cam).x * dpr`
 * @param current the granularity last announced
 */
export function pickGranularity(
  cellPx: number,
  current: CursorGranularity | null = null
): CursorGranularity {
  const ideal: CursorGranularity = cellPx >= CURSOR_GRANULARITY_PX ? 'cell' : 'region';
  if (current == null || current === ideal) return ideal;

  const biased =
    ideal === 'region' ? cellPx * (1 + GRANULARITY_HYSTERESIS) : cellPx / (1 + GRANULARITY_HYSTERESIS);
  const rebiased: CursorGranularity = biased >= CURSOR_GRANULARITY_PX ? 'cell' : 'region';
  return rebiased === current ? current : ideal;
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
 * full speed reads as a jerk, and "center" is a button people press repeatedly.
 */
export const easeInOut = (t: number): number => t * t * (3 - 2 * t);

/**
 * Begin a flight from one camera to another, as a value.
 *
 * Both endpoints are whole cameras, so `aspect` and `limits` come along without
 * this having to know they exist - build the target with `cameraAtCell` and the
 * clamping has already happened. `from` being the LIVE camera rather than some
 * remembered one is what makes a second flight during a first pick up smoothly
 * from wherever it had got to.
 */
export function beginFlight(from: Camera, to: Camera, now: number, ms: number = FLIGHT_MS): Flight {
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
