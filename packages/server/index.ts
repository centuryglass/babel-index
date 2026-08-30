#!/usr/bin/env node
/**
 * The offline demo server.
 *
 *   npm run demo -- --images /path/to/rooms [--center center.png] [--port 5173]
 *                    [--config config.json] [--shared-dir assets]
 *                    [--base-path /babel-index/]
 *
 * Point it at a directory of images and it serves a browsable library. No
 * database, no bucket, no upload step - the directory *is* the corpus. That is
 * the whole point of offline mode: get a working local demo before hosting is
 * worth thinking about.
 *
 * `--base-path` is for serving this under a subpath of a shared domain
 * (`https://centuryglass.us/babel-index/`) instead of its own subdomain -
 * paired with a reverse proxy that strips the prefix before forwarding (see
 * `server-nginx.conf`), so this process's own routes are untouched by it.
 * What it changes is every url this server hands the browser: `<base href>`
 * in the served HTML, and `images`/`shared` in the manifest (`scan.ts`'s
 * `IMAGES_BASE`/`SHARED_BASE`) - see `packages/server/base-path.ts`. Defaults
 * to `/`, the plain own-origin case this app has always run as.
 *
 * Or point it at a corpus already uploaded with tools/upload/upload-r2.ts:
 *
 *   npm run demo -- --remote https://assets.example.com --prefix corpus-sample
 *
 * `--remote`/`--prefix` replace `--images`/`--shared-dir` entirely - the corpus
 * and shared tiles both come from the remote host (see remote.ts), and the
 * manifest's urls point the browser there directly rather than this server
 * serving or proxying anything under `/images`/`/shared`.
 *
 * `--favorites <path>` turns on global favorite counts, stored in that one
 * JSON file (see favorites.ts). Without it the favorite routes are not mounted
 * and the client offers no favorite control - the demo stays the stateless
 * thing it has always been. Behind a reverse proxy it must be paired with
 * `--trust-proxy 1` (and an nginx that sets X-Forwarded-For), or every visitor
 * shares the proxy's address and every count stops at one.
 *
 * The routes live in app.ts; this file is the CLI around them, and the place
 * the tuning config is read (packages/config) and reported. Ranking happens on
 * the client against precomputed embeddings, so /api/search stays a text tower
 * and nothing else.
 */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { context } from 'esbuild';
import { scanDirectory } from './scan.ts';
import { scanRemote } from './remote.ts';
import { createApp, hasTextModel } from './app.ts';
import { createJsonFavoriteStore, type FavoriteStore } from './favorites.ts';
import { loadConfig } from '../config/load.ts';
import { portInUse } from './port.ts';
import { normalizeBasePath } from './base-path.ts';
import type { Express } from 'express';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../web');

const argv = parseArgs(process.argv.slice(2));
const port = Number(argv.port ?? 5173);
const basePath = normalizeBasePath(argv['base-path'] as string | undefined);

const remoteBase = (argv.remote as string | undefined) ?? null;
if (remoteBase && argv.images) {
  console.error('--remote and --images are mutually exclusive - the corpus comes from one place or the other.');
  process.exit(1);
}
if (remoteBase && !argv.prefix) {
  console.error('--remote requires --prefix (the corpus prefix used when it was uploaded).');
  process.exit(1);
}

// Defaults to the sample corpus committed to the repo, so `npm run demo` works
// with no arguments and no external files. Unused entirely in --remote mode.
const imagesDir = remoteBase ? null : resolve(process.cwd(), (argv.images as string | undefined) ?? 'assets/corpus-sample');
if (!remoteBase && !existsSync(imagesDir)) {
  console.error(`no such directory: ${imagesDir}`);
  process.exit(1);
}
// The shared tiles (center + generic tiles) live outside the corpus, in the
// repo's assets by default, so the center render can be shared across corpora
// and changed without touching --images. See scan.ts.
const sharedDir = remoteBase ? null : resolve(process.cwd(), (argv['shared-dir'] as string | undefined) ?? 'assets');
// Optional debugging convenience, off by default: `npm run demo:watch` runs
// this under `node --watch` (restarts the whole process on a server-side
// edit) AND passes --watch through to us here, which switches the esbuild
// call below from a one-shot build to a watching one (rebuilds on a
// client-side edit without a restart). Either kind of change reaches the
// browser through the same live-reload connection - see app.ts.
const watch = Boolean(argv.watch);

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

// Load optional JSON config if provided, announcing invalid data:
const config = await loadConfig({ path: argv.config as string | undefined });
if (config.source) console.log(`config: ${config.source}`);
for (const note of config.notes) console.warn(`config: ${note}`);

// Off unless asked for. The counts are the only state this process owns, and
// a demo that silently started recording them somewhere would be the wrong
// default in both directions - nothing to clean up, nothing to explain.
const favoritesPath = argv.favorites as string | undefined;
let favorites: FavoriteStore | null = null;
if (favoritesPath) {
  try {
    favorites = await createJsonFavoriteStore({ path: resolve(process.cwd(), favoritesPath) });
  } catch (err) {
    console.error(`could not open ${favoritesPath}: ${(err as Error).message}`);
    process.exit(1);
  }
}

// Express's `trust proxy`, verbatim - '1' and 'loopback' both mean something
// to it, so this is not parsed into a boolean here. Unset is a direct
// connection, where the socket address IS the visitor's.
const trustProxyArg = argv['trust-proxy'];
const trustProxy =
  trustProxyArg === undefined ? false : typeof trustProxyArg === 'string' && /^\d+$/.test(trustProxyArg) ? Number(trustProxyArg) : trustProxyArg;

const rescan = remoteBase
  ? () => scanRemote(remoteBase, argv.prefix as string)
  : () => scanDirectory(imagesDir as string, { center: argv.center as string | undefined, sharedDir: sharedDir as string | undefined });

console.log(remoteBase ? `fetching manifest from ${remoteBase}/${argv.prefix} ...` : `scanning ${imagesDir} ...`);
const manifest = await rescan();
const centerFile = manifest.shared.center?.file ?? '(none)';
console.log(
  `  ${manifest.count} rooms, center tile: ${centerFile}, ${manifest.shared.generic.length} generic tile(s)`
);
// A shared directory with no center means the map has no blank tile to draw at
// the origin or to fall back on - worth saying, since it reads on the map as a
// hole rather than an error.
if (!manifest.shared.center && !remoteBase)
  console.warn(`  no center tile found in ${sharedDir} - expected center_tile.* (or pass --center)`);

if (manifest.metadata) {
  const { matched, entries } = manifest.metadata;
  console.log(`  ${matched} rooms with keywords or story (${entries} entries in the sidecar)`);
  // Metadata that matches nothing is indistinguishable from no metadata once the
  // map is running, so it is the one case worth saying out loud.
  if (matched === 0)
    console.warn('  none of them matched a room - are the sidecar keys the image filenames?');
}

// The CLIP text tower is an OPTIONAL dependency, because `onnxruntime-node`
// publishes for win32/darwin/linux only and as a required one it takes the
// whole install down on anything else. Without it a search still ranks - by
// keywords and story - so this is a note, not a warning, and it is said at
// startup rather than left to be discovered on the first query.
if (!hasTextModel())
  console.log('  no CLIP text model installed - search will rank by keywords and story only');

console.log(watch ? 'bundling client (watch mode) ...' : 'bundling client ...');
// `app` is assigned below, after this closure is built - referenced here only
// from onEnd, which never fires before then.
let app: Express | undefined;
let bundleJs = '';
const ctx = await context({
  entryPoints: [join(webDir, 'src/main.tsx')],
  bundle: true,
  format: 'esm',
  jsx: 'automatic',
  target: ['es2022'],
  minify: false,
  sourcemap: 'inline',
  write: false,
  define: { 'process.env.NODE_ENV': '"development"' },
  // Chrome art (the search icon's badge and arrow) gets imported as raw
  // markup rather than traced into JSX by hand, so the source SVGs in
  // assets/ stay the one copy of that path data - see SearchIcon.tsx.
  loader: { '.svg': 'text' },
  plugins: [
    {
      name: 'live-reload',
      setup(build) {
        build.onEnd((result) => {
          if (result.outputFiles?.[0]) bundleJs = result.outputFiles[0].text;
          app?.locals.broadcastReload?.();
        });
      },
    },
  ],
});
await ctx.rebuild();
if (watch) await ctx.watch();
else await ctx.dispose();

app = createApp({
  manifest,
  imagesDir,
  sharedDir,
  config,
  rescan,
  getBundleJs: () => bundleJs,
  readIndexHtml: () => readFile(join(webDir, 'index.html'), 'utf8'),
  watch,
  basePath,
  favorites,
  trustProxy,
});

const server = app.listen(port, () => {
  // Express itself always serves from root - server-nginx.conf's
  // prefix-stripping proxy_pass is what makes basePath true for anyone
  // arriving through it - so this box's own address is unprefixed even when
  // --base-path is set. Hitting it directly here would 404 against
  // <base href>'s prefix; that's expected, not a bug to chase.
  console.log(`\n  the library is open at http://localhost:${port}`);
  // Express binds every interface, so the demo is already reachable from a
  // phone on the same network - but only if you know which address to type.
  // Printing them is the difference between "it is exposed" and "it is usable".
  for (const addr of lanAddresses()) console.log(`                       http://${addr}:${port}`);
  if (basePath !== '/')
    console.log(`  --base-path ${basePath}: <base href> is set for a reverse proxy that strips it - see server-nginx.conf`);
  if (favorites) {
    const rooms = Object.keys(favorites.counts()).length;
    console.log(`  favorites: ${favoritesPath} (${rooms} room(s) favorited so far)`);
    if (!trustProxy)
      console.log('             direct connections assumed - behind a reverse proxy, pass --trust-proxy 1');
  }
  if (watch) console.log('  watch mode: client edits rebuild in place, the browser reloads itself');
  console.log();
});

// The backstop. The check above races anything that grabs the port in the
// moment between, and it is the only thing standing between a failed bind and
// an exit code of 0 - an unhandled 'error' here would otherwise be reported
// after the success banner has already been printed.
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `\nport ${port} was taken before this server could bind it. Nothing is being served.`
      : `\nthe server failed to start: ${err.message}`
  );
  process.exit(1);
});

// The debounced snapshot is deliberately unref'd, so nothing but this writes
// out the last few favorites when the process is asked to stop.
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void (favorites?.flush() ?? Promise.resolve()).finally(() => process.exit(0));
  });

/** Non-internal IPv4 addresses, for testing the map on a device that is not this one. */
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

function parseArgs(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = args[i + 1];
    // A flag with no value after it (or immediately followed by another
    // flag, e.g. `--watch --port 5173`) is boolean rather than missing its
    // argument - `--watch` has no value to consume.
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else out[key] = args[++i];
  }
  return out;
}
