/**
 * The center tile's composited spine text (`center.ts`'s `composeSpines`),
 * rendered once to an offscreen 2D canvas and cached as a GL texture.
 * `render.ts` re-runs `composeSpines` on its live context every frame -
 * refitting every spine's font via `measureText` even though only the scale
 * has changed - which this cache avoids for the GL path; the Canvas2D path
 * still carries that per-frame cost, uncached.
 *
 * `composeSpines` is called unmodified against the offscreen canvas's own 2D
 * context, which satisfies `SpineContext` natively - it is a real
 * `CanvasRenderingContext2D`. Only how its output reaches the screen is
 * ported here. The offscreen canvas starts transparent and `composeSpines`
 * paints only text/backdrops/halos onto it, so the texture composites over
 * the tile quad already drawn beneath it through the alpha blending
 * `gl/context.ts` enables.
 *
 * The cache key is slot content, hover, and the destination size through
 * `bucket()` - so a zoom that doesn't cross a bucket reuses the previous
 * texture, drawn into the new-size destination, and a pointer move that
 * stays off every book costs nothing.
 */
import { composeSpines, type Slot, type SpineContext, type SpineFontLimits } from '../center.ts';

export interface GLSpineTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
}

export interface SpineTextureCache {
  get(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    slots: (Slot | null)[],
    hoveredBook: number | null,
    fontLimits: SpineFontLimits
  ): GLSpineTexture | null;
  /** Drops the cached texture without freeing GPU state - the right shape for a lost context, whose handles are already invalid. `useMapRendererGL.ts`'s lost-context handling drops the whole cache instead of calling this. */
  reset(): void;
  /** Frees the resident texture via `gl.deleteTexture`, if any, then drops it. */
  dispose(gl: WebGL2RenderingContext): void;
}

/** Rounds a size to the nearest 8 device pixels; the cache key uses the rounded value, not the canvas's actual one. */
const bucket = (n: number): number => Math.round(n / 8) * 8;

export function createSpineTextureCache(): SpineTextureCache {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas?.getContext('2d') ?? null;
  let cached: { key: string; entry: GLSpineTexture } | null = null;

  function get(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    slots: (Slot | null)[],
    hoveredBook: number | null,
    fontLimits: SpineFontLimits
  ): GLSpineTexture | null {
    if (!canvas || !ctx) return null;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const key = JSON.stringify([
      slots.map((s) => (s ? [s.kind, s.text, s.term, s.action] : null)),
      hoveredBook,
      bucket(w),
      bucket(h),
    ]);
    if (cached && cached.key === key) return cached.entry;

    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    composeSpines(ctx as unknown as SpineContext, { x: 0, y: 0, w, h }, slots, hoveredBook, fontLimits);

    if (cached) gl.deleteTexture(cached.entry.texture);
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const entry: GLSpineTexture = { texture, width: w, height: h };
    cached = { key, entry };
    return entry;
  }

  function reset(): void {
    cached = null;
  }

  function dispose(gl: WebGL2RenderingContext): void {
    if (cached) gl.deleteTexture(cached.entry.texture);
    cached = null;
  }

  return { get, reset, dispose };
}
