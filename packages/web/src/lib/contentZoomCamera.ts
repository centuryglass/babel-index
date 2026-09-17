/**
 * Pure zoom/pan-bounds math for a scoped "content camera" - pinch-to-zoom
 * and one-finger pan applied to one DOM subtree via CSS transform. Kept
 * DOM-free so the geometry can be asserted without a browser, the same
 * split as `camera.ts`/`useMapCamera.ts`.
 *
 * The math is viewport-relative: it must hold for content taller or wider
 * than the region showing it (a long story, a tall virtualized catalog
 * list) and already scrolled to an offset within it when a gesture starts,
 * not just for a tile roughly the size of its own viewport.
 * `useContentZoom.ts` paints with `transform: translate(tx, ty)
 * scale(scale)` and `transform-origin: 0 0`, so every coordinate here is in
 * the content element's own untransformed top-left corner space.
 * `contentOrigin` is where that corner sits relative to the viewport,
 * captured once per zoom session while the content is still at identity
 * scale (`useContentZoom.ts`'s `captureFrame`).
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
 * Scales around `anchor` (a content-local point) so whatever content is at
 * that point stays where it is on screen across the scale change - the
 * pinch-keeps-content-under-the-fingers rule, the same invariant
 * `camera.ts`'s `zoomBy` implements for the map's world-cell camera, in
 * content pixels rather than cells.
 *
 * Derivation: with `transform-origin: 0 0`, a content-local point `p`
 * paints at `contentOrigin + scale*p + (tx,ty)`. Holding `contentOrigin`
 * fixed (it doesn't change mid-gesture) and keeping `anchor`'s screen
 * position the same before and after the scale change gives
 * `tx' = tx + anchor.x * (scale - scale')`.
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
 * beyond the content's own edges. The viewport and content sizes are
 * parameterized independently - content may already be bigger than the
 * viewport at scale 1 - along with `contentOrigin` (see the file header).
 *
 * On an axis where the scaled content is smaller than the viewport, the
 * content is centered on that axis. At scale 1 the camera returns to the
 * identity, so a scope at rest shows what native scroll already showed,
 * with no leftover pan.
 */
export function clampToBounds(camera: ContentCamera, viewport: Size, content: Size, contentOrigin: Point): ContentCamera {
  const scale = Math.min(MAX_SCALE, Math.max(1, camera.scale));
  if (scale <= 1) return INITIAL_CAMERA;

  const clampAxis = (translate: number, contentSize: number, viewportSize: number, origin: number) => {
    const scaledSize = contentSize * scale;
    if (scaledSize <= viewportSize) return (viewportSize - scaledSize) / 2 - origin;
    const maxTranslate = -origin;
    const minTranslate = viewportSize - origin - scaledSize;
    // `|| 0` folds a `-0` (what `-origin` yields when `origin` is `0`) into
    // a plain `0` - CSS `translate` treats the two the same, but one value
    // keeps assertions clean.
    return Math.min(maxTranslate, Math.max(minTranslate, translate)) || 0;
  };

  return {
    scale,
    tx: clampAxis(camera.tx, content.width, viewport.width, contentOrigin.x),
    ty: clampAxis(camera.ty, content.height, viewport.height, contentOrigin.y),
  };
}
