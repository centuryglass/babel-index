import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  INITIAL_CAMERA,
  MAX_SCALE,
  clampToBounds,
  panBy,
  zoomAtPoint,
  type ContentCamera,
  type Point,
  type Size,
} from '../lib/contentZoomCamera.ts';

interface Frame {
  contentOrigin: Point;
  viewport: Size;
  content: Size;
}

/**
 * Two-finger pinch-to-zoom and one-finger pan, scoped to one DOM subtree -
 * a room overlay's tile-and-story, a help/book dialog's page, the catalog
 * list - so a reader can magnify any of it without touching the browser's
 * own page zoom. Native zoom moves the ENTIRE page, and fixed-size,
 * absolutely-positioned chrome elsewhere in the document (the map canvas,
 * its search badge) never tracks that; worse, on Firefox Mobile a
 * viewport-meta reset meant to undo a native zoom/pan after a dialog
 * closes doesn't reliably take (Firefox bug 1498729 - a dynamically-
 * mutated viewport meta doesn't discard its old parsed values there),
 * leaving a zoom/pan that leaks past whatever dialog it happened in.
 * Confining the gesture to one scoped element sidesteps both problems:
 * nothing outside it is ever touched, and the zoom resets for free
 * whenever `resetKey` changes, since it is just React state, not
 * anything the browser has to be asked to undo.
 *
 * Entirely independent of the map's own camera (`camera.ts`/
 * `useMapCamera.ts`) - this is private React state per hook instance, so
 * a content zoom here can never affect, or be affected by, the map's zoom.
 *
 * `viewportRef` and the returned `ref` are deliberately two different
 * elements: the content being scaled is often taller/wider than the
 * region showing it (a long story, a tall virtualized list) and already
 * scrolled to an arbitrary offset within it when a gesture starts - see
 * `contentZoomCamera.ts`'s file doc comment for why the geometry needs
 * both rather than just the zoomed element's own size, the mistake an
 * earlier, image-only version of this hook (`imageZoom.ts`) made
 * unproblematically only because a room overlay's tile happens to be
 * about the size of its own viewport.
 */
export function useContentZoom(viewportRef: RefObject<HTMLElement | null>, resetKey?: unknown) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [camera, setCamera] = useState<ContentCamera>(INITIAL_CAMERA);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const frameRef = useRef<Frame | null>(null);

  useEffect(() => {
    setCamera(INITIAL_CAMERA);
    frameRef.current = null;
  }, [resetKey]);

  // Only valid to call while `node`/`viewportRef.current` are still at the
  // untransformed identity (scale 1) - that's the one moment their
  // `getBoundingClientRect()` reflects true natural layout, unaffected by
  // any zoom this hook itself has painted.
  const captureFrame = useCallback((): Frame | null => {
    const content = node;
    const viewport = viewportRef.current;
    if (!content || !viewport) return null;
    const vRect = viewport.getBoundingClientRect();
    const cRect = content.getBoundingClientRect();
    const frame: Frame = {
      contentOrigin: { x: cRect.left - vRect.left, y: cRect.top - vRect.top },
      viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
      content: { width: content.offsetWidth, height: content.offsetHeight },
    };
    frameRef.current = frame;
    return frame;
  }, [node, viewportRef]);

  const applyZoom = useCallback(
    (factor: number, screenAnchor?: Point) => {
      const frame = frameRef.current ?? captureFrame();
      if (!frame) return;
      const anchor = screenAnchor
        ? { x: screenAnchor.x - frame.contentOrigin.x, y: screenAnchor.y - frame.contentOrigin.y }
        : { x: frame.viewport.width / 2 - frame.contentOrigin.x, y: frame.viewport.height / 2 - frame.contentOrigin.y };
      const zoomed = zoomAtPoint(cameraRef.current, anchor, factor, MAX_SCALE);
      setCamera(clampToBounds(zoomed, frame.viewport, frame.content, frame.contentOrigin));
    },
    [captureFrame]
  );

  // Buttons/keyboard: the non-pinch path a reader who can't (or doesn't
  // want to) use touch still needs - see the plan this hook implements,
  // "a non-pinch way to reach the same zoom." Always anchored at the
  // viewport's own center rather than a gesture midpoint.
  const zoomIn = useCallback(() => applyZoom(1.5), [applyZoom]);
  const zoomOut = useCallback(() => applyZoom(1 / 1.5), [applyZoom]);
  const resetZoom = useCallback(() => {
    setCamera(INITIAL_CAMERA);
    frameRef.current = null;
  }, []);

  useEffect(() => {
    if (!node) return;

    const pointers = new Map<number, Point>();
    let gesture: { dist: number; midX: number; midY: number; start: ContentCamera; frame: Frame } | null = null;
    // A single pointer down while already zoomed is ambiguous - it might be
    // the start of a pan, or it might be a plain click/tap on real content
    // inside the zoomed scope (a keyword chip, "read the rest", a link in
    // the artist's statement). Unlike the old tile-only `useImageZoom.ts`,
    // this hook wraps content that CAN contain such controls, so claiming
    // the pointer immediately would silently break every one of them.
    // `dragCandidate` defers the claim until the pointer has actually moved
    // past a slop radius - short of that, nothing here calls
    // `setPointerCapture`/`preventDefault`, so an unmoved pointer up still
    // reaches whatever is under it as an ordinary click. A two-finger pinch
    // has no such ambiguity and claims immediately, same as before.
    let dragCandidate: { pointerId: number; x: number; y: number } | null = null;
    const DRAG_SLOP = 6;

    const midOf = (pts: Point[]) => ({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 });
    const distOf = (pts: Point[]) => Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);

    const startGesture = () => {
      const pts = [...pointers.values()];
      const mid = pts.length === 2 ? midOf(pts) : pts[0];
      const frame = frameRef.current ?? captureFrame();
      if (!frame) return;
      gesture = { dist: pts.length === 2 ? distOf(pts) : 0, midX: mid.x, midY: mid.y, start: cameraRef.current, frame };
    };

    const claimPointer = (pointerId: number) => {
      dragCandidate = null;
      try {
        node.setPointerCapture(pointerId);
      } catch {
        // best-effort, same as the map's own pinch handling (useMapCamera.ts)
      }
      startGesture();
    };

    const onPointerDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // At rest, a single finger is left alone entirely so the region's own
      // vertical scroll (`pan-y`, see style.css) - or a plain click on its
      // content - can take the same pointer.
      if (pointers.size === 1 && cameraRef.current.scale <= 1) return;
      if (pointers.size === 1) {
        dragCandidate = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
        return;
      }
      // A second pointer down means a pinch - unambiguous, claim it now.
      claimPointer(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!gesture && dragCandidate && dragCandidate.pointerId === e.pointerId) {
        const moved = Math.hypot(e.clientX - dragCandidate.x, e.clientY - dragCandidate.y);
        if (moved < DRAG_SLOP) return;
        claimPointer(e.pointerId);
      }
      if (!gesture) return;
      e.preventDefault();
      const pts = [...pointers.values()];
      const mid = pts.length === 2 ? midOf(pts) : pts[0];
      const factor = pts.length === 2 && gesture.dist > 0 ? distOf(pts) / gesture.dist : 1;
      const frame = gesture.frame;
      // Anchored at the gesture's own START midpoint (not the current one) -
      // zoomAtPoint keeps content fixed at that screen point, then panBy
      // below carries everything the rest of the way to wherever the
      // fingers have moved since. Computed fresh from `gesture.start` each
      // move, never accumulated frame-over-frame, so nothing drifts.
      const anchor = { x: gesture.midX - frame.contentOrigin.x, y: gesture.midY - frame.contentOrigin.y };
      const zoomed = zoomAtPoint(gesture.start, anchor, factor, MAX_SCALE);
      const panned = panBy(zoomed, mid.x - gesture.midX, mid.y - gesture.midY);
      setCamera(clampToBounds(panned, frame.viewport, frame.content, frame.contentOrigin));
    };

    const endPointer = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (dragCandidate?.pointerId === e.pointerId) dragCandidate = null;
      if (!gesture) return;
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
  }, [node, captureFrame]);

  const zoomed = camera.scale > 1.001;
  return {
    ref: useCallback((el: HTMLElement | null) => setNode(el), []),
    zoomed,
    style: { transform: `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.scale})` },
    zoomIn,
    zoomOut,
    resetZoom,
    canZoomIn: camera.scale < MAX_SCALE - 0.001,
    canZoomOut: zoomed,
  };
}
