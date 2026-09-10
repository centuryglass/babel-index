/**
 * Wraps `tiles.ts`'s `TileHit.img` in a GL texture, without touching
 * `tiles.ts` itself. `tiles.ts` never mutates a `Drawable` in place - a new
 * decode gets a new object - so the `img` object's own identity is already a
 * stable, zero-coordination cache key.
 *
 * Eviction mirrors `tiles.ts`'s own frame-aware LRU rather than reusing it:
 * `beginFrame()` bumps a monotonic counter, `get()` stamps whatever it
 * returns with the current frame, and anything not touched in the current or
 * previous frame is eligible for eviction once the cache is over budget -
 * same "current and previous frame are always protected" rule `tiles.ts`
 * itself follows, so a tile drawn last frame surviving into this one is
 * never evicted out from under a render still using it. This needs its own
 * budget independent of `tiles.ts`'s pyramid-level budgets (`pyramid.ts`) -
 * this cache is flat (one map, not one per level), and GPU memory pressure
 * is a different resource than the decoded-bitmap budget `tiles.ts` already
 * manages.
 *
 * A `Map` (strong references), not a `WeakMap`: `tiles.ts` could otherwise
 * drop its own last reference to a bitmap this cache still holds a texture
 * for, with no way to know - eviction here has to be a decision this cache
 * makes deliberately, not something GC decides for it.
 *
 * Only handles a real `ImageBitmap` - the browser's actual `Drawable`. The
 * `LoadableImage` half of that union exists for `render.test.ts`'s
 * browser-free fakes, which this GL renderer has no equivalent for (its own
 * decision logic is tested against a recording `GLContext` fake instead -
 * see `glRenderer.test.ts`).
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
  /** Drops every texture without freeing GPU state - for a lost context, where every GL object is already invalid. See `dispose()` for the normal teardown path. */
  reset(): void;
  /** Frees every resident texture via `gl.deleteTexture`, then drops them - for a context still alive (unlike `reset()`, which assumes it is not). */
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

  function reset(): void {
    cache.clear();
  }

  function dispose(gl: WebGL2RenderingContext): void {
    for (const entry of cache.values()) gl.deleteTexture(entry.texture);
    cache.clear();
  }

  return { beginFrame, get, reset, dispose };
}
