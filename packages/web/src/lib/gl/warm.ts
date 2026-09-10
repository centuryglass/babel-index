/**
 * Uploads every tile a rearrangement is about to need to the GPU, ahead of
 * the flight, rather than lazily on first draw during it.
 *
 * `useRearrangement.ts`'s `prepareRearrangement` already fetches and decodes
 * these ids before the camera moves - but it has no concept of a GPU, so
 * nothing uploads the resulting `ImageBitmap`s to a texture ahead of time.
 * Without this, the spike's own measurement showed the flight phase getting
 * SLOWER under WebGL (each newly-decoded bitmap paying its first
 * `texImage2D` upload during the one phase that's supposed to feel
 * instant) even though the slide phase it precedes got dramatically faster.
 *
 * Polls independently of `prepareRearrangement`'s own readiness loop rather
 * than sharing it - `cache.get(id, level)` is cheap to call repeatedly (it
 * returns immediately once ready, and starts/continues the load exactly as
 * `cache.request` does otherwise), so a second small poll loop here is far
 * simpler than threading a second consumer through the first one's promise.
 * Bounded by the same timeout budget so a slow network can't leave this
 * polling forever after `prepareRearrangement` itself has given up.
 */
import type { GLContext } from './context.ts';
import type { GLTextureCache } from './textureCache.ts';
import type { TileCache } from '../tiles.ts';

export function warmGLTextures(
  ids: ReadonlySet<number>,
  level: number,
  cache: TileCache,
  gl: GLContext,
  textures: GLTextureCache,
  timeoutMs: number
): void {
  const pending = new Set(ids);
  if (pending.size === 0) return;
  const deadline = performance.now() + timeoutMs;

  const step = () => {
    for (const id of pending) {
      const hit = cache.get(id, level);
      if (hit && hit.level === level) {
        textures.get(gl, hit.img);
        pending.delete(id);
      }
    }
    if (pending.size === 0 || performance.now() >= deadline) return;
    requestAnimationFrame(step);
  };
  step();
}
