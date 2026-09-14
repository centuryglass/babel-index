/**
 * Pure zoom/pan-bounds math for a scoped "content camera" - pinch-to-zoom
 * and pan applied to one DOM subtree via CSS transform, kept DOM-free so
 * the geometry can be asserted without a browser (the same split as
 * `camera.ts`/`useMapCamera.ts`, and the split `imageZoom.ts`/
 * `useImageZoom.ts` used before this replaced them).
 *
 * `imageZoom.ts`'s old `clampZoomState` assumed the zoomed element's own
 * box WAS the viewport - true for a tile image sized close to its own
 * visible box, false for content that can be taller/wider than the
 * scrollable region showing it (a long story, a tall virtualized catalog
 * list) and already scrolled to some offset within it when a gesture
 * starts. `useContentZoom.ts` always paints with `transform: translate(tx,
 * ty) scale(scale)` and `transform-origin: 0 0`, so every coordinate here
 * is relative to the content element's own NATURAL (untransformed)
 * top-left corner - `contentOrigin` is where that corner currently sits
 * relative to the viewport, measured once per zoom session before any
 * transform is applied (see useContentZoom.ts's `captureFrame`).
 */

export interface ContentCamera {
  scale: number;
  tx: number;
  ty: number;
}

export const INITIAL_CAMERA: ContentCamera = { scale: 1, tx: 0, ty: 0 };

export const MAX_SCALE = 4;

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Scales around `anchor` (a point in content-local coordinates - see the
 * file doc comment) so whatever content is currently rendered at that
 * point stays exactly where it is on screen after the scale change - the
 * "pinch keeps content under your fingers" invariant, the same thing
 * `camera.ts`'s `zoomBy` does for the map's own world-cell camera,
 * reworked here in plain content pixels rather than cells.
 *
 * Derivation: with `transform-origin: 0 0`, a content-local point `p`
 * paints at screen position `contentOrigin + scale*p + (tx,ty)`. Holding
 * `contentOrigin` fixed (it doesn't change mid-gesture) and requiring
 * `anchor`'s screen position to be the same before and after the scale
 * change gives `tx' = tx + anchor.x * (scale - scale')`.
 */
export function zoomAtPoint(camera: ContentCamera, anchor: Point, factor: number, maxScale = MAX_SCALE): ContentCamera {
  const scale = Math.min(maxScale, Math.max(1, camera.scale * factor));
  if (scale === camera.scale) return camera;
  return {
    scale,
    tx: camera.tx + anchor.x * (camera.scale - scale),
    ty: camera.ty + anchor.y * (camera.scale - scale),
  };
}

/** A plain translate - one-finger pan, or a pinch's midpoint drift. */
export function panBy(camera: ContentCamera, dx: number, dy: number): ContentCamera {
  return { ...camera, tx: camera.tx + dx, ty: camera.ty + dy };
}

/**
 * Keeps `scale` in `[1, MAX_SCALE]` and `tx`/`ty` from showing empty space
 * beyond the content's own edges - the generalized replacement for
 * `imageZoom.ts`'s `clampZoomState`, parameterized by the viewport and
 * content sizes independently (content may already be bigger than the
 * viewport at scale 1) plus `contentOrigin` (see the file doc comment).
 *
 * On an axis where the scaled content is smaller than the viewport, it is
 * centered rather than pinned to one edge. At scale 1 the camera is
 * always forced back to the identity - the rest state is exactly what
 * native scroll already shows, never a leftover pan.
 */
export function clampToBounds(camera: ContentCamera, viewport: Size, content: Size, contentOrigin: Point): ContentCamera {
  const scale = Math.min(MAX_SCALE, Math.max(1, camera.scale));
  if (scale <= 1) return INITIAL_CAMERA;

  const clampAxis = (translate: number, contentSize: number, viewportSize: number, origin: number) => {
    const scaledSize = contentSize * scale;
    if (scaledSize <= viewportSize) return (viewportSize - scaledSize) / 2 - origin;
    const maxTranslate = -origin;
    const minTranslate = viewportSize - origin - scaledSize;
    // `|| 0` folds a `-0` (from `-origin` when `origin` is exactly `0`) back
    // to a plain `0` - harmless in a CSS `translate` either way, but not a
    // distinction worth asserting around (same fold `imageZoom.ts` used to do).
    return Math.min(maxTranslate, Math.max(minTranslate, translate)) || 0;
  };

  return {
    scale,
    tx: clampAxis(camera.tx, content.width, viewport.width, contentOrigin.x),
    ty: clampAxis(camera.ty, content.height, viewport.height, contentOrigin.y),
  };
}
