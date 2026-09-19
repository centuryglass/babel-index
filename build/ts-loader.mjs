/**
 * Node module hook that lets `node` run `.ts`/`.tsx` sources directly - no
 * separate compile step, no output directory to keep in sync with the tree
 * `AGENTS.md`'s Layout section describes.
 *
 * esbuild strips the types - the same dependency `packages/server/index.ts`
 * bundles the client with - and leaves the module graph and every other
 * semantic (top-level await, dynamic `import()`, ESM/CJS interop) alone.
 * Output is never cached to disk: `load` runs once per process per module, so
 * a module is re-transformed at most once per run.
 *
 * Registered via `build/register.mjs`; the `npm run` scripts in package.json
 * carry the `--import` wiring.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const TS_FILE = /\.tsx?$/;
// esbuild's `loader: 'text'` extensions (packages/server/index.ts) that a .ts
// module under test may import - mirrored here so `node --test` sees the same
// raw-string shape the browser bundle gets, instead of Node's ESM loader
// rejecting the extension outright.
const TEXT_FILE = /\.(?:svg|vert|frag)$/;

/** @type {import('node:module').LoadHook} */
export async function load(url, context, nextLoad) {
  if (TEXT_FILE.test(url)) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(source)};`, shortCircuit: true };
  }
  if (!TS_FILE.test(url)) return nextLoad(url, context);

  const path = fileURLToPath(url);
  const source = await readFile(path, 'utf8');
  const { code } = await transform(source, {
    loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
    format: 'esm',
    sourcefile: path,
    sourcemap: 'inline',
    target: 'esnext',
    // Must match packages/server/index.ts's client bundle and jsconfig.json's
    // "jsx": "react-jsx" - the classic transform's implicit `React.createElement`
    // calls would otherwise need `React` imported into scope everywhere JSX is
    // written, which nothing in this tree does.
    jsx: 'automatic',
  });

  return { format: 'module', source: code, shortCircuit: true };
}
