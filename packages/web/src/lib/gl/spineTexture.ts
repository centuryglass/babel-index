/**
 * Spike: the center tile's composited spine text (`center.ts`'s
 * `composeSpines`), rendered once to an offscreen 2D canvas and cached as a
 * GL texture rather than re-run every frame - this is also a live
 * implementation of `docs/performance-research.md` §3.2's spine-memoization
 * idea, which the Canvas2D path has never needed since it never shipped.
 *
 * `composeSpines` is called UNMODIFIED against the offscreen canvas's own 2D
 * context, which satisfies `SpineContext` natively (it is a real
 * `CanvasRenderingContext2D`) - no port of the spine-drawing logic itself,
 * only of how its output reaches the screen. The offscreen canvas starts
 * transparent and `composeSpines` paints only text/backdrops/halos onto it,
 * so the resulting texture composites correctly over whatever tile quad is
 * already drawn beneath it (see `glRenderer.ts`'s existing alpha blending -
 * no shader changes needed).
 *
 * Re-rendered only when the key (slot content + hover + destination size,
 * rounded) changes - a zoom that doesn't cross an 8px bucket, or a pointer
 * move that stays off every book, costs nothing here.
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
}

/** Buckets a size to the nearest 8 device pixels, so a smooth zoom doesn't re-render every frame - see this file's doc. */
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

  return { get };
}
