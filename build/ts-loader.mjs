/**
 * Node module hook that lets `node` run `.ts`/`.tsx` sources directly - no
 * separate compile step, no output directory to keep in sync with the tree
 * `AGENTS.md`'s Layout section describes.
 *
 * `esbuild` already does exactly this transform for the browser bundle
 * (`packages/server/index.mjs` bundles the client in-process at startup), so
 * this reuses the same dependency and the same idea for everything Node runs
 * directly: strip types, leave the module graph and every other semantic
 * (top-level await, dynamic `import()`, ESM/CJS interop) alone. Output is
 * never cached to disk - `load` is called once per process per module by the
 * ESM loader itself, so re-transforming on every run costs nothing that
 * matters next to network/fs latency elsewhere in this app.
 *
 * Registered via `build/register.mjs`; see `npm run` scripts in package.json
 * for where `--import` wires it in.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const TS_FILE = /\.tsx?$/;

/** @type {import('node:module').LoadHook} */
export async function load(url, context, nextLoad) {
  if (!TS_FILE.test(url)) return nextLoad(url, context);

  const path = fileURLToPath(url);
  const source = await readFile(path, 'utf8');
  const { code } = await transform(source, {
    loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
    format: 'esm',
    sourcefile: path,
    sourcemap: 'inline',
    target: 'esnext',
  });

  return { format: 'module', source: code, shortCircuit: true };
}
