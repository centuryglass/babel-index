/**
 * Which map renderer draws: the WebGL one
 * (`glRenderer.ts`/`glSlideRenderer.ts`/`useMapRendererGL.ts`) or the Canvas2D
 * one (`render.ts`/`slide.ts`). Read once at module scope, same as `debug.ts`'s
 * `DEBUG` and `perfProbe.ts`'s `PERF`.
 *
 * `DEFAULT_WEBGL` is which one a plain visit gets. It is now WebGL: the
 * validation in `docs/implementation-plan.md`'s Rendering section (cross-device
 * Safari/BrowserStack, glow outlines, the parity suite) came back clean.
 * `?webgl=0` (also `off`/`false`/`no`) is the escape hatch back to Canvas2D -
 * kept because the render-parity suite needs a Canvas2D control session and a
 * reader hitting a GL-specific glitch has somewhere to go. A bare `?webgl` (or
 * any other value) forces WebGL on. `supportsWebGL2()` is a capability probe so
 * a device without WebGL2 falls back to Canvas2D automatically regardless of
 * the flag or the default, instead of `createGLContext` failing later and
 * leaving a blank canvas.
 */
export const DEFAULT_WEBGL = true;

function supportsWebGL2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

function wantsWebGL(): boolean {
  const params = new URLSearchParams(location.search);
  if (!params.has('webgl')) return DEFAULT_WEBGL;
  const value = params.get('webgl') ?? '';
  return !/^(0|off|false|no)$/i.test(value);
}

export const WEBGL =
  typeof location !== 'undefined' && wantsWebGL() && supportsWebGL2();
