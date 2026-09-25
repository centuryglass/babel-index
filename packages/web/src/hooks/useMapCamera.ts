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
  type Camera,
} from '../lib/camera.ts';
import type { Config } from '../../../config/config.ts';

/**
 * Pan/zoom camera over an unbounded tile grid: the pointer plumbing, the
 * flight clock and the glide loop. The maths lives in `camera.ts` as pure
 * functions, testable without a DOM.
 *
 * The camera is held in a ref, not state. It changes on every pointer move and
 * animation frame, and the canvas redraws directly without a React render.
 *
 * The configured zoom range rides on the camera as `limits`, so every clamp
 * (wheel, flyTo) reads the same field.
 *
 * `camera` and `opening` are required, with no fallback stated here: the
 * caller derives the opening camera from the display, and the flight duration
 * comes from `packages/config`.
 *
 * ### Picking
 *
 * The metadata overlay opens on right-click or long press, and the long press
 * loses to a pan: a press that turns into a drag must not also open a card.
 * The press timer watches the same pointer stream the drag does, which is this
 * one. What is picked is `picking.ts`; when, is here. Left-click stays free
 * for focusing a room.
 *
 * ### Flying
 *
 * `flyTo` eases the camera, so the flight home after a search shows where the
 * top result sits relative to the reader. The step is `flightAt` in
 * `camera.ts`; the frame clock and the interruption are here.
 *
 * A flight rides the glide's rAF loop. It owns the camera while it lasts and
 * the glide takes over on arrival, so a flight can land outside the content
 * region and be pulled back afterwards. Don't start a second loop.
 *
 * Every gesture threshold (press/tap timing and slop) comes from
 * `camera.gesture`; `packages/config/config.ts`'s `gesture` block (nested
 * under `camera`) has the defaults and the reasoning behind each.
 */

/**
 * Whether the reader has asked for reduced motion; if so, a flight lands in
 * one frame.
 *
 * Read per call, since the setting can change while a page is open. Every hook
 * that animates imports this, so the media query is written once.
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
   * the page-load camera - where the map opens and how far in, derived by the
   * caller from the viewport and the center room's geometry. See `fitZoom` in
   * camera.ts.
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
   * canvas-relative point of a second tap landing within
   * `camera.gesture.doubleTapMs` and `camera.gesture.doubleTapSlopPx` of a
   * qualifying first one. Fires in addition to `onTap` (both fire for the
   * second tap), never instead of it - a single tap must not wait to find
   * out whether a second one is coming, or every ordinary tap (selecting a
   * book, focusing the search field) picks up a `doubleTapMs` delay.
   */
  onDoubleTap?: OnTap;
  /**
   * one line per pointer event, off unless asked for, so what the browser sent
   * can be read on a phone with no console. See `?touchdebug` in main.tsx.
   */
  onDebug?: OnDebug;
}

interface TapCandidate extends PointerPoint {
  moved: boolean;
  interruptedFlight: boolean;
}

/**
 * A candidate two-finger tap, tracked from a second finger landing through
 * the second liftoff. The mid-point (`cx`/`cy`) is fixed at touchdown rather
 * than tracked: any drift beyond `camera.gesture.twoFingerTapSlopPx` cancels
 * the candidate outright (see the pinch branch of `onPointerMove`).
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
    // The page-load camera, not the return-to-center view: see
    // docs/agents/map.md, "Two opening views, and they are not
    // interchangeable". The zoom is re-clamped here to hold the limits.
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
   * Start an eased flight to a whole target camera. `flyTo`, `nudgeBy` and the
   * two-finger tap zoom all go through this, which holds the reduced-motion
   * collapse and the interrupt-the-previous-flight rule.
   *
   * The flight begins at the live camera, so a second flight picks up from
   * wherever the first had got to, even when the caller computed `to` from
   * `flightTarget()`. Where the camera is and where it was last aimed are
   * different questions; see `flightTarget`.
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
     * Pointer capture, best-effort: nothing may depend on it succeeding.
     *
     * Both calls can throw `NotFoundError`, an ordinary state on touch, where
     * capture is implicit and the browser drops it at the end or cancel of a
     * sequence (`pointercancel` arrives here with capture already gone). `?.`
     * guards a missing method, not a throw. An unguarded throw would abort the
     * handler and leave a finger in `pointers`, so every later gesture would
     * read as a pinch.
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
        // Already released, by us or by the browser. The bookkeeping below
        // must run either way.
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

      // A touch gets no focus from the browser here: `onTouchEnd` cancels the
      // synthesized mousedown that would have given it.
      if (e.pointerType === 'touch') canvas.focus();

      // A hand on the map ends any flight, on the press and not the first
      // move, so a press that never becomes a drag still stops it.
      //
      // A press that stopped a flight is the reader halting the map, not a
      // tap on whatever ended up under the finger, and must not fire `onTap`.
      const interruptedFlight = !!flight.current;
      endFlight(false);

      // Record the pointer before capturing it, so the bookkeeping never
      // depends on capture succeeding (see `capture`).
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      capture(e.pointerId);
      canvas.classList.add('dragging');

      cancelPress();

      if (pointers.current.size >= 2) {
        // A second finger ends any press and begins a pinch. The span recorded
        // now makes the first move a ratio against where the fingers started,
        // not a jump.
        const [a, b] = firstTwo(pointers.current);
        pinch.current = spanOf(a, b);
        drag.current = null;
        tap.current = null; // two fingers is a pinch, never a (one-finger) tap

        // Two fingers just landed: a candidate for a two-finger tap,
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
          }, camera.gesture.longPressMs),
        };
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const tracked = pointers.current.get(e.pointerId);
      if (!tracked) return;
      tracked.x = e.clientX;
      tracked.y = e.clientY;

      // A press that wanders past the slop is a drag. The slop keeps a long
      // press reachable on a touchscreen, where a finger never holds still.
      if (
        press.current &&
        Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > camera.gesture.pressSlopPx
      )
        cancelPress();

      // A tap that wanders past the slop is a pan, by the same measure the long
      // press uses.
      if (
        tap.current &&
        Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y) > camera.gesture.pressSlopPx
      )
        tap.current.moved = true;

      if (pinch.current && pointers.current.size >= 2) {
        const [a, b] = firstTwo(pointers.current);
        const span = spanOf(a, b);

        // Drift past the slop, on either the span or the midpoint, rules out
        // a two-finger tap. It is measured from touchdown, not frame to
        // frame, so a slow drift cannot stay under the threshold.
        if (
          twoTap.current &&
          (Math.abs(span.dist - twoTap.current.dist0) > camera.gesture.twoFingerTapSlopPx ||
            Math.hypot(span.cx - twoTap.current.x, span.cy - twoTap.current.y) > camera.gesture.twoFingerTapSlopPx)
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
        // Zoom about the point between the fingers, then follow the midpoint,
        // so a pinch that also slides moves the map with it. Both halves
        // anchor on the same midpoint to keep the world under the fingers.
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
        // Down to one finger. Re-anchor the drag where that finger is,
        // or its next move is measured from wherever the pinch left off and the
        // map lurches by the width of the gesture.
        const [remaining] = firstTwo(pointers.current);
        pinch.current = null;
        drag.current = { x: remaining.x, y: remaining.y };
        tap.current = null; // a pinch was in progress; the release is not a tap

        // The first of a two-finger tap's two liftoffs - still a candidate,
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
        two.firstLiftAt - two.downAt <= camera.gesture.twoFingerTapMs &&
        performance.now() - two.firstLiftAt <= camera.gesture.twoFingerTapGapMs
      ) {
        // A hand back on the map beats anything the map was doing to itself -
        // same rule `onPointerDown` applies to a flight already in the air.
        endFlight(false);
        const rect = canvas.getBoundingClientRect();
        const to = zoomBy(cam.current, two.x - rect.left, two.y - rect.top, 1 / camera.zoomStepFactor, rect);
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
          now - prior.time <= camera.gesture.doubleTapMs &&
          Math.hypot(t.x - prior.x, t.y - prior.y) <= camera.gesture.doubleTapSlopPx
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
      cam.current = zoomAt(
        cam.current, e.clientX - rect.left, e.clientY - rect.top, e.deltaY, rect, camera.wheelZoomRate
      );
      onChange?.();
    };

    // Right-click on desktop, and the menu some browsers raise at the end of a
    // touch long-press - suppressed either way, since the card is the response.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      cancelPress();
      pick(e.clientX, e.clientY);
    };

    // A touch on the map never becomes a click. The browser dispatches a
    // tap's click after `touchend`, hit-testing at dispatch time, so a tap
    // whose `onTap` swaps the view (the shelf's catalog book, via
    // `enterCatalog`) would have its click land on whatever the new view put
    // under the finger - on Firefox for Android, ~370ms later. Only cancelling
    // `touchend` suppresses that click; cancelling `pointerdown` stops the
    // compatibility mousedown/mouseup but not the click. The canvas is hidden
    // rather than unmounted in catalog mode, so it still receives this
    // `touchend` after the swap.
    const onTouchEnd = (e: TouchEvent) => e.preventDefault();

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
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
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    };
  }, [canvasRef, resistanceAt, onChange, onPick, onTap, onDoubleTap, onDebug, endFlight, beginFlightTo, camera]);

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
        // Reduced motion jumps to the rest point. `glideToRest` runs the same
        // step to convergence, so both modes rest in the same place.
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
   * Ease to a cell.
   *
   * The target is a whole camera from `cameraAtCell`, so the clamp and both
   * optional fields are settled before the flight interpolates.
   * `performance.now()` shares a time origin with the rAF timestamps the loop
   * steps on.
   *
   * No `onChange` here: the loop owns every camera change while the flight
   * lasts.
   *
   * The duration is `camera.flightMs`; `ms` overrides it for one call (the
   * keyboard's short moves), keeping the interrupt, the landing promise and
   * the reduced-motion collapse. Reduced motion overrides either duration.
   *
   * Returns a promise for the landing: true if it arrived, false if the reader
   * took the map first. The rearrangement needs both answers. It plans against
   * the cells on screen once the camera stops, and a reader who grabbed the
   * map mid-flight is not waiting to watch the library rebuild.
   */
  const flyTo = useCallback(
    (x: number, y: number, zoom?: number, { ms }: FlyOpts = {}) =>
      beginFlightTo(cameraAtCell(cam.current, x, y, zoom), ms),
    [beginFlightTo]
  );

  /**
   * Move by a cell delta, damped by the map's resistance: the keyboard's
   * equivalent of a pointer drag. See `panByCells` in `camera.ts` for why its
   * curve has no floor.
   *
   * Both the start and the resistance sample come from the flight target,
   * not `cam.current`; see `flightTarget`.
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
   * The camera a chained move builds on: an in-progress flight's target, or
   * `cam.current` when idle.
   *
   * A handler that computes a move from camera state reads this, never
   * `cam.current`. `cam.current` is the flight's interpolated position, and
   * only the rAF loop advances it. Two presses before the loop ticks would both
   * compute from the pre-flight camera and collapse into one move, and a
   * resistance sampled there reads from behind the target and damps too
   * little. The keyboard cursor follows the same rule (`useMapCursor`'s
   * `cursorNow`).
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
