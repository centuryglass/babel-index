/**
 * The map renderer switch: the WebGL one (`glRenderer.ts` and
 * `glSlideRenderer.ts`, wired up by `useMapRendererGL.ts`) or the Canvas2D one
 * (`render.ts` and `slide.ts`). docs/agents/rendering.md's "The WebGL renderer"
 * carries the standing rule, including why the Canvas2D hatch stays while both
 * renderers exist; this module turns a url into that choice.
 */

/** Which renderer a visit with no `webgl` parameter gets. */
export const DEFAULT_WEBGL = true;

/**
 * False where no WebGL2 context can be made: no DOM to ask, or a `getContext`
 * that returns null or throws. A device with no WebGL2 therefore gets
 * Canvas2D whatever the flag says; without the probe it would reach
 * `createGLContext`, get null, and be left with an undrawn canvas -
 * `useMapRendererGL.ts`'s setup returns without building a renderer.
 */
function supportsWebGL2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

/**
 * A present `webgl` parameter overrides the default; an absent one leaves
 * `DEFAULT_WEBGL` the answer. The regex is what decides an override: only the
 * values it matches mean Canvas2D, so a bare `?webgl` forces WebGL on.
 */
function wantsWebGL(): boolean {
  const params = new URLSearchParams(location.search);
  if (!params.has('webgl')) return DEFAULT_WEBGL;
  const value = params.get('webgl') ?? '';
  return !/^(0|off|false|no)$/i.test(value);
}

/**
 * The flag and the probe folded together, read once at module scope like
 * `debug.ts`'s `DEBUG` and `perfProbe.ts`'s `PERF`. `main.tsx` is its only
 * reader.
 */
export const WEBGL =
  typeof location !== 'undefined' && wantsWebGL() && supportsWebGL2();
