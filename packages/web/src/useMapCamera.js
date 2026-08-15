import { useCallback, useEffect, useRef } from 'react';
import { cameraAtCell, clampZoom, glideStep, panByPixels, zoomAt, zoomBy } from './camera.js';

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
 * `camera` is required, and there is deliberately no fallback opening zoom in
 * this file: that number is a by-feel one and belongs to `packages/config`, so
 * a default here would be a second statement of it that could drift.
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
 */

/** How long a press must be held, and how far it may wander before it is a drag. */
const LONG_PRESS_MS = 500;
const PRESS_SLOP_PX = 8;

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
 * @param {{minZoom: number, maxZoom: number, defaultZoom: number}} opts.camera
 *   resolved `config.camera`, from the manifest
 * @param {(px: number, py: number, cam: object) => void} [opts.onPick]
 *   canvas-relative point of a right-click or a completed long press, with the
 *   live camera - which the hook owns, so the consumer does not have to reach
 *   back for a ref this hook has not returned yet
 * @param {(line: string) => void} [opts.onDebug] one line per pointer event.
 *   Off unless asked for. Touch gestures can only really be judged on a device,
 *   and a phone has no console you can read while both thumbs are busy - so
 *   this exists to make "what did the browser actually send" answerable from
 *   the glass. See `?touchdebug` in main.jsx.
 */
export function useMapCamera({ canvasRef, resistanceAt, onChange, camera, onPick, onDebug }) {
  const limits = { min: camera.minZoom, max: camera.maxZoom };
  const cam = useRef({
    x: 0.5,
    y: 0.5,
    zoom: clampZoom(camera.defaultZoom, limits),
    limits,
  });
  const drag = useRef(null);
  const press = useRef(null);
  const pointers = useRef(new Map());
  const pinch = useRef(null);

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
     * This is a hazard the spec allows, not a bug anyone has hit here: it was
     * found while chasing a pinch failure that turned out to be a stale server
     * process serving old code. Kept because `pointercancel` reaches this path
     * with capture already dropped, and the cost is a try/catch.
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
        report('down', e);
        return;
      }

      drag.current = { x: e.clientX, y: e.clientY };
      report('down', e);
      if (onPick) {
        const { clientX, clientY } = e;
        press.current = {
          x: clientX,
          y: clientY,
          timer: setTimeout(() => {
            press.current = null;
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
        report(e.type, e);
        return;
      }

      canvas.classList.remove('dragging');
      drag.current = null;
      pinch.current = null;
      report(e.type, e);
    };

    const onWheel = (e) => {
      e.preventDefault();
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
  }, [canvasRef, resistanceAt, onChange, onPick, onDebug]);

  // Glide back toward the content region when released outside it, so the edge
  // pushes back rather than trapping.
  useEffect(() => {
    let raf;
    const tick = () => {
      if (!drag.current) {
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
  }, [resistanceAt, onChange]);

  const flyTo = useCallback(
    (x, y, zoom) => {
      cam.current = cameraAtCell(cam.current, x, y, zoom);
      onChange?.();
    },
    [onChange]
  );

  return { cam, flyTo };
}
