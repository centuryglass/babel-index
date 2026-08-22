/**
 * The installed npm graph, read off disk rather than out of package.json.
 *
 * Declared ranges say what was asked for; node_modules says what arrived. Only
 * the second one can be drawn, because only the second one knows that two
 * dependencies resolved to two different copies of the same package.
 *
 * Two decisions worth keeping:
 *
 *   - Resolution follows Node's own algorithm - climb the node_modules chain
 *     from the importing package upward. A nested copy is therefore attributed
 *     to the nested copy, which is the whole reason a duplicate shows up as two
 *     nodes instead of one.
 *   - A package's size is its OWN files, with nested node_modules excluded, so
 *     the sizes add up to the tree's real weight instead of counting a shared
 *     dependency once per dependent.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Every installed package directory under `nodeModules`, nested ones included. */
function packageDirs(nodeModules) {
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const path = join(dir, name);
      if (!statSync(path).isDirectory()) continue;
      // A scope directory is not itself a package; its children are.
      if (name.startsWith('@')) {
        for (const scoped of readdirSync(path)) {
          const inner = join(path, scoped);
          if (!statSync(inner).isDirectory()) continue;
          found.push(inner);
          walk(join(inner, 'node_modules'));
        }
      } else {
        found.push(path);
        walk(join(path, 'node_modules'));
      }
    }
  };
  walk(nodeModules);
  return found;
}

/** A package's own unpacked size, excluding whatever it nests inside itself. */
function ownBytes(dir) {
  let total = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) total += statSync(child).size;
    }
  };
  try {
    walk(dir);
  } catch {
    // A broken symlink or a package removed mid-scan is worth nothing, not a crash.
  }
  return total;
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Scan the install under `root` and return `{ nodes, edges }`, node 0 being the
 * root project itself. Edge `kind` is `prod`, `dev` or `optional`; only the
 * root's own edges can be `dev`, because a dependency's devDependencies are
 * never installed.
 */
export function scanNpm(root) {
  const nodeModules = join(root, 'node_modules');
  if (!existsSync(nodeModules)) throw new Error(`no node_modules in ${root} - run npm install first`);

  const installed = new Map();
  for (const dir of packageDirs(nodeModules)) {
    const manifest = readJson(join(dir, 'package.json'));
    if (!manifest?.name) continue;
    installed.set(dir, {
      dir,
      name: manifest.name,
      version: manifest.version ?? '0.0.0',
      deps: Object.keys(manifest.dependencies ?? {}),
      optional: Object.keys(manifest.optionalDependencies ?? {}),
    });
  }

  // Node's resolution: try each ancestor's node_modules, nearest first.
  const resolveFrom = (fromDir, name) => {
    let dir = fromDir;
    for (;;) {
      const candidate = join(dir, 'node_modules', name);
      if (installed.has(candidate)) return candidate;
      if (dir === root) return null;
      const parent = dir.slice(0, dir.lastIndexOf(sep));
      if (!parent || parent.length < root.length) return null;
      dir = parent;
    }
  };

  const manifest = readJson(join(root, 'package.json')) ?? {};
  const nodes = [{
    name: manifest.name ?? '(root)',
    version: manifest.version ?? '',
    path: '',
    bytes: 0,
    root: true,
  }];
  const indexOf = new Map();
  for (const pkg of installed.values()) {
    indexOf.set(pkg.dir, nodes.length);
    nodes.push({
      name: pkg.name,
      version: pkg.version,
      path: relative(nodeModules, pkg.dir).split(sep).join('/'),
      bytes: ownBytes(pkg.dir),
      root: false,
    });
  }

  const edges = [];
  const addEdge = (from, fromDir, name, kind) => {
    const target = resolveFrom(fromDir, name);
    // An optional dependency that did not install is not a missing edge; it is
    // a dependency that correctly is not there.
    if (target) edges.push({ from, to: indexOf.get(target), kind });
  };

  for (const name of Object.keys(manifest.dependencies ?? {})) addEdge(0, root, name, 'prod');
  for (const name of Object.keys(manifest.devDependencies ?? {})) addEdge(0, root, name, 'dev');
  for (const pkg of installed.values()) {
    const from = indexOf.get(pkg.dir);
    for (const name of pkg.deps) addEdge(from, pkg.dir, name, 'prod');
    for (const name of pkg.optional) addEdge(from, pkg.dir, name, 'optional');
  }

  return { nodes, edges };
}
