import { useCallback, useEffect, useRef } from 'react';
import { cameraAtCell, clampZoom, glideStep, panByPixels, zoomAt } from './camera.js';

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
 * @param {object} opts
 * @param {{minZoom: number, maxZoom: number, defaultZoom: number}} opts.camera
 *   resolved `config.camera`, from the manifest
 * @param {(px: number, py: number, cam: object) => void} [opts.onPick]
 *   canvas-relative point of a right-click or a completed long press, with the
 *   live camera - which the hook owns, so the consumer does not have to reach
 *   back for a ref this hook has not returned yet
 */

/** How long a press must be held, and how far it may wander before it is a drag. */
const LONG_PRESS_MS = 500;
const PRESS_SLOP_PX = 8;

export function useMapCamera({ canvasRef, resistanceAt, onChange, camera, onPick }) {
  const limits = { min: camera.minZoom, max: camera.maxZoom };
  const cam = useRef({
    x: 0.5,
    y: 0.5,
    zoom: clampZoom(camera.defaultZoom, limits),
    limits,
  });
  const drag = useRef(null);
  const press = useRef(null);

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

    const onPointerDown = (e) => {
      // Secondary buttons are the context menu's, not the map's; starting a drag
      // on one would pan the map out from under a right-click.
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
      drag.current = { x: e.clientX, y: e.clientY, moved: false };

      cancelPress();
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
      if (!drag.current) return;
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      drag.current = { x: e.clientX, y: e.clientY, moved: true };

      // A press that wanders is a drag. The slop is what keeps a long press
      // working on a touchscreen, where a finger never holds perfectly still -
      // cancelling on the first pixel of jitter would make the gesture
      // unreachable on exactly the devices it exists for.
      if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > PRESS_SLOP_PX)
        cancelPress();

      // Resistance is sampled where the camera is now, so pushing outward gets
      // progressively heavier instead of stopping at a wall.
      cam.current = panByPixels(cam.current, dx, dy, resistanceAt(cam.current.x, cam.current.y));
      onChange?.();
    };

    const onPointerUp = (e) => {
      canvas.releasePointerCapture?.(e.pointerId);
      canvas.classList.remove('dragging');
      drag.current = null;
      cancelPress();
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
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    };
  }, [canvasRef, resistanceAt, onChange, onPick]);

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
