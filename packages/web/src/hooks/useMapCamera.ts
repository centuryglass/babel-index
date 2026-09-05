import { useCallback, useEffect, useRef } from 'react';
import {
  beginFlight,
  cameraAtCell,
  clampZoom,
  flightAt,
  glideStep,
  glideToRest,
  panByCells,
  panByPixels,
  zoomAt,
  zoomBy,
  ZOOM_STEP_FACTOR,
  type Camera,
} from '../lib/camera.ts';
import type { Config } from '../../../config/config.ts';

/**
 * Pan/zoom camera over an unbounded tile grid.
 *
 * This hook owns the pointer plumbing only; the maths lives in `camera.ts` as
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
 * picked is `picking.ts`; when, is here.
 *
 * Left-click stays free: `§5` reserves it for "focus this room", and a map whose
 * primary button opens a modal is a map you cannot explore.
 *
 * ### Flying, and why it shares the glide's loop
 *
 * `flyTo` eases rather than teleports, because a teleport loses the reader's
 * sense of where they were - and after a search, the flight home is carrying
 * the meaning: it shows the top result's location relative to where you were
 * standing. The step is `flightAt` in `camera.ts`; what is here is the frame
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
 * How soon a second tap must land, and how close to the first, to read as a
 * double tap rather than two unrelated ones. Wider than `PRESS_SLOP_PX`
 * because a second tap lands wherever the same finger comes back down, not
 * wherever the first one drifted to.
 */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 40;

/**
 * Two-finger tap: zoom out one step, centered where the fingers were - the
 * touch equivalent of the keyboard's PageDown. A tap rather than a pinch
 * means both fingers came down and lifted again without drifting -
 * `TWO_FINGER_TAP_SLOP_PX` bounds that drift, the same role `PRESS_SLOP_PX`
 * plays for a one-finger tap. The two liftoffs need not be simultaneous -
 * `TWO_FINGER_TAP_GAP_MS` is how far apart they may land - but the whole
 * gesture must be quick, not a two-finger hold - `TWO_FINGER_TAP_MS` bounds
 * touchdown to the first liftoff.
 */
const TWO_FINGER_TAP_MS = 400;
const TWO_FINGER_TAP_GAP_MS = 250;
const TWO_FINGER_TAP_SLOP_PX = 12;

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
export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface PointerPoint {
  x: number;
  y: number;
}

/**
 * Every pointer currently down, in the order it arrived, so a second finger can
 * be told from a jittery first one. Insertion order matters: a pinch is always
 * between the first two fingers, and a third does not hijack it.
 */
const firstTwo = (pointers: Map<number, PointerPoint>): [PointerPoint, PointerPoint] => {
  const it = pointers.values();
  return [it.next().value as PointerPoint, it.next().value as PointerPoint];
};

/** Distance and midpoint between two pointers - the whole state a pinch needs. */
const spanOf = (a: PointerPoint, b: PointerPoint) => ({
  dist: Math.hypot(b.x - a.x, b.y - a.y),
  cx: (a.x + b.x) / 2,
  cy: (a.y + b.y) / 2,
});

type ResistanceAt = (x: number, y: number) => number;
type OnPick = (px: number, py: number, cam: Camera) => void;
type OnTap = (px: number, py: number, cam: Camera) => void;
type OnDebug = (line: string) => void;
type FlyOpts = { ms?: number };

interface UseMapCameraOpts {
  canvasRef: { current: HTMLCanvasElement | null };
  /** resistance in [0, 1] at a world point - 1 inside the content region. */
  resistanceAt: ResistanceAt;
  onChange?: () => void;
  /** resolved `config.camera`, from the manifest */
  camera: Config['camera'];
  /**
   * the page-load camera - where the map opens and how far in. Derived from the
   * viewport and the center room's geometry by the caller, not configured, so it
   * is handed in whole rather than read from `camera`. See `fitZoom` in camera.ts.
   */
  opening: Camera;
  /**
   * canvas-relative point of a right-click or a completed long press, with the
   * live camera - which the hook owns, so the consumer does not have to reach
   * back for a ref this hook has not returned yet
   */
  onPick?: OnPick;
  /**
   * canvas-relative point of a left-click / tap that neither panned nor stopped
   * a flight. The center room's book spines are what this selects.
   */
  onTap?: OnTap;
  /**
   * canvas-relative point of a second tap landing within `DOUBLE_TAP_MS` and
   * `DOUBLE_TAP_SLOP_PX` of a qualifying first one. Fires in addition to
   * `onTap` (both fire for the second tap), never instead of it - a single
   * tap must not wait to find out whether a second one is coming, or every
   * ordinary tap (selecting a book, focusing the search field) picks up a
   * `DOUBLE_TAP_MS` delay it never used to have.
   */
  onDoubleTap?: OnTap;
  /**
   * one line per pointer event. Off unless asked for. Touch gestures can only
   * really be judged on a device, and a phone has no console you can read while
   * both thumbs are busy - so this exists to make "what did the browser
   * actually send" answerable from the glass. See `?touchdebug` in main.jsx.
   */
  onDebug?: OnDebug;
}

interface TapCandidate extends PointerPoint {
  moved: boolean;
  interruptedFlight: boolean;
}

/**
 * A candidate two-finger tap, tracked from the moment a second finger lands
 * to `firstLiftAt` (still `null` while both fingers are down) to the second
 * liftoff, which is what commits it. `cx`/`cy` are the midpoint at
 * touchdown, fixed rather than tracked, because ANY drift beyond
 * `TWO_FINGER_TAP_SLOP_PX` cancels the candidate outright - see the pinch
 * branch of `onPointerMove`.
 */
interface TwoTapCandidate extends PointerPoint {
  dist0: number;
  downAt: number;
  firstLiftAt: number | null;
}

interface PressCandidate extends PointerPoint {
  timer: ReturnType<typeof setTimeout>;
}

interface LiveFlight {
  from: Camera;
  to: Camera;
  t0: number;
  ms: number;
  settle: (landed: boolean) => void;
}

export function useMapCamera({
  canvasRef,
  resistanceAt,
  onChange,
  camera,
  opening,
  onPick,
  onTap,
  onDoubleTap,
  onDebug,
}: UseMapCameraOpts) {
  const limits = { min: camera.minZoom, max: camera.maxZoom };
  const cam = useRef<Camera>({
    // The PAGE-LOAD camera: centered on the center room's bookshelf and zoomed to
    // fit the display, computed by the caller from the viewport. Not the
    // return-to-center view - `overviewZoom` (camera.ts, wider) is where the
    // "center" button and the rearrangement park, so the animation has a wall
    // of rooms to slide across. Derived from the display rather than
    // configured, so it arrives whole; the zoom is re-clamped here only to
    // defend the invariant.
    ...opening,
    zoom: clampZoom(opening.zoom, limits),
    limits,
  });
  const drag = useRef<PointerPoint | null>(null);
  const press = useRef<PressCandidate | null>(null);
  const pointers = useRef(new Map<number, PointerPoint>());
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  const flight = useRef<LiveFlight | null>(null);
  // A candidate left-click tap, tracked from its pointerdown so pointerup can
  // tell a tap from a pan. Left as null the moment it becomes anything else - a
  // drag, a pinch, or the press that stopped a flight.
  const tap = useRef<TapCandidate | null>(null);
  // The last completed tap, for double-tap detection - cleared once it has
  // paired with a second tap, so a stray third tap does not pair with a
  // double tap that already fired.
  const lastTap = useRef<(PointerPoint & { time: number }) | null>(null);
  // A candidate two-finger tap, tracked the same way `tap` is - cleared the
  // moment it becomes anything else (movement, a third finger, running out
  // the clock).
  const twoTap = useRef<TwoTapCandidate | null>(null);

  /**
   * End whatever is in the air, telling the caller whether it arrived.
   *
   * `flyTo` hands back a promise so a caller can sequence something after the
   * landing, and the answer has to distinguish the two ways a flight ends: it
   * got there, or a hand landed on the map. Anything waiting to happen "after
   * the flight home" must not happen when the reader has taken the map instead.
   */
  const endFlight = useCallback((landed: boolean) => {
    const settle = flight.current?.settle;
    flight.current = null;
    settle?.(landed);
  }, []);

  /**
   * Start an eased flight to a whole target camera - the shared half of
   * `flyTo` and `nudgeBy`, so the reduced-motion collapse and the
   * interrupt-the-previous-flight rule are stated once rather than twice.
   *
   * The flight begins at the LIVE camera (so a second flight during a first
   * picks up smoothly from wherever it had got to) even when the caller
   * computed `to` from `flightTarget()`; those are deliberately different
   * questions - where the camera IS versus where it was last told to go.
   *
   * Declared ahead of the pointer effect below (rather than beside `flyTo`,
   * which stays where it was written) because a two-finger tap needs it too -
   * a zoom step is a whole-camera flight the same way `flyTo`/`nudgeBy` are,
   * not a fourth, separate way of moving the camera.
   */
  const beginFlightTo = useCallback(
    (to: Camera, ms?: number): Promise<boolean> => {
      const duration = prefersReducedMotion() ? 0 : ms ?? camera.flightMs;
      // A second flight replaces the first, and the first did not arrive.
      endFlight(false);
      return new Promise((settle) => {
        flight.current = { ...beginFlight(cam.current, to, performance.now(), duration), settle };
      });
    },
    [camera.flightMs, endFlight]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pick = (clientX: number, clientY: number) => {
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
    const capture = (id: number) => {
      try {
        canvas.setPointerCapture(id);
      } catch {
        // Implicit capture already covers touch; nothing here depends on it.
      }
    };
    const release = (id: number) => {
      try {
        canvas.releasePointerCapture(id);
      } catch {
        // Already released, by us or by the browser. The bookkeeping below is
        // what actually matters, and it must run either way.
      }
    };

    /** One line per pointer event, when someone is watching. */
    const report = (what: string, e: PointerEvent) =>
      onDebug?.(
        `${what} id=${e.pointerId ?? '-'} ${e.pointerType ?? '-'} ` +
          `down=${pointers.current.size} ${pinch.current ? 'pinch' : drag.current ? 'drag' : 'idle'}`
      );

    const onPointerDown = (e: PointerEvent) => {
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
        tap.current = null; // two fingers is a pinch, never a (one-finger) tap

        // Exactly two fingers just landed: a candidate for a two-finger tap,
        // cancelled the moment either drifts or a third one joins (a third
        // finger down is never a tap of any kind).
        twoTap.current =
          pointers.current.size === 2
            ? { x: pinch.current.cx, y: pinch.current.cy, dist0: pinch.current.dist, downAt: performance.now(), firstLiftAt: null }
            : null;
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

    const onPointerMove = (e: PointerEvent) => {
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

        // Drift past the slop, on either the span or the midpoint, rules out
        // a two-finger tap - measured from touchdown, not frame to frame, so
        // a slow drift cannot sneak under the threshold one small step at a
        // time the way it would if this compared each move to the last.
        if (
          twoTap.current &&
          (Math.abs(span.dist - twoTap.current.dist0) > TWO_FINGER_TAP_SLOP_PX ||
            Math.hypot(span.cx - twoTap.current.x, span.cy - twoTap.current.y) > TWO_FINGER_TAP_SLOP_PX)
        ) {
          twoTap.current = null;
        }

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

    const onPointerUp = (e: PointerEvent) => {
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

        // The FIRST of a two-finger tap's two liftoffs - still a candidate,
        // just waiting on the second one now (checked below, once the last
        // finger is off the glass).
        if (twoTap.current) twoTap.current.firstLiftAt = performance.now();
        report(e.type, e);
        return;
      }

      canvas.classList.remove('dragging');
      drag.current = null;
      pinch.current = null;

      // The last finger up: settle any two-finger tap candidate one way or
      // the other before falling through to the one-finger tap below (they
      // never both apply - two fingers down cleared `tap.current`).
      const two = twoTap.current;
      twoTap.current = null;
      if (
        two &&
        e.type !== 'pointercancel' &&
        two.firstLiftAt != null &&
        two.firstLiftAt - two.downAt <= TWO_FINGER_TAP_MS &&
        performance.now() - two.firstLiftAt <= TWO_FINGER_TAP_GAP_MS
      ) {
        // A hand back on the map beats anything the map was doing to itself -
        // same rule `onPointerDown` applies to a flight already in the air.
        endFlight(false);
        const rect = canvas.getBoundingClientRect();
        const to = zoomBy(cam.current, two.x - rect.left, two.y - rect.top, 1 / ZOOM_STEP_FACTOR, rect);
        beginFlightTo(to);
        report(e.type, e);
        return;
      }

      // A clean tap: the last finger up, having not wandered and not stopped a
      // flight, and not a cancel. Left-click/tap is otherwise unclaimed, so this
      // is what selects a book on the center room.
      const t = tap.current;
      tap.current = null;
      if (t && !t.moved && !t.interruptedFlight && e.type !== 'pointercancel') {
        const rect = canvas.getBoundingClientRect();
        const px = t.x - rect.left;
        const py = t.y - rect.top;
        onTap?.(px, py, cam.current);

        // Double tap: a second qualifying tap landing soon enough and close
        // enough to the last one. Checked in addition to `onTap`, not instead
        // of it - see `onDoubleTap`'s doc comment for why the single tap must
        // never wait around to find out.
        const now = performance.now();
        const prior = lastTap.current;
        if (
          onDoubleTap &&
          prior &&
          now - prior.time <= DOUBLE_TAP_MS &&
          Math.hypot(t.x - prior.x, t.y - prior.y) <= DOUBLE_TAP_SLOP_PX
        ) {
          lastTap.current = null;
          onDoubleTap(px, py, cam.current);
        } else {
          lastTap.current = { x: t.x, y: t.y, time: now };
        }
      }
      report(e.type, e);
    };

    const onWheel = (e: WheelEvent) => {
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
    const onContextMenu = (e: MouseEvent) => {
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
      twoTap.current = null;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    };
  }, [canvasRef, resistanceAt, onChange, onPick, onTap, onDoubleTap, onDebug, endFlight, beginFlightTo]);

  // Step whichever of the two things is moving the camera on its own: a flight
  // while one is in the air, otherwise the glide back toward the content region
  // when the map was released outside it, so the edge pushes back rather than
  // trapping. One loop, one `else`, and no way for them to overlap.
  useEffect(() => {
    let raf: number;
    const tick = (now: number) => {
      if (flight.current) {
        const { cam: next, done } = flightAt(flight.current, now);
        cam.current = next;
        if (done) endFlight(true);
        onChange?.();
      } else if (!drag.current) {
        // Reduced motion asks for the rest point without the frames it takes
        // to ease there - `glideToRest` runs the same physics to convergence
        // instead of inventing a different destination, so motion-on and
        // motion-off agree on WHERE, differing only in whether the trip is
        // seen.
        const next = prefersReducedMotion()
          ? glideToRest(cam.current, resistanceAt)
          : glideStep(cam.current, resistanceAt(cam.current.x, cam.current.y));
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
   * `ms` overrides the configured duration for a single call, which is what
   * lets the keyboard's short nudges (accessibility-plan.md §4.2a - one arrow
   * press, a ctrl+arrow jump, a PgUp/PgDn zoom step) share every mechanic a
   * "fly home" already has - the interrupt-on-a-new-flight below, the landing
   * promise, `prefers-reduced-motion` collapsing it to zero - rather than a
   * second, parallel implementation of "ease the camera." Omit it for the
   * ordinary configured flight.
   *
   * Returns a promise for the landing - true if it arrived, false if the reader
   * took the map first. Callers that only want the camera moved can ignore it;
   * the one that cannot is the rearrangement, which has to know both WHEN the
   * camera stopped, because it plans against the cells that are on screen, and
   * WHETHER it stopped where it was aimed, because a reader who has grabbed the
   * map is not asking to watch the library rebuild itself.
   */
  const flyTo = useCallback(
    (x: number, y: number, zoom?: number, { ms }: FlyOpts = {}) =>
      beginFlightTo(cameraAtCell(cam.current, x, y, zoom), ms),
    [beginFlightTo]
  );

  /**
   * Move by a cell delta, damped by the map's resistance - the keyboard's
   * equivalent of a pointer drag. Same resistance, deliberately DIFFERENT
   * curve: see `panByCells` in `camera.ts` for why a drag can afford a floor
   * and a held key cannot.
   *
   * Without this the keyboard had no resistance at all: a held arrow key
   * sailed off into the far field at full speed, somewhere a hand on the
   * mouse cannot practically reach, and only snapped back on release. The
   * glide alone could not fix that - it pulls back proportionally to distance
   * but does nothing to the outbound step, so a fast enough key repeat simply
   * outruns it.
   *
   * Damping reads the resistance at `flightTarget()`, not at `cam.current`:
   * mid-flight the latter is the interpolated position, so a key repeat would
   * sample a resistance from behind where it has already been told to go and
   * damp too little. It is also what makes repeated presses compound rather
   * than collapse, exactly as in `flyTo`'s callers.
   */
  const nudgeBy = useCallback(
    (dx: number, dy: number, { ms }: FlyOpts = {}) => {
      const from = flight.current?.to ?? cam.current;
      const to = panByCells(from, dx, dy, resistanceAt(from.x, from.y));
      return beginFlightTo(to, ms);
    },
    [beginFlightTo, resistanceAt]
  );

  /**
   * The camera a NEW keyboard move should chain off, rather than teleporting
   * from wherever an in-progress flight currently is.
   *
   * `cam.current` is the INTERPOLATED position - correct for drawing a frame,
   * wrong for planning the next flight. `flyTo` itself never mutates
   * `cam.current` (only the rAF loop does, as a flight progresses), so a
   * second keyboard press arriving before that loop has ticked even once - two
   * PgDn presses back to back is the case that surfaced this - would compute
   * ITS target from the same pre-flight zoom the first press already started
   * leaving, and the two presses would collapse into one. The already-known,
   * fully-resolved target of a flight in progress (`flight.current.to`) is
   * what a chained press should build on instead; idle, this is just
   * `cam.current`.
   */
  const flightTarget = useCallback((): Camera => flight.current?.to ?? cam.current, []);

  /**
   * Whether a flight is currently in the air - a synchronous read for a
   * caller that needs to know it is safe to treat `cam.current` as settled
   * (e.g. a rearrangement that plans against whatever the camera is already
   * showing, rather than flying it home first).
   */
  const isFlying = useCallback((): boolean => flight.current != null, []);

  return { cam, flyTo, nudgeBy, flightTarget, isFlying };
}
