#!/usr/bin/env node
/**
 * The offline demo server.
 *
 *   npm run demo -- --images /path/to/rooms [--base base.png] [--port 5173]
 *                    [--config config.json] [--base-dir assets]
 *
 * Point it at a directory of images and it serves a browsable library. No
 * database, no bucket, no upload step - the directory *is* the corpus. That is
 * the whole point of offline mode: get a working local demo before hosting is
 * worth thinking about.
 *
 * The routes live in app.mjs; this file is the CLI around them, and the place
 * the tuning config is read (packages/config) and reported. Ranking happens on
 * the client against precomputed embeddings, so /api/search stays a text tower
 * and nothing else.
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { scanDirectory } from './scan.mjs';
import { createApp } from './app.mjs';
import { loadConfig } from '../config/load.mjs';
import { portInUse } from './port.mjs';

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
// The base tiles (centre + wallpaper variants) live outside the corpus, in the
// repo's assets by default, so the base render can be shared across corpora and
// changed without touching --images. See scan.mjs.
const baseDir = resolve(process.cwd(), argv['base-dir'] ?? 'assets');
const port = Number(argv.port ?? 5173);

// Checked before anything is scanned or bundled, because the failure mode
// without it is silent and expensive: Node fires the `listening` callback and
// only THEN emits EADDRINUSE, so the banner prints, the handle is torn down,
// the event loop empties and the process exits 0. A second `npm run demo`
// against a server left running in another window says "the library is open at
// http://localhost:5173", exits successfully, and serves nothing - every page
// you then load is the old process, including the code you just changed.
if (await portInUse(port)) {
  console.error(
    `port ${port} is already in use - something else is serving there.\n` +
      'Stop it first, or pass a different --port. (A demo server left running in\n' +
      'another window will happily keep serving the code you had before.)'
  );
  process.exit(1);
}

// Loud about anything it could not honour: a tuning value that silently did not
// take effect is the one failure mode a config file really has.
const config = await loadConfig({ path: argv.config });
if (config.source) console.log(`config: ${config.source}`);
for (const note of config.notes) console.warn(`config: ${note}`);

console.log(`scanning ${imagesDir} ...`);
const manifest = await scanDirectory(imagesDir, { base: argv.base, baseDir });
const centre = manifest.base.centre?.file ?? '(none)';
console.log(
  `  ${manifest.count} rooms, base tile: ${centre}, ${manifest.base.variants.length} wallpaper variant(s)`
);
// A base directory with no centre means the map has no blank tile to draw at
// the origin or to fall back on - worth saying, since it reads on the map as a
// hole rather than an error.
if (!manifest.base.centre)
  console.warn(`  no base tile found in ${baseDir} - expected base.tile.* (or pass --base)`);

if (manifest.metadata) {
  const { matched, entries } = manifest.metadata;
  console.log(`  ${matched} rooms with keywords or story (${entries} entries in the sidecar)`);
  // Metadata that matches nothing is indistinguishable from no metadata once the
  // map is running, so it is the one case worth saying out loud.
  if (matched === 0)
    console.warn('  none of them matched a room - are the sidecar keys the image filenames?');
}

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
  baseDir,
  config,
  rescan: () => scanDirectory(imagesDir, { base: argv.base, baseDir }),
  bundleJs: bundle.outputFiles[0].text,
  readIndexHtml: () => readFile(join(webDir, 'index.html'), 'utf8'),
});

const server = app.listen(port, () => {
  console.log(`\n  the library is open at http://localhost:${port}`);
  // Express binds every interface, so the demo is already reachable from a
  // phone on the same network - but only if you know which address to type.
  // Printing them is the difference between "it is exposed" and "it is usable".
  for (const addr of lanAddresses()) console.log(`                       http://${addr}:${port}`);
  console.log();
});

// The backstop. The check above races anything that grabs the port in the
// moment between, and it is the only thing standing between a failed bind and
// an exit code of 0 - an unhandled 'error' here would otherwise be reported
// after the success banner has already been printed.
server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `\nport ${port} was taken before this server could bind it. Nothing is being served.`
      : `\nthe server failed to start: ${err.message}`
  );
  process.exit(1);
});

/** Non-internal IPv4 addresses, for testing the map on a device that is not this one. */
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
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
