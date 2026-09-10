/**
 * A hover-glow silhouette (the favorite badge, either distill-toggle state),
 * baked once to an offscreen 2D canvas and cached as a GL texture - what
 * `glRenderer.ts` composites instead of the spike's flat-rect approximation.
 * `render.ts`'s `traceFavoriteToggle`/`traceDistillToggle` and this file's
 * `bake` both walk the SAME path commands via `svgPath.ts`'s
 * `tracePathCommands`, so the two renderers draw the identical outline.
 *
 * Every path here is already defined in fractions of the WHOLE tile (see
 * `favoriteBadge.ts`/`distillToggle.ts`), so the bake canvas needs no
 * knowledge of a tile's actual pixel size or aspect: `tracePathCommands`
 * multiplies each coordinate by the canvas's own width/height, and
 * `glRenderer.ts` composites that canvas onto the cell's full screen rect
 * (`cellPx.x` by `cellPx.y`) exactly as `render.ts` stretches the tile art
 * itself - the two independent per-axis scales cancel, so the bake
 * resolution is free to pick without distorting the shape. `BAKE_SIZE` is
 * chosen only for curve smoothness; texture minification/magnification
 * handles any zoom level.
 *
 * Cached per path string, keyed by identity since each is a module-level
 * constant (`FAVORITE_TOGGLE_PATH`, `DISTILL_OFF_PATH`, `DISTILL_ON_PATH`) -
 * unlike `spineTexture.ts`'s cache, there is no size/hover/content key to
 * invalidate on, since the shape never changes once traced. Baked lazily on
 * first request (no `document` at module load in `npm test`'s Node
 * environment) rather than at module load, so a corpus with no traced
 * silhouette pays nothing.
 */
import { tracePathCommands } from '../svgPath.ts';

/** Fixed bake resolution - see this file's doc for why any value works. */
const BAKE_SIZE = 256;

/** Same gold as `render.ts`'s `FAVORITE_HOVER_GLOW_FILL`/`_STROKE` - one hover treatment across every integrated control. */
const FILL = 'rgba(200,169,95,0.28)';
const STROKE = 'rgba(200,169,95,0.55)';

export interface GLGlowTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
}

export interface GlowTextureCache {
  /** Bakes `d` on first request and caches the result; null when no offscreen canvas is available (e.g. `npm test`'s Node environment). */
  get(gl: WebGL2RenderingContext, d: string): GLGlowTexture | null;
  /** Frees every resident texture via `gl.deleteTexture`, if any. */
  dispose(gl: WebGL2RenderingContext): void;
}

export function createGlowTextureCache(): GlowTextureCache {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas?.getContext('2d') ?? null;
  const cached = new Map<string, GLGlowTexture>();

  function get(gl: WebGL2RenderingContext, d: string): GLGlowTexture | null {
    const existing = cached.get(d);
    if (existing) return existing;
    if (!canvas || !ctx) return null;

    canvas.width = BAKE_SIZE;
    canvas.height = BAKE_SIZE;
    ctx.clearRect(0, 0, BAKE_SIZE, BAKE_SIZE);
    tracePathCommands(ctx, d, { x: BAKE_SIZE, y: BAKE_SIZE }, 0, 0);
    ctx.fillStyle = FILL;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = STROKE;
    ctx.stroke();

    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const entry: GLGlowTexture = { texture, width: BAKE_SIZE, height: BAKE_SIZE };
    cached.set(d, entry);
    return entry;
  }

  function dispose(gl: WebGL2RenderingContext): void {
    for (const entry of cached.values()) gl.deleteTexture(entry.texture);
    cached.clear();
  }

  return { get, dispose };
}
