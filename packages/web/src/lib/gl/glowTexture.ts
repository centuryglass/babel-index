/**
 * A hover-glow silhouette (the favorite badge, either distill-toggle state),
 * baked once to an offscreen 2D canvas and cached as a GL texture - what
 * `glRenderer.ts`'s `drawGlow` composites on hover. `render.ts`'s
 * `traceFavoriteToggle`/`traceDistillToggle` and this file's `get` trace the
 * same path commands via `svgPath.ts`'s `tracePathCommands`, so the two
 * renderers draw the identical outline.
 *
 * Every path here is already defined in fractions of the whole tile (see
 * `favoriteBadge.ts`/`distillToggle.ts`), so the bake canvas needs no
 * knowledge of a tile's actual pixel size or aspect:
 * `tracePathCommands` multiplies each coordinate by the canvas's own
 * width/height, and `glRenderer.ts` composites that canvas onto the cell's
 * full screen rect (`cellPx.x` by `cellPx.y`) exactly as `render.ts`
 * stretches the tile art itself. The two independent per-axis scales
 * cancel, so the bake resolution is free to pick without distorting the
 * shape; `BAKE_SIZE` is chosen for curve smoothness, and texture
 * minification/magnification handles any zoom level.
 *
 * Cached per path string. The silhouettes are fixed art, so there is no
 * content/hover/size key to invalidate on like `spineTexture.ts`'s - the
 * shape never changes once traced. Baked lazily on first request: a
 * silhouette never hovered is never baked, and baking at module load would
 * need a `document` that `npm test`'s Node environment does not have (the
 * file is imported there through `glRenderer.ts`).
 */
import { tracePathCommands } from '../svgPath.ts';

/** Bake resolution - see this file's doc for why any value is geometrically valid. */
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
  /** Bakes `d` on first request and caches the result; null when no offscreen canvas is available - see `glRenderer.ts`'s `drawGlow` for what it draws then. */
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
