#!/usr/bin/env node
/**
 * The offline demo server.
 *
 *   npm run demo -- --images /path/to/rooms [--base base.png] [--port 5173]
 *
 * Point it at a directory of images and it serves a browsable library. No
 * database, no bucket, no upload step - the directory *is* the corpus. That is
 * the whole point of offline mode: get a working local demo before hosting is
 * worth thinking about.
 *
 * Search is stubbed here (see /api/search). Wiring a real CLIP text tower in
 * later changes one endpoint and nothing else, because ranking happens on the
 * client against precomputed embeddings.
 */
import express from 'express';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { scanDirectory } from './scan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../web');

const argv = parseArgs(process.argv.slice(2));
// Defaults to the sample corpus committed to the repo, so `npm run demo` works
// with no arguments and no external files.
const imagesDir = resolve(process.cwd(), argv.images ?? 'assets/corpus-sample');
if (!existsSync(imagesDir)) {
  console.error(`no such directory: ${imagesDir}`);
  process.exit(1);
}
const port = Number(argv.port ?? 5173);

console.log(`scanning ${imagesDir} ...`);
let manifest = await scanDirectory(imagesDir, { base: argv.base });
console.log(`  ${manifest.count} rooms, generic room: ${manifest.generic.file}`);

console.log('bundling client ...');
const bundle = await build({
  entryPoints: [join(webDir, 'src/main.jsx')],
  bundle: true,
  format: 'esm',
  jsx: 'automatic',
  target: ['es2022'],
  minify: false,
  sourcemap: 'inline',
  write: false,
  define: { 'process.env.NODE_ENV': '"development"' },
});
const bundleJs = bundle.outputFiles[0].text;

const app = express();

app.get('/api/manifest', (_req, res) => res.json(manifest));

app.post('/api/rescan', async (_req, res) => {
  manifest = await scanDirectory(imagesDir, { base: argv.base });
  res.json({ count: manifest.count });
});

/**
 * Offline search.
 *
 * There is no CLIP here. This returns a deterministic pseudo-ranking derived
 * from the query string so the *mechanic* - type a term, watch the library
 * rearrange around the centre - can be exercised without a model. It is
 * labelled as a stub in the response so the UI can say so rather than implying
 * the results mean something.
 */
app.get('/api/search', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ stub: true, query: q, order: null });

  let h = 2166136261;
  for (let i = 0; i < q.length; i++) h = Math.imul(h ^ q.charCodeAt(i), 16777619);

  const scored = manifest.rooms.map((room) => {
    let s = Math.imul(room.id + 1, h >>> 0) >>> 0;
    s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) >>> 0;
    return { id: room.id, score: ((s ^ (s >>> 13)) >>> 0) / 4294967296 };
  });
  scored.sort((a, b) => b.score - a.score);

  res.json({ stub: true, query: q, order: scored.map((s) => s.id) });
});

app.use('/images', express.static(imagesDir, { maxAge: '1h', immutable: true }));

// The tab icon would otherwise be a 404 on every load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.get('/bundle.js', (_req, res) => {
  res.type('application/javascript').send(bundleJs);
});

app.get('/', async (_req, res) => {
  res.type('html').send(await readFile(join(webDir, 'index.html'), 'utf8'));
});

app.listen(port, () => {
  console.log(`\n  the library is open at http://localhost:${port}\n`);
});

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
