import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const webDir = dirname(fileURLToPath(import.meta.url));

/**
 * The client is bundled at server start, so a broken import or a typo in the
 * JSX is only discovered by running `npm run demo` and reading the stack. This
 * is the cheapest possible check that the thing compiles at all - it is not a
 * substitute for the browser test the plan calls for, but it catches the whole
 * class of "did not even build".
 */
test('the client bundles', async () => {
  const result = await build({
    entryPoints: [join(webDir, 'src/main.tsx')],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    target: ['es2022'],
    write: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    // Kept in sync with packages/server/index.ts's build call - both bundle
    // main.tsx, and the SVG-as-text loader is why (see SearchIcon.tsx).
    loader: { '.svg': 'text' },
  });

  assert.deepEqual(result.errors, []);
  const js = result.outputFiles[0].text;
  assert.ok(js.length > 1000, 'suspiciously small bundle');
  // The modules the map cannot work without, all reached through main.tsx.
  for (const marker of ['createLayout', 'createTileCache', 'useMapCamera', 'screenToWorld'])
    assert.ok(js.includes(marker), `${marker} is missing from the bundle`);
});
