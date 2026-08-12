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
 * The routes live in app.mjs; this file is the CLI around them. Search is
 * stubbed (see /api/search there). Wiring a real CLIP text tower in later
 * changes one endpoint and nothing else, because ranking happens on the client
 * against precomputed embeddings.
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { scanDirectory } from './scan.mjs';
import { createApp } from './app.mjs';

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
const manifest = await scanDirectory(imagesDir, { base: argv.base });
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

const app = createApp({
  manifest,
  imagesDir,
  rescan: () => scanDirectory(imagesDir, { base: argv.base }),
  bundleJs: bundle.outputFiles[0].text,
  readIndexHtml: () => readFile(join(webDir, 'index.html'), 'utf8'),
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
