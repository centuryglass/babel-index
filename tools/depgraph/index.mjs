#!/usr/bin/env node
/**
 * The dependency atlas generator.
 *
 *   npm run generate:depgraph
 *   npm run generate:depgraph -- --out depgraph.html [--root .] [--fragment]
 *
 * Writes one self-contained page holding two force-directed graphs: the
 * installed npm tree, and the repo's own module imports. Both are measured -
 * see scan-npm.mjs and scan-internal.mjs for what that costs and buys.
 *
 * The page is a build product, not a checked-in asset. It is one file with the
 * data inlined precisely so it can be opened from disk, mailed, or published
 * without a server, which is the only reason a generator is worth having over
 * a one-off script.
 *
 * page/page.html is the body FRAGMENT, not a document, because a publishing
 * host that supplies its own <head> would otherwise get a second one nested
 * inside its body. --fragment emits it as-is for that case; the default wraps
 * it in the minimal skeleton a file:// open needs.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adjacency, bfsDepth, reachable, cycles } from './graph.mjs';
import { scanNpm } from './scan-npm.mjs';
import { scanInternal } from './scan-internal.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = parseArgs(process.argv.slice(2));
const root = resolve(process.cwd(), argv.root ?? join(here, '..', '..'));
const out = resolve(process.cwd(), argv.out ?? 'depgraph.html');

if (!existsSync(join(root, 'package.json'))) {
  console.error(`no package.json in ${root}`);
  process.exit(1);
}

/* ---------- the npm side ---------- */

let npmScan;
try {
  npmScan = scanNpm(root);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const npmAdj = adjacency(npmScan.nodes.length, npmScan.edges);
// Runtime reachability needs its own adjacency rather than a filtered walk: a
// package is "dev only" when NO runtime path reaches it, which is a question
// about the whole graph, not about the edge it happened to arrive on.
const runtimeAdj = adjacency(
  npmScan.nodes.length,
  npmScan.edges.filter((e) => e.kind !== 'dev'),
);
const depth = bfsDepth(npmAdj.out, 0);
const runtime = bfsDepth(runtimeAdj.out, 0);

// Which declared dependencies drag each package in. A package with several
// owners is the interesting case, not an error - it is a shared transitive.
const declared = npmScan.edges.filter((e) => e.from === 0);
const owners = new Map();
for (const edge of declared) {
  const name = npmScan.nodes[edge.to].name;
  for (const index of reachable(npmAdj.out, edge.to)) {
    if (!owners.has(index)) owners.set(index, []);
    owners.get(index).push(name);
  }
}

const KIND = { prod: 0, dev: 1, optional: 2 };
const npm = {
  nodes: npmScan.nodes.map((node, i) => ({
    n: node.name,
    v: node.root ? '' : node.version,
    d: depth.get(i) ?? -1,
    b: node.bytes,
    fi: npmAdj.inn[i].length,
    fo: npmAdj.out[i].length,
    p: runtime.has(i) ? 1 : 0,
    r: node.root ? 1 : 0,
    o: owners.get(i) ?? [],
    path: node.path,
  })),
  edges: npmScan.edges.map((e) => [e.from, e.to, KIND[e.kind]]),
};

/* ---------- the repo side ---------- */

const internalScan = await scanInternal(root);
const internalEdges = internalScan.edges.filter((e) => e.kind === 'internal');
const internalAdj = adjacency(internalScan.nodes.length, internalEdges);

const internal = {
  nodes: internalScan.nodes.map((node, i) => ({
    n: node.file,
    loc: node.lines,
    b: node.bytes,
    fi: internalAdj.inn[i].length,
    fo: internalAdj.out[i].length,
    t: node.test ? 1 : 0,
    pkg: node.pkg,
  })),
  edges: internalEdges.map((e) => [e.from, e.to]),
  ext: internalScan.edges
    .filter((e) => e.kind !== 'internal')
    .map((e) => [e.from, e.spec, e.kind]),
};

/* ---------- report, then write ---------- */

const npmCycles = cycles(npmScan.nodes.length, npmAdj.out);
const internalCycles = cycles(internalScan.nodes.length, internalAdj.out);
const totalBytes = npmScan.nodes.reduce((sum, n) => sum + n.bytes, 0);
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

console.log(`npm       ${npm.nodes.length - 1} packages, ${npm.edges.length} edges, ${mb(totalBytes)}`);
console.log(`repo      ${internal.nodes.length} files, ${internal.edges.length} imports`);
for (const [label, found] of [['npm', npmCycles], ['repo', internalCycles]]) {
  if (!found.length) continue;
  console.warn(`${label} has ${found.length} cycle(s):`);
  const name = (i) => (label === 'npm' ? npm.nodes[i].n : internal.nodes[i].n);
  for (const component of found) console.warn(`  ${component.map(name).join(' -> ')}`);
}
// An unresolved relative import is a real broken link, not scanner noise.
for (const { file, spec } of internalScan.unresolved) {
  console.warn(`unresolved import: ${file} -> ${spec}`);
}

const payload = {
  npm,
  internal,
  stamp: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
};
const template = readFileSync(join(here, 'page', 'page.html'), 'utf8');
const client = readFileSync(join(here, 'page', 'atlas.js'), 'utf8');
const close = '</' + 'script>';
const body = [
  template,
  `<script>\nconst DATA = ${JSON.stringify(payload)};\n${close}`,
  `<script>\n${client}\n${close}`,
].join('\n');
writeFileSync(out, 'fragment' in argv ? body : wrap(body));

console.log(`wrote     ${out}`);

/** The minimal document a fragment needs to open straight from disk. */
function wrap(body) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = args[++i];
  }
  return out;
}
