import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInternal, packageOf } from './scan-internal.mjs';

/** Build a throwaway source tree; fixtures are synthesised, never committed. */
async function tree(files) {
  const root = await mkdtemp(join(tmpdir(), 'depgraph-'));
  for (const [path, source] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, source);
  }
  return root;
}
const edgesFrom = (scan, file) => {
  const i = scan.nodes.findIndex((n) => n.file === file);
  return scan.edges.filter((e) => e.from === i);
};
const targets = (scan, file) =>
  edgesFrom(scan, file).map((e) => (e.kind === 'internal' ? scan.nodes[e.to].file : e.spec)).sort();

test('resolves relative imports to files that exist, by extension', async () => {
  const root = await tree({
    'a.js': "import { b } from './b.js';\nimport { c } from './sub/c';\n",
    'b.js': 'export const b = 1;\n',
    'sub/c.mjs': 'export const c = 2;\n',
  });
  try {
    const scan = await scanInternal(root);
    assert.deepEqual(targets(scan, 'a.js'), ['b.js', 'sub/c.mjs']);
    assert.deepEqual(scan.unresolved, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a multi-line import list is one edge, not none', async () => {
  // The `from` sits on its own line here, so anything anchored to a single
  // line misses it entirely - which is how it was first written.
  const root = await tree({
    'a.js': "import {\n  one,\n  two,\n} from './b.js';\n",
    'b.js': 'export const one = 1, two = 2;\n',
  });
  try {
    assert.deepEqual(targets(await scanInternal(root), 'a.js'), ['b.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a string containing "from" inside an export declaration is not an edge', async () => {
  // The regression this scanner exists to avoid, in two shapes. An object
  // literal carries no semicolon until it ends, so a match allowed to run past
  // the `=` reaches the prose inside and reads `from "camera.js"` as a real
  // re-export. And a match that does not REQUIRE `from` takes the first quoted
  // string after any `export` - which the `=` bar alone does not stop, because
  // an exported function returning a string has no `=` in it at all.
  const root = await tree({
    'config.mjs': [
      'export const NOTES = {',
      "  camera: 'zoom is read from \"camera.js\" at load',",
      "  tile: 'the base tile',",
      '};',
      '',
      "export const LABEL = 'wallpaper';",
      '',
      'export function describe() {',
      "  return 'a room';",
      '}',
      '',
      "export { NOTES as N } from './real.js';",
    ].join('\n'),
    'real.js': 'export const NOTES = {};\n',
  });
  try {
    const scan = await scanInternal(root);
    assert.deepEqual(targets(scan, 'config.mjs'), ['real.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('separates built-ins, npm packages and dynamic imports', async () => {
  const root = await tree({
    'a.mjs': [
      "import { join } from 'node:path';",
      "import express from 'express';",
      "import { x } from '@scope/pkg/deep/path.js';",
      'const esbuild = await imp' + "ort('esbuild');",
      "import './side-effect.js';",
    ].join('\n'),
    'side-effect.js': 'globalThis.x = 1;\n',
  });
  try {
    const scan = await scanInternal(root);
    const byKind = (kind) => edgesFrom(scan, 'a.mjs').filter((e) => e.kind === kind).map((e) => e.spec ?? '').sort();
    assert.deepEqual(byKind('builtin'), ['node:path']);
    assert.deepEqual(byKind('npm'), ['@scope/pkg', 'esbuild', 'express']);
    assert.deepEqual(targets(scan, 'a.mjs').filter((t) => t.endsWith('.js')), ['side-effect.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the same specifier twice is one edge', async () => {
  const root = await tree({
    // Split so the scanner does not read this file's own fixture as a real
    // dynamic import - the documented cost of scanning text rather than parsing.
    'a.js': "import { one } from './b.js';\nconst lazy = () => imp" + "ort('./b.js');\n",
    'b.js': 'export const one = 1;\n',
  });
  try {
    assert.equal(edgesFrom(await scanInternal(root), 'a.js').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a relative import of a file that is not there is reported, not dropped', async () => {
  const root = await tree({ 'a.js': "import { gone } from './missing.js';\n" });
  try {
    const scan = await scanInternal(root);
    assert.deepEqual(scan.unresolved, [{ file: 'a.js', spec: './missing.js' }]);
    assert.deepEqual(scan.edges, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('node_modules is not part of the repo graph', async () => {
  const root = await tree({
    'a.js': "import x from 'dep';\n",
    'node_modules/dep/index.js': 'export default 1;\n',
  });
  try {
    const scan = await scanInternal(root);
    assert.deepEqual(scan.nodes.map((n) => n.file), ['a.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('marks test files, and counts lines', async () => {
  const root = await tree({
    'a.js': 'const one = 1;\nconst two = 2;\n',
    'a.test.mjs': "import './a.js';\n",
    'smoke.e2e.mjs': "import './a.js';\n",
  });
  try {
    const scan = await scanInternal(root);
    const kind = Object.fromEntries(scan.nodes.map((n) => [n.file, n.test]));
    assert.deepEqual(kind, { 'a.js': false, 'a.test.mjs': true, 'smoke.e2e.mjs': true });
    assert.equal(scan.nodes.find((n) => n.file === 'a.js').lines, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packageOf keeps the scope and drops the deep path', () => {
  assert.equal(packageOf('express'), 'express');
  assert.equal(packageOf('react-dom/client'), 'react-dom');
  assert.equal(packageOf('@img/sharp-wasm32'), '@img/sharp-wasm32');
  assert.equal(packageOf('@scope/pkg/deep/file.js'), '@scope/pkg');
});
