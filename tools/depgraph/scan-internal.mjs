/**
 * The repo's own import graph: every ESM import in the source tree, with the
 * relative ones resolved on disk so an edge is a file that really exists.
 *
 * Written as a scan rather than a parse because the alternative is a parser
 * dependency, and the dependency list is deliberately short. What that costs is
 * one real hazard, guarded below and asserted in the tests: a regex looking for
 * `from '...'` will happily match a quoted string several lines inside an
 * `export const X = { ... }`, because an object literal carries no semicolon
 * until it ends. Barring `=` from the middle of the match is what stops a
 * config file's own prose being reported as a dependency.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const SOURCE = /\.(mjs|jsx?)$/;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build']);

/** `import x from 'y'` and `export { x } from 'y'`, including multi-line forms. */
const FROM = /^[ \t]*(?:import|export)\b[^;=]*?\bfrom\s*['"]([^'"]+)['"]/gm;
/** Side-effect imports: `import 'y'`. */
const BARE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
/** `import('y')`, which the demo server uses and a scan of static forms misses. */
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every source file under `root`, repo-relative and sorted, skipping SKIP dirs. */
export async function sourceFiles(root) {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (SOURCE.test(entry.name)) found.push(relative(root, path).split(sep).join('/'));
    }
  };
  await walk(root);
  return found.sort();
}

/**
 * Resolve a relative specifier the way the browser bundler and Node both do:
 * exact path first, then the extensions this repo uses, then a directory index.
 * Returns a repo-relative path, or null for something that is not on disk.
 */
function resolveRelative(root, fromFile, spec) {
  const base = resolve(dirname(join(root, fromFile)), spec);
  const candidates = [
    base,
    `${base}.js`, `${base}.mjs`, `${base}.jsx`,
    join(base, 'index.mjs'), join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(root, candidate).split(sep).join('/');
    }
  }
  return null;
}

/** The package a bare specifier belongs to: `@scope/name/deep` -> `@scope/name`. */
export function packageOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Scan `root` and return `{ nodes, edges, unresolved }`. Edges carry a `kind`:
 * `internal` points at another indexed file, `builtin` at a `node:` module,
 * `npm` at a package. Only internal edges have a numeric `to`.
 */
export async function scanInternal(root) {
  const files = await sourceFiles(root);
  const index = new Map(files.map((file, i) => [file, i]));
  const nodes = [];
  const edges = [];
  const unresolved = [];

  for (const [i, file] of files.entries()) {
    const source = readFileSync(join(root, file), 'utf8');
    nodes.push({
      file,
      lines: source.split('\n').length,
      bytes: Buffer.byteLength(source),
      test: /\.(test|e2e)\.mjs$/.test(file),
      pkg: file.split('/').slice(0, 2).join('/'),
    });

    // One file may name the same specifier twice (a type-only re-import, a
    // dynamic form beside the static one); the graph wants one edge.
    const seen = new Set();
    const matches = [...source.matchAll(FROM), ...source.matchAll(BARE), ...source.matchAll(DYNAMIC)];
    for (const [, spec] of matches) {
      if (seen.has(spec)) continue;
      seen.add(spec);
      if (spec.startsWith('.')) {
        const target = resolveRelative(root, file, spec);
        if (target && index.has(target)) edges.push({ from: i, to: index.get(target), kind: 'internal' });
        else unresolved.push({ file, spec });
      } else if (spec.startsWith('node:')) {
        edges.push({ from: i, spec, kind: 'builtin' });
      } else {
        edges.push({ from: i, spec: packageOf(spec), kind: 'npm' });
      }
    }
  }

  return { nodes, edges, unresolved };
}
