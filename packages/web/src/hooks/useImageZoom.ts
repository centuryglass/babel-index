import { useCallback, useEffect, useRef, useState } from 'react';
import { clampZoomState, INITIAL_ZOOM, type ZoomState } from '../lib/imageZoom.ts';

/**
 * Two-finger pinch-to-zoom and one-finger pan, scoped to a single image -
 * so a room overlay's tile can be zoomed in on without touching the
 * browser's own page zoom, which two real-device reports ruled out:
 * native pinch zoom moves the ENTIRE page, and fixed-size, absolutely-
 * positioned chrome elsewhere in the document (the map canvas, its search
 * badge) never tracks that and is left visibly detached the moment a
 * reader also PANS the zoomed page, not just zooms it - see
 * docs/pending_task_list.md. Confining the gesture to one element with its
 * own `touch-action` sidesteps that whole class of bug: nothing outside
 * this element is ever touched, and the zoom resets for free whenever
 * `resetKey` changes (a new room shown in the same overlay) since it is
 * just React state, not anything the browser has to be asked to undo.
 *
 * Deliberately minimal next to `useMapCamera.ts`'s pinch handling: no
 * flights, no glide, no anchoring the zoom under the fingers - this is a
 * detail viewer for one static image, not a navigable world. `tx`/`ty` are
 * plain CSS `translate` pixels, which `clampZoomState` bounds against the
 * element's own unscaled size (`transform` doesn't affect layout, so that
 * size is stable to read at any point mid-gesture).
 *
 * `touch-action` on the element itself switches with `zoomed`
 * (`pan-y` at rest, `none` once zoomed) so a single-finger drag over the
 * tile scrolls the dialog beneath it exactly as it always could, right up
 * until the reader actually zooms in - then the same drag pans the image
 * instead, same as any other photo viewer.
 */
export function useImageZoom(resetKey: unknown) {
  const [node, setNode] = useState<HTMLImageElement | null>(null);
  const [state, setState] = useState<ZoomState>(INITIAL_ZOOM);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    setState(INITIAL_ZOOM);
  }, [resetKey]);

  useEffect(() => {
    if (!node) return;

    const pointers = new Map<number, { x: number; y: number }>();
    let gesture: { dist: number; midX: number; midY: number; start: ZoomState } | null = null;

    const midOf = (pts: { x: number; y: number }[]) => ({
      x: (pts[0].x + pts[1].x) / 2,
      y: (pts[0].y + pts[1].y) / 2,
    });
    const distOf = (pts: { x: number; y: number }[]) => Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const startGesture = () => {
      const pts = [...pointers.values()];
      const mid = pts.length === 2 ? midOf(pts) : pts[0];
      gesture = { dist: pts.length === 2 ? distOf(pts) : 0, midX: mid.x, midY: mid.y, start: stateRef.current };
    };

    const onPointerDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // A single finger only drives a pan once already zoomed in - at rest
      // it's left alone so the dialog's own vertical scroll (`pan-y`, see
      // style.css) can take the same drag over the tile.
      if (pointers.size === 1 && stateRef.current.scale <= 1) return;
      try {
        node.setPointerCapture(e.pointerId);
      } catch {
        // best-effort, same as the map's own pinch handling (useMapCamera.ts)
      }
      startGesture();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!gesture) return;
      e.preventDefault();
      const pts = [...pointers.values()];
      const mid = pts.length === 2 ? midOf(pts) : pts[0];
      const scale = pts.length === 2 && gesture.dist > 0 ? gesture.start.scale * (distOf(pts) / gesture.dist) : gesture.start.scale;
      // offsetWidth/Height read the element's LAYOUT box, which a CSS
      // `transform` never touches (only paint) - unlike getBoundingClientRect,
      // this is the right "size at scale: 1" clampZoomState wants regardless
      // of the scale already applied.
      setState(
        clampZoomState(
          {
            scale,
            tx: gesture.start.tx + (mid.x - gesture.midX),
            ty: gesture.start.ty + (mid.y - gesture.midY),
          },
          node.offsetWidth,
          node.offsetHeight
        )
      );
    };

    const endPointer = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size > 0) startGesture();
      else gesture = null;
    };

    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', endPointer);
    node.addEventListener('pointercancel', endPointer);
    return () => {
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', endPointer);
      node.removeEventListener('pointercancel', endPointer);
    };
  }, [node]);

  const zoomed = state.scale > 1.001;
  return {
    ref: useCallback((el: HTMLImageElement | null) => setNode(el), []),
    zoomed,
    style: { transform: `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})` },
  };
}
