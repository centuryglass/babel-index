/**
 * Pure zoom/pan-bounds math for `useImageZoom` - scoped pinch-to-zoom on one
 * image element, kept DOM-free so the clamping can be asserted without a
 * browser, the same split as `camera.ts`/`useMapCamera.ts`.
 */

export interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
}

export const INITIAL_ZOOM: ZoomState = { scale: 1, tx: 0, ty: 0 };

export const MAX_SCALE = 4;

/**
 * Keeps `scale` in [1, MAX_SCALE] and `tx`/`ty` from panning the zoomed
 * image past showing empty space beyond its own edge. `width`/`height` are
 * the element's own rendered size at `scale: 1` - CSS `transform` doesn't
 * affect layout, so that's just the element's current `getBoundingClientRect`
 * regardless of what `scale` it's being asked to clamp to.
 */
export function clampZoomState(state: ZoomState, width: number, height: number): ZoomState {
  const scale = Math.min(MAX_SCALE, Math.max(1, state.scale));
  const maxTx = (width * (scale - 1)) / 2;
  const maxTy = (height * (scale - 1)) / 2;
  return {
    scale,
    // `|| 0` folds a `-0` (Math.max(-0, ...) at scale 1, where maxTx/maxTy
    // are themselves 0) back to a plain `0` - harmless in a CSS `translate`
    // either way, but not a distinction worth asserting around.
    tx: Math.min(maxTx, Math.max(-maxTx, state.tx)) || 0,
    ty: Math.min(maxTy, Math.max(-maxTy, state.ty)) || 0,
  };
}
