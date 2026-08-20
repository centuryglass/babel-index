import { useCallback, useEffect, useRef } from 'react';
import {
  beginFlight,
  cameraAtCell,
  clampZoom,
  flightAt,
  glideStep,
  panByPixels,
  zoomAt,
  zoomBy,
} from './camera.js';

/**
 * Pan/zoom camera over an unbounded tile grid.
 *
 * This hook owns the pointer plumbing only; the maths lives in `camera.js` as
 * pure functions, where it can be tested without a DOM.
 *
 * The camera is held in a ref rather than in state. It changes on every pointer
 * move and every animation frame, and React does not need to re-render for any
 * of that - the canvas is redrawn directly.
 *
 * The configured zoom range rides on the camera as `limits` rather than being
 * read here, so every clamp - wheel, flyTo, anything later - goes through the
 * same field and none of them has to remember to ask.
 *
 * `camera` and `opening` are required, and this file states no fallback for
 * either: the opening camera is derived from the display by the caller and the
 * flight duration is a by-feel number from `packages/config`, so a default here
 * would be a second statement of one that could drift.
 *
 * ### Picking, and why it lives here
 *
 * The metadata overlay opens on right-click or long press, and the long press
 * has to LOSE to a pan - a press that turns into a drag must not also open a
 * card, or panning on a phone becomes unusable. That means the press timer has
 * to watch the same pointer stream the drag does, which is this one. What is
 * picked is `picking.js`; when, is here.
 *
 * Left-click stays free: `§5` reserves it for "focus this room", and a map whose
 * primary button opens a modal is a map you cannot explore.
 *
 * ### Flying, and why it shares the glide's loop
 *
 * `flyTo` eases rather than teleports, because a teleport loses the reader's
 * sense of where they were - and after a search, the flight home is carrying
 * the meaning: it shows the top result's location relative to where you were
 * standing. The step is `flightAt` in `camera.js`; what is here is the frame
 * clock and the interruption.
 *
 * It rides the glide's rAF loop rather than starting one of its own. There is
 * already a permanent loop, and one loop is what makes the precedence between
 * the two statable in a single `else`: a flight owns the camera while it lasts,
 * and the glide takes over on arrival - which is what lets a flight land
 * outside the content region and be pulled back afterwards instead of being
 * fought all the way there.
 *
 */

/** How long a press must be held, and how far it may wander before it is a drag. */
const LONG_PRESS_MS = 500;
const PRESS_SLOP_PX = 8;

/**
 * Someone who has asked for less motion gets the old teleport.
 *
 * Read per flight rather than once: the setting can change while a page is
 * open, and this costs nothing next to the flight it is deciding about.
 *
 * Exported because the rearrangement asks the same question in `main.jsx`, and
 * a second `matchMedia` call there would be a second statement of one fact -
 * the two would drift the first time the query string needed changing.
 */
export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Every pointer currently down, in the order it arrived, so a second finger can
 * be told from a jittery first one. Insertion order matters: a pinch is always
 * between the first two fingers, and a third does not hijack it.
 */
const firstTwo = (pointers) => {
  const it = pointers.values();
  return [it.next().value, it.next().value];
};

/** Distance and midpoint between two pointers - the whole state a pinch needs. */
const spanOf = (a, b) => ({
  dist: Math.hypot(b.x - a.x, b.y - a.y),
  cx: (a.x + b.x) / 2,
  cy: (a.y + b.y) / 2,
});

/**
 * @param {object} opts
 * @param {{minZoom: number, maxZoom: number, defaultZoom: number, flightMs: number}} opts.camera
 *   resolved `config.camera`, from the manifest
 * @param {{x: number, y: number, zoom: number}} opts.opening
 *   the page-load camera - where the map opens and how far in. Derived from the
 *   viewport and the centre room's geometry by the caller, not configured, so it
 *   is handed in whole rather than read from `camera`. See `fitZoom` in camera.js.
 * @param {(px: number, py: number, cam: object) => void} [opts.onPick]
 *   canvas-relative point of a right-click or a completed long press, with the
 *   live camera - which the hook owns, so the consumer does not have to reach
 *   back for a ref this hook has not returned yet
 * @param {(px: number, py: number, cam: object) => void} [opts.onTap]
 *   canvas-relative point of a left-click / tap that neither panned nor stopped
 *   a flight. The centre room's book spines are what this selects.
 * @param {(line: string) => void} [opts.onDebug] one line per pointer event.
 *   Off unless asked for. Touch gestures can only really be judged on a device,
 *   and a phone has no console you can read while both thumbs are busy - so
 *   this exists to make "what did the browser actually send" answerable from
 *   the glass. See `?touchdebug` in main.jsx.
 */
export function useMapCamera({ canvasRef, resistanceAt, onChange, camera, opening, onPick, onTap, onDebug }) {
  const limits = { min: camera.minZoom, max: camera.maxZoom };
  const cam = useRef({
    // The PAGE-LOAD camera: centred on the centre room's bookshelf and zoomed to
    // fit the display, computed by the caller from the viewport. Not the
    // return-to-centre view - `defaultZoom` (wider) is where the "centre" button
    // and the rearrangement park, so the animation has a wall of rooms to slide
    // across. Derived from the display rather than configured, so it arrives
    // whole; the zoom is re-clamped here only to defend the invariant.
    ...opening,
    zoom: clampZoom(opening.zoom, limits),
    limits,
  });
  const drag = useRef(null);
  const press = useRef(null);
  const pointers = useRef(new Map());
  const pinch = useRef(null);
  const flight = useRef(null);
  // A candidate left-click tap, tracked from its pointerdown so pointerup can
  // tell a tap from a pan. Left as null the moment it becomes anything else - a
  // drag, a pinch, or the press that stopped a flight.
  const tap = useRef(null);

  /**
   * End whatever is in the air, telling the caller whether it arrived.
   *
   * `flyTo` hands back a promise so a caller can sequence something after the
   * landing, and the answer has to distinguish the two ways a flight ends: it
   * got there, or a hand landed on the map. Anything waiting to happen "after
   * the flight home" must not happen when the reader has taken the map instead.
   */
  const endFlight = useCallback((landed) => {
    const settle = flight.current?.settle;
    flight.current = null;
    settle?.(landed);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pick = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      onPick?.(clientX - rect.left, clientY - rect.top, cam.current);
    };

    const cancelPress = () => {
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
    };

    /**
     * Pointer capture, which is best-effort and must never be load-bearing.
     *
     * Both calls throw `NotFoundError` for a pointer the browser does not
     * consider captured-or-capturable, and that is a NORMAL state on a
     * touchscreen: capture is implicit for touch, and the browser drops it
     * itself at the end of a sequence or when it cancels one. An `?.` does not
     * help - it guards the method being missing, not the call throwing - so an
     * unguarded release would abort the rest of the handler and leave a finger
     * in `pointers` forever, after which every later gesture would be read as a
     * pinch against a finger no longer on the glass.
     *
     * A hazard the spec allows rather than a bug observed here, kept because
     * `pointercancel` reaches this path with capture already dropped and the
     * cost is a try/catch.
     */
    const capture = (id) => {
      try {
        canvas.setPointerCapture(id);
      } catch {
        // Implicit capture already covers touch; nothing here depends on it.
      }
    };
    const release = (id) => {
      try {
        canvas.releasePointerCapture(id);
      } catch {
        // Already released, by us or by the browser. The bookkeeping below is
        // what actually matters, and it must run either way.
      }
    };

    /** One line per pointer event, when someone is watching. */
    const report = (what, e) =>
      onDebug?.(
        `${what} id=${e.pointerId ?? '-'} ${e.pointerType ?? '-'} ` +
          `down=${pointers.current.size} ${pinch.current ? 'pinch' : drag.current ? 'drag' : 'idle'}`
      );

    const onPointerDown = (e) => {
      // Secondary buttons are the context menu's, not the map's; starting a drag
      // on one would pan the map out from under a right-click.
      if (e.button !== 0) return;

      // A hand on the map beats anything the map was doing to itself. Dropped
      // here rather than on the first move so that even a press that never
      // becomes a drag stops the flight - reaching for a room that is still
      // sliding and having it slide on is the thing this is for.
      //
      // Whether a flight was in the air is remembered: a press that stopped one
      // is the reader halting the map, not a tap on whatever ended up under the
      // finger, and must not fire `onTap`.
      const interruptedFlight = !!flight.current;
      endFlight(false);

      // Track FIRST, capture second. `setPointerCapture` can throw, and doing it
      // first would abort the handler before the pointer was recorded - losing
      // the finger entirely, so a second one would never start a pinch.
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      capture(e.pointerId);
      canvas.classList.add('dragging');

      cancelPress();

      if (pointers.current.size >= 2) {
        // A second finger ends any press and begins a pinch. Recording the span
        // now is what makes the first move a ratio against where the fingers
        // actually started rather than a jump.
        const [a, b] = firstTwo(pointers.current);
        pinch.current = spanOf(a, b);
        drag.current = null;
        tap.current = null; // two fingers is a pinch, never a tap
        report('down', e);
        return;
      }

      drag.current = { x: e.clientX, y: e.clientY };
      tap.current = onTap ? { x: e.clientX, y: e.clientY, moved: false, interruptedFlight } : null;
      report('down', e);
      if (onPick) {
        const { clientX, clientY } = e;
        press.current = {
          x: clientX,
          y: clientY,
          timer: setTimeout(() => {
            press.current = null;
            // A press that became the overlay gesture is not also a tap; drop
            // the tap candidate so lifting the finger does not fire onTap too.
            tap.current = null;
            pick(clientX, clientY);
          }, LONG_PRESS_MS),
        };
      }
    };

    const onPointerMove = (e) => {
      const tracked = pointers.current.get(e.pointerId);
      if (!tracked) return;
      tracked.x = e.clientX;
      tracked.y = e.clientY;

      // A press that wanders is a drag. The slop is what keeps a long press
      // working on a touchscreen, where a finger never holds perfectly still -
      // cancelling on the first pixel of jitter would make the gesture
      // unreachable on exactly the devices it exists for.
      if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > PRESS_SLOP_PX)
        cancelPress();

      // A tap that wanders past the slop is a pan, by the same measure the long
      // press uses.
      if (tap.current && Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y) > PRESS_SLOP_PX)
        tap.current.moved = true;

      if (pinch.current && pointers.current.size >= 2) {
        const [a, b] = firstTwo(pointers.current);
        const span = spanOf(a, b);
        // A degenerate span would divide by zero and send the zoom to infinity;
        // two fingers at the same point is a real thing a hand can do.
        if (!(span.dist > 0) || !(pinch.current.dist > 0)) {
          pinch.current = span;
          return;
        }

        const rect = canvas.getBoundingClientRect();
        // Zoom about the point between the fingers, then follow the midpoint, so
        // a pinch that also slides moves the map with it. Both halves anchor on
        // the same midpoint, which is what keeps the world under the fingers.
        cam.current = zoomBy(
          cam.current,
          span.cx - rect.left,
          span.cy - rect.top,
          span.dist / pinch.current.dist,
          rect
        );
        cam.current = panByPixels(
          cam.current,
          span.cx - pinch.current.cx,
          span.cy - pinch.current.cy,
          resistanceAt(cam.current.x, cam.current.y)
        );
        pinch.current = span;
        onChange?.();
        report('pinch', e);
        return;
      }

      if (!drag.current) return;
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      drag.current = { x: e.clientX, y: e.clientY };

      // Resistance is sampled where the camera is now, so pushing outward gets
      // progressively heavier instead of stopping at a wall.
      cam.current = panByPixels(cam.current, dx, dy, resistanceAt(cam.current.x, cam.current.y));
      onChange?.();
    };

    const onPointerUp = (e) => {
      release(e.pointerId);
      pointers.current.delete(e.pointerId);
      cancelPress();

      if (pointers.current.size >= 2) {
        // Still pinching on the remaining fingers - re-span so the pair that is
        // left does not read as a sudden change in distance.
        const [a, b] = firstTwo(pointers.current);
        pinch.current = spanOf(a, b);
        report(e.type, e);
        return;
      }

      if (pointers.current.size === 1) {
        // Down to one finger. Re-anchor the drag where that finger actually is,
        // or its next move is measured from wherever the pinch left off and the
        // map lurches by the width of the gesture.
        const [remaining] = firstTwo(pointers.current);
        pinch.current = null;
        drag.current = { x: remaining.x, y: remaining.y };
        tap.current = null; // a pinch was in progress; the release is not a tap
        report(e.type, e);
        return;
      }

      canvas.classList.remove('dragging');
      drag.current = null;
      pinch.current = null;

      // A clean tap: the last finger up, having not wandered and not stopped a
      // flight, and not a cancel. Left-click/tap is otherwise unclaimed, so this
      // is what selects a book on the centre room.
      const t = tap.current;
      tap.current = null;
      if (onTap && t && !t.moved && !t.interruptedFlight && e.type !== 'pointercancel') {
        const rect = canvas.getBoundingClientRect();
        onTap(t.x - rect.left, t.y - rect.top, cam.current);
      }
      report(e.type, e);
    };

    const onWheel = (e) => {
      e.preventDefault();
      // Same rule as a drag: the wheel is the reader steering, and a flight
      // still easing its own zoom underneath would fight every notch.
      endFlight(false);
      const rect = canvas.getBoundingClientRect();
      cam.current = zoomAt(cam.current, e.clientX - rect.left, e.clientY - rect.top, e.deltaY, rect);
      onChange?.();
    };

    // Right-click on desktop, and the menu some browsers raise at the end of a
    // touch long-press - suppressed either way, since the card is the response.
    const onContextMenu = (e) => {
      e.preventDefault();
      cancelPress();
      pick(e.clientX, e.clientY);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    return () => {
      cancelPress();
      pointers.current.clear();
      pinch.current = null;
      drag.current = null;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    };
  }, [canvasRef, resistanceAt, onChange, onPick, onTap, onDebug, endFlight]);

  // Step whichever of the two things is moving the camera on its own: a flight
  // while one is in the air, otherwise the glide back toward the content region
  // when the map was released outside it, so the edge pushes back rather than
  // trapping. One loop, one `else`, and no way for them to overlap.
  useEffect(() => {
    let raf;
    const tick = (now) => {
      if (flight.current) {
        const { cam: next, done } = flightAt(flight.current, now);
        cam.current = next;
        if (done) endFlight(true);
        onChange?.();
      } else if (!drag.current) {
        const next = glideStep(cam.current, resistanceAt(cam.current.x, cam.current.y));
        if (next !== cam.current) {
          cam.current = next;
          onChange?.();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [resistanceAt, onChange, endFlight]);

  /**
   * Ease to a cell, rather than teleport to it.
   *
   * The target is a whole camera, built by `cameraAtCell` so the clamp and both
   * optional fields are already settled - the flight then interpolates between
   * two cameras and cannot lose either one. `performance.now()` shares its time
   * origin with the rAF timestamp the loop steps on, so the two agree.
   *
   * No `onChange` here: the loop owns every camera change for as long as the
   * flight lasts, and calling it now would only repaint the camera we are
   * flying away from.
   *
   * The duration comes from config, like the opening zoom above it and for the
   * same reason - it is a by-feel number, and this file states none of those.
   * Reduced motion overrides it rather than being overridden by it: someone who
   * has asked for less motion is not asking about this map in particular.
   *
   * Returns a promise for the landing - true if it arrived, false if the reader
   * took the map first. Callers that only want the camera moved can ignore it;
   * the one that cannot is the rearrangement, which has to know both WHEN the
   * camera stopped, because it plans against the cells that are on screen, and
   * WHETHER it stopped where it was aimed, because a reader who has grabbed the
   * map is not asking to watch the library rebuild itself.
   */
  const flyTo = useCallback(
    (x, y, zoom) => {
      const to = cameraAtCell(cam.current, x, y, zoom);
      const ms = prefersReducedMotion() ? 0 : camera.flightMs;
      // A second flight replaces the first, and the first did not arrive.
      endFlight(false);
      return new Promise((settle) => {
        flight.current = { ...beginFlight(cam.current, to, performance.now(), ms), settle };
      });
    },
    [camera.flightMs, endFlight]
  );

  // The keyboard's three instant moves (accessibility-plan.md §4.2/§4.2a) - no
  // `flyTo` for any of them. A cell's cursor is announced on arrival, and an
  // eased flight between every arrow press would both feel unusable and race:
  // `cam.current` is unchanged until a flight resolves, so a second press
  // mid-flight would read - and pan from - a stale position. Interrupting
  // whatever flight is in the air first is what "instant" actually requires;
  // otherwise a keyboard move can be silently overridden by an in-flight
  // animation landing after it.

  /** Pan by whole cells - one arrow press, or a screenful with shift held. */
  const panCells = useCallback(
    (dx, dy) => {
      endFlight(false);
      cam.current = { ...cam.current, x: cam.current.x + dx, y: cam.current.y + dy };
      onChange?.();
    },
    [endFlight, onChange]
  );

  /** Jump the cursor to a specific cell - Home, ctrl+Home, ctrl+arrow's landing. */
  const jumpToCell = useCallback(
    (x, y) => {
      endFlight(false);
      cam.current = { ...cam.current, x: x + 0.5, y: y + 0.5 };
      onChange?.();
    },
    [endFlight, onChange]
  );

  /**
   * Zoom by a factor about the viewport CENTRE - PgUp/PgDn. Anchoring on
   * centre rather than a pointer position is what keeps the cursor cell fixed
   * across a keyboard zoom: `zoomBy`'s invariant is that the world point under
   * the anchor does not move, and the viewport centre is exactly where
   * `cursorCell` reads from.
   */
  const zoomStep = useCallback(
    (factor) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      endFlight(false);
      const rect = { width: canvas.clientWidth, height: canvas.clientHeight };
      cam.current = zoomBy(cam.current, rect.width / 2, rect.height / 2, factor, rect);
      onChange?.();
    },
    [canvasRef, endFlight, onChange]
  );

  return { cam, flyTo, panCells, jumpToCell, zoomStep };
}
