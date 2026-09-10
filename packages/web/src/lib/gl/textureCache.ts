/**
 * Spike: wraps `tiles.ts`'s `TileHit.img` in a GL texture, without touching
 * `tiles.ts` itself. `tiles.ts` never mutates a `Drawable` in place - a new
 * decode gets a new object - so the `img` object's own identity is already a
 * stable, zero-coordination cache key: a `WeakMap` needs no invalidation hook
 * into `tiles.ts`'s eviction, because when `tiles.ts` drops its last
 * reference to a bitmap, this map's entry for it becomes unreachable too.
 *
 * What a `WeakMap` does NOT do is call `gl.deleteTexture` when that happens -
 * JS garbage collection runs no cleanup code on a `WeakMap` eviction. This
 * first cut accepts that leak for a session's lifetime (spike-scale memory
 * is fine; see the plan's "known gaps" section) rather than adding a
 * `FinalizationRegistry`.
 *
 * Only handles a real `ImageBitmap` - the browser's actual `Drawable`. The
 * `LoadableImage` half of that union exists for `render.test.ts`'s
 * browser-free fakes, which this GL spike has no test harness for anyway
 * (see the plan's "no automated tests" non-goal).
 */

export interface GLTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
}

export interface GLTextureCache {
  get(gl: WebGL2RenderingContext, drawable: unknown): GLTexture | null;
}

export function createGLTextureCache(): GLTextureCache {
  const cache = new WeakMap<ImageBitmap, GLTexture>();

  function get(gl: WebGL2RenderingContext, drawable: unknown): GLTexture | null {
    if (typeof ImageBitmap === 'undefined' || !(drawable instanceof ImageBitmap)) return null;
    const cached = cache.get(drawable);
    if (cached) return cached;

    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawable);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const entry: GLTexture = { texture, width: drawable.width, height: drawable.height };
    cache.set(drawable, entry);
    return entry;
  }

  return { get };
}
