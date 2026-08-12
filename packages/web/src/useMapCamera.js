import { useCallback, useEffect, useRef } from 'react';
import { cameraAtCell, glideStep, panByPixels, zoomAt } from './camera.js';

/**
 * Pan/zoom camera over an unbounded tile grid.
 *
 * This hook owns the pointer plumbing only; the maths lives in `camera.js` as
 * pure functions, where it can be tested without a DOM.
 *
 * The camera is held in a ref rather than in state. It changes on every pointer
 * move and every animation frame, and React does not need to re-render for any
 * of that - the canvas is redrawn directly.
 */
export function useMapCamera({ canvasRef, resistanceAt, onChange }) {
  const cam = useRef({ x: 0.5, y: 0.5, zoom: 220 });
  const drag = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onPointerDown = (e) => {
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
      drag.current = { x: e.clientX, y: e.clientY, moved: false };
    };

    const onPointerMove = (e) => {
      if (!drag.current) return;
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      drag.current = { x: e.clientX, y: e.clientY, moved: true };

      // Resistance is sampled where the camera is now, so pushing outward gets
      // progressively heavier instead of stopping at a wall.
      cam.current = panByPixels(cam.current, dx, dy, resistanceAt(cam.current.x, cam.current.y));
      onChange?.();
    };

    const onPointerUp = (e) => {
      canvas.releasePointerCapture?.(e.pointerId);
      canvas.classList.remove('dragging');
      drag.current = null;
    };

    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      cam.current = zoomAt(cam.current, e.clientX - rect.left, e.clientY - rect.top, e.deltaY, rect);
      onChange?.();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [canvasRef, resistanceAt, onChange]);

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
