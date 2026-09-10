/**
 * `?webgl` swaps the Canvas2D map renderer for the experimental WebGL one
 * (`glRenderer.ts`/`glSlideRenderer.ts`/`useMapRendererGL.ts`) - a spike, not
 * a second production path. Read once at module scope, same as `debug.ts`'s
 * `DEBUG` and `perfProbe.ts`'s `PERF`, so a normal session never touches any
 * of this code.
 */
export const WEBGL =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('webgl');
