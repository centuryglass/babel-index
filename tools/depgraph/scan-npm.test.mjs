import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanNpm } from './scan-npm.mjs';

/**
 * Build a throwaway install. Keys are paths under the root; a manifest value is
 * written as package.json, a string as a file of that content.
 */
async function install(files) {
  const root = await mkdtemp(join(tmpdir(), 'depgraph-npm-'));
  for (const [path, value] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}
const pkg = (name, version, extra = {}) => ({ name, version, ...extra });
const find = (scan, name, path) =>
  scan.nodes.find((n) => n.name === name && (path === undefined || n.path === path));
const edgeNames = (scan) =>
  scan.edges.map((e) => `${scan.nodes[e.from].name} -${e.kind}-> ${scan.nodes[e.to].name}`).sort();

test('reads the root manifest and its declared dependencies', async () => {
  const root = await install({
    'package.json': pkg('app', '1.0.0', { dependencies: { a: '^1' }, devDependencies: { b: '^1' } }),
    'node_modules/a/package.json': pkg('a', '1.2.3'),
    'node_modules/b/package.json': pkg('b', '2.0.0'),
  });
  try {
    const scan = scanNpm(root);
    assert.equal(scan.nodes[0].name, 'app');
    assert.equal(scan.nodes[0].root, true);
    assert.deepEqual(edgeNames(scan), ['app -dev-> b', 'app -prod-> a']);
    assert.equal(find(scan, 'a').version, '1.2.3');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a nested copy is its own node, and wins over the hoisted one', async () => {
  // The reason this scans disk rather than reading ranges: two dependents can
  // resolve the same name to two different installs, and a graph that collapses
  // them to one node is describing a tree that was never installed.
  const root = await install({
    'package.json': pkg('app', '1.0.0', { dependencies: { a: '^1', c: '^1' } }),
    'node_modules/a/package.json': pkg('a', '1.0.0', { dependencies: { shared: '^2' } }),
    'node_modules/a/node_modules/shared/package.json': pkg('shared', '2.0.0'),
    'node_modules/c/package.json': pkg('c', '1.0.0', { dependencies: { shared: '^1' } }),
    'node_modules/shared/package.json': pkg('shared', '1.0.0'),
  });
  try {
    const scan = scanNpm(root);
    const copies = scan.nodes.filter((n) => n.name === 'shared');
    assert.equal(copies.length, 2);
    assert.deepEqual(copies.map((n) => n.version).sort(), ['1.0.0', '2.0.0']);
    // a's edge must land on the nested 2.0.0, c's on the hoisted 1.0.0.
    const target = (from) => {
      const i = scan.nodes.findIndex((n) => n.name === from);
      const edge = scan.edges.find((e) => e.from === i);
      return scan.nodes[edge.to];
    };
    assert.equal(target('a').version, '2.0.0');
    assert.equal(target('a').path, 'a/node_modules/shared');
    assert.equal(target('c').version, '1.0.0');
    assert.equal(target('c').path, 'shared');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolution climbs past a package that does not nest its own copy', async () => {
  const root = await install({
    'package.json': pkg('app', '1.0.0', { dependencies: { a: '^1' } }),
    'node_modules/a/package.json': pkg('a', '1.0.0', { dependencies: { deep: '^1' } }),
    'node_modules/a/node_modules/mid/package.json': pkg('mid', '1.0.0'),
    'node_modules/deep/package.json': pkg('deep', '1.0.0'),
  });
  try {
    assert.ok(edgeNames(scanNpm(root)).includes('a -prod-> deep'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scoped packages are packages, and the scope directory is not', async () => {
  const root = await install({
    'package.json': pkg('app', '1.0.0', { dependencies: { '@img/sharp': '^1' } }),
    'node_modules/@img/sharp/package.json': pkg('@img/sharp', '0.3.0'),
  });
  try {
    const scan = scanNpm(root);
    assert.equal(scan.nodes.length, 2);
    assert.equal(find(scan, '@img/sharp').path, '@img/sharp');
    assert.deepEqual(edgeNames(scan), ['app -prod-> @img/sharp']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('size is a package\'s own files, excluding what it nests', async () => {
  // Otherwise a shared dependency is counted once per dependent and the total
  // is larger than the directory it was measured from.
  const root = await install({
    'package.json': pkg('app', '1.0.0', { dependencies: { a: '^1' } }),
    'node_modules/a/package.json': pkg('a', '1.0.0', { dependencies: { big: '^1' } }),
    'node_modules/a/index.js': 'x'.repeat(100),
    'node_modules/a/node_modules/big/package.json': pkg('big', '1.0.0'),
    'node_modules/a/node_modules/big/blob.bin': 'y'.repeat(5000),
  });
  try {
    const scan = scanNpm(root);
    const a = find(scan, 'a');
    const big = find(scan, 'big');
    assert.ok(big.bytes > 5000, `expected big > 5000, got ${big.bytes}`);
    assert.ok(a.bytes < 500, `a must not include its nested dependency, got ${a.bytes}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an optional dependency that did not install is simply not an edge', async () => {
  const root = await install({
    'package.json': pkg('app', '1.0.0', { dependencies: { a: '^1' } }),
    'node_modules/a/package.json': pkg('a', '1.0.0', {
      optionalDependencies: { 'a-linux-x64': '^1', 'a-win32-x64': '^1' },
    }),
    'node_modules/a-linux-x64/package.json': pkg('a-linux-x64', '1.0.0'),
  });
  try {
    const scan = scanNpm(root);
    assert.deepEqual(edgeNames(scan), ['a -optional-> a-linux-x64', 'app -prod-> a']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a directory with no package.json is not a package', async () => {
  const root = await install({
    'package.json': pkg('app', '1.0.0', {}),
    'node_modules/.cache/junk.txt': 'ignored',
    'node_modules/leftover/README.md': 'no manifest here',
  });
  try {
    assert.deepEqual(scanNpm(root).nodes.map((n) => n.name), ['app']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing node_modules is an error, not an empty graph', async () => {
  // An empty graph would render as a page saying the project has no
  // dependencies, which is a different and wrong answer.
  const root = await install({ 'package.json': pkg('app', '1.0.0', { dependencies: { a: '^1' } }) });
  try {
    assert.throws(() => scanNpm(root), /npm install/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a dependency cycle between packages does not hang the scan', async () => {
  const root = await install({
    'package.json': pkg('app', '1.0.0', { dependencies: { a: '^1' } }),
    'node_modules/a/package.json': pkg('a', '1.0.0', { dependencies: { b: '^1' } }),
    'node_modules/b/package.json': pkg('b', '1.0.0', { dependencies: { a: '^1' } }),
  });
  try {
    assert.deepEqual(edgeNames(scanNpm(root)), ['a -prod-> b', 'app -prod-> a', 'b -prod-> a']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
