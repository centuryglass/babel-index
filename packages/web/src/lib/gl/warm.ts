/**
 * Uploads every tile a rearrangement is about to need to the GPU, ahead of
 * the flight, rather than lazily on first draw during it.
 *
 * `useRearrangement.ts`'s `prepareRearrangement` already fetches and decodes
 * these ids before the camera moves, but it has no concept of a GPU.
 * Without this, each newly-decoded bitmap pays its first `texImage2D`
 * upload on its first draw - which for a rearrangement lands in the flight,
 * the one phase that is supposed to feel instant.
 *
 * Polls on its own loop, separate from `prepareRearrangement`'s readiness
 * loop; `cache.get(id, level)` is cheap to call repeatedly, answering once
 * ready and keeping the load going otherwise. Stops when every id has uploaded or when `timeoutMs` passes -
 * the same `config.slide.prepareTimeoutMs` budget
 * `prepareRearrangement` uses - so a slow network cannot leave this
 * polling after the prepare window itself has closed.
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
      // A coarser substitute is not what the slide will draw at `level`;
      // keep polling until the requested level itself is resident.
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
