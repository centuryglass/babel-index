/**
 * Wraps `tiles.ts`'s `TileHit.img` in a GL texture, without touching
 * `tiles.ts` itself. `tiles.ts` never mutates a `Drawable` in place - a new
 * decode gets a new object - so the `img` object's own identity is already a
 * stable, zero-coordination cache key.
 *
 * Eviction mirrors `tiles.ts`'s frame-aware LRU rather than hooking into
 * it: `beginFrame()` bumps a monotonic counter, `get()` stamps whatever it
 * returns with the current frame, and over budget the cache drops anything
 * not stamped in the current or previous frame - a tile drawn last frame is
 * never evicted out from under a render still using it. The cache is a
 * strong `Map`, and its budget is separate from `pyramid.ts`'s
 * decoded-byte budgets; AGENTS.md's "The texture cache has its own eviction
 * budget" bullet carries that reasoning.
 *
 * Only uploads real `ImageBitmap`s - the `LoadableImage` half of
 * `tiles.ts`'s `Drawable` exists for browser-free fakes, and under Node
 * `ImageBitmap` is undefined, so every `get()` returns null here.
 * `glRenderer.test.ts` accordingly injects a fake cache, and tests the
 * renderer's decisions against a recording `GLContext` fake.
 */
import type { GLContext } from './context.ts';

export interface GLTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
}

export interface GLTextureCache {
  /** Call once per frame, before any `get()` - bumps the eviction clock. */
  beginFrame(): void;
  get(gl: GLContext, drawable: unknown): GLTexture | null;
  /** Frees every resident texture via `gl.deleteTexture`, then drops them. */
  dispose(gl: WebGL2RenderingContext): void;
}

interface Entry extends GLTexture {
  lastUsed: number;
}

/** Same order of magnitude as `pyramid.ts`'s per-level decoded-byte budgets, but counting textures rather than bytes - GPU memory pressure isn't tracked precisely here, just bounded. */
const DEFAULT_BUDGET = 512;

let warnedTextureSize = false;

export function createGLTextureCache(budget = DEFAULT_BUDGET): GLTextureCache {
  const cache = new Map<ImageBitmap, Entry>();
  let frame = 0;

  function beginFrame(): void {
    frame++;
  }

  function evictIfOverBudget(gl: WebGL2RenderingContext): void {
    if (cache.size <= budget) return;
    for (const [bitmap, entry] of cache) {
      if (cache.size <= budget) break;
      if (entry.lastUsed >= frame - 1) continue; // this or last frame - protected
      gl.deleteTexture(entry.texture);
      cache.delete(bitmap);
    }
  }

  function get(glCtx: GLContext, drawable: unknown): GLTexture | null {
    if (typeof ImageBitmap === 'undefined' || !(drawable instanceof ImageBitmap)) return null;
    const cached = cache.get(drawable);
    if (cached) {
      cached.lastUsed = frame;
      return cached;
    }

    if (drawable.width > glCtx.maxTextureSize || drawable.height > glCtx.maxTextureSize) {
      if (!warnedTextureSize) {
        warnedTextureSize = true;
        console.warn(
          `[webgl] a ${drawable.width}x${drawable.height} image exceeds this device's ` +
          `MAX_TEXTURE_SIZE (${glCtx.maxTextureSize}) - drawing the blank fallback instead ` +
          `of uploading it. Corpus assets past this size need per-file art at a coarser ` +
          `pyramid level on this device, not a sheet this large.`
        );
      }
      return null;
    }

    const { gl } = glCtx;
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawable);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const entry: Entry = { texture, width: drawable.width, height: drawable.height, lastUsed: frame };
    cache.set(drawable, entry);
    evictIfOverBudget(gl);
    return entry;
  }

  function dispose(gl: WebGL2RenderingContext): void {
    for (const entry of cache.values()) gl.deleteTexture(entry.texture);
    cache.clear();
  }

  return { beginFrame, get, dispose };
}
