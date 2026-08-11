import { useCallback, useEffect, useRef } from 'react';

/**
 * Pan/zoom camera over an unbounded tile grid.
 *
 * World units are tiles: the cell at integer (x, y) occupies the unit square
 * from (x, y) to (x+1, y+1), and the centre room sits at (0, 0).
 *
 * The camera is held in a ref rather than in state. It changes on every pointer
 * move and every animation frame, and React does not need to re-render for any
 * of that - the canvas is redrawn directly.
 */
export function useMapCamera({ canvasRef, resistanceAt, onChange }) {
  const cam = useRef({ x: 0.5, y: 0.5, zoom: 220 });
  const drag = useRef(null);
  const velocity = useRef({ x: 0, y: 0 });

  const clampZoom = (z) => Math.min(900, Math.max(26, z));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onPointerDown = (e) => {
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
      drag.current = { x: e.clientX, y: e.clientY, moved: false };
      velocity.current = { x: 0, y: 0 };
    };

    const onPointerMove = (e) => {
      if (!drag.current) return;
      const dx = (e.clientX - drag.current.x) / cam.current.zoom;
      const dy = (e.clientY - drag.current.y) / cam.current.zoom;
      drag.current = { x: e.clientX, y: e.clientY, moved: true };

      // Resistance is sampled where the camera is trying to go, so pushing
      // outward gets progressively heavier instead of stopping at a wall.
      const damp = resistanceAt(cam.current.x, cam.current.y);
      const scale = 0.12 + 0.88 * damp;
      cam.current.x -= dx * scale;
      cam.current.y -= dy * scale;
      velocity.current = { x: -dx * scale, y: -dy * scale };
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
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      // Keep the world point under the cursor fixed across the zoom.
      const before = screenToWorld(px, py, cam.current, rect);
      cam.current.zoom = clampZoom(cam.current.zoom * Math.exp(-e.deltaY * 0.0014));
      const after = screenToWorld(px, py, cam.current, rect);
      cam.current.x += before.x - after.x;
      cam.current.y += before.y - after.y;
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
        const damp = resistanceAt(cam.current.x, cam.current.y);
        if (damp < 0.999) {
          const d = Math.hypot(cam.current.x, cam.current.y) || 1;
          const pull = (1 - damp) * 0.06;
          cam.current.x -= (cam.current.x / d) * pull * d * 0.08;
          cam.current.y -= (cam.current.y / d) * pull * d * 0.08;
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
      cam.current.x = x + 0.5;
      cam.current.y = y + 0.5;
      if (zoom) cam.current.zoom = clampZoom(zoom);
      onChange?.();
    },
    [onChange]
  );

  return { cam, flyTo };
}

function screenToWorld(px, py, cam, rect) {
  return {
    x: cam.x + (px - rect.width / 2) / cam.zoom,
    y: cam.y + (py - rect.height / 2) / cam.zoom,
  };
}
