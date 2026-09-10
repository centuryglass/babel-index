/**
 * `?webgl` swaps the Canvas2D map renderer for the experimental WebGL one
 * (`glRenderer.ts`/`glSlideRenderer.ts`/`useMapRendererGL.ts`) - a spike, not
 * a second production path. Read once at module scope, same as `debug.ts`'s
 * `DEBUG` and `perfProbe.ts`'s `PERF`, so a normal session never touches any
 * of this code.
 *
 * `DEFAULT_WEBGL` is the one line that turns this from an opt-in flag into
 * the default renderer - flip it once the remaining validation in
 * `docs/implementation-plan.md`'s Rendering section is done, not before.
 * `supportsWebGL2()` is a capability probe so a device without WebGL2 falls
 * back to Canvas2D automatically regardless of the flag or the default,
 * instead of `createGLContext` failing later and leaving a blank canvas.
 */
export const DEFAULT_WEBGL = false;

function supportsWebGL2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

export const WEBGL =
  typeof location !== 'undefined' &&
  (new URLSearchParams(location.search).has('webgl') || DEFAULT_WEBGL) &&
  supportsWebGL2();
