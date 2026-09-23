/**
 * Where transformers.js keeps the downloaded CLIP weights: `.clip_model_cache/`
 * at the repo root, gitignored.
 *
 * Its own default is inside `node_modules`, which `npm ci` deletes, so every
 * dependency change would re-download a few hundred MB of model. Every caller
 * that loads a CLIP tower (`app.ts`, `tools/embed`) points the library here.
 */
import { fileURLToPath } from 'node:url';

/** Absolute, so the cache does not move with the process's working directory. */
export const CLIP_CACHE_DIR = fileURLToPath(new URL('../../.clip_model_cache/', import.meta.url));

/**
 * Point a dynamically imported transformers.js at `CLIP_CACHE_DIR`. Call it
 * before the first `from_pretrained`, which reads `env.cacheDir` at load.
 *
 * @returns the same module, so it can wrap the `import()`
 */
export function withClipCache<T extends { env: { cacheDir: string | null } }>(transformers: T): T {
  transformers.env.cacheDir = CLIP_CACHE_DIR;
  return transformers;
}
