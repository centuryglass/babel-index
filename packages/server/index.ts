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
 * paired with the VPS's hand-managed nginx config, which strips the prefix
 * before forwarding (see `deploy/README.md`), so this process's own routes
 * are untouched by it. What it changes is every url this server hands the
 * browser: `<base href>` in the served HTML, and `images`/`shared` in the
 * manifest (`scan.ts`'s `IMAGES_BASE`/`SHARED_BASE`) - see
 * `packages/server/base-path.ts`. Defaults to `/`, the plain own-origin case.
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
 * JSON file (see favorites.ts). Without it the favorite routes are not
 * mounted and the client offers no favorite control. Behind a reverse proxy
 * it must be paired with `--trust-proxy 1` (and an nginx that sets
 * X-Forwarded-For), or every visitor shares the proxy's address and every
 * count stops at one.
 *
 * `LOG_FILE`/`ADMIN_PASSWORD_HASH` (env vars, not flags - the second is a
 * secret) turn on the admin log viewer at /admin/logs (see app.ts,
 * log-file.ts, admin-auth.ts). Both are required together; with only one
 * set this process logs a warning and mounts neither route rather than
 * serving unauthenticated.
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
import { loadRoomContent } from './roomContent.ts';
import { createJsonFavoriteStore, type FavoriteStore } from './favorites.ts';
import { loadConfig } from '../config/load.ts';
import { portInUse } from './port.ts';
import { normalizeBasePath } from './base-path.ts';
import { logger } from './logger.ts';
import { resolveCommit } from './version.ts';
import type { Express } from 'express';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../web');
const repoRoot = resolve(here, '../..');

const argv = parseArgs(process.argv.slice(2));
const port = Number(argv.port ?? 5173);
const basePath = normalizeBasePath(argv['base-path'] as string | undefined);

const remoteBase = (argv.remote as string | undefined) ?? null;
if (remoteBase && argv.images) {
  logger.error('--remote and --images are mutually exclusive - the corpus comes from one place or the other.');
  process.exit(1);
}
if (remoteBase && !argv.prefix) {
  logger.error('--remote requires --prefix (the corpus prefix used when it was uploaded).');
  process.exit(1);
}

// Defaults to the sample corpus committed to the repo, so `npm run demo` works
// with no arguments and no external files. Unused entirely in --remote mode.
const imagesDir = remoteBase ? null : resolve(process.cwd(), (argv.images as string | undefined) ?? 'assets/corpus-sample');
if (!remoteBase && !existsSync(imagesDir)) {
  logger.error({ imagesDir }, 'no such directory');
  process.exit(1);
}
// The shared tiles (center + generic tiles) live outside the corpus, in the
// repo's assets by default, so the center render can be shared across corpora
// and changed without touching --images. See scan.ts.
const sharedDir = remoteBase ? null : resolve(process.cwd(), (argv['shared-dir'] as string | undefined) ?? 'assets');
// Optional debugging convenience, off by default. `npm run demo:watch` runs
// this under `node --watch` (restarts the whole process on a server-side
// edit) AND passes --watch through, which switches the esbuild call below
// from a one-shot build to a watching one (rebuilds on a client-side edit
// without a restart). Either kind of change reaches the browser through the
// same live-reload connection - see app.ts.
const watch = Boolean(argv.watch);

// Checked before anything is scanned or bundled; port.ts's header is why the
// failure this prevents is silent and expensive.
if (await portInUse(port)) {
  logger.error(
    { port },
    'port is already in use - something else is serving there. Stop it first, or pass a different --port. ' +
      '(A demo server left running in another window will happily keep serving the code you had before.)'
  );
  process.exit(1);
}

// Load optional JSON config if provided, announcing invalid data:
const config = await loadConfig({ path: argv.config as string | undefined });
if (config.source) logger.info({ source: config.source }, 'config loaded');
for (const note of config.notes) logger.warn({ note }, 'config note');

// Off unless asked for. The counts are the only state this process persists,
// and a demo that silently started recording them somewhere would be the
// wrong default: nothing to clean up, nothing to explain.
const favoritesPath = argv.favorites as string | undefined;
let favorites: FavoriteStore | null = null;
if (favoritesPath) {
  try {
    favorites = await createJsonFavoriteStore({ path: resolve(process.cwd(), favoritesPath) });
  } catch (err) {
    logger.error({ err, favoritesPath }, 'could not open favorites store');
    process.exit(1);
  }
}

// Off unless both are set - see this file's header comment. A misconfigured
// single env var stays unmounted (app.ts) rather than accidentally serving
// logs with no password, but it's worth saying so at startup rather than
// leaving that to be discovered by a 404 on /admin/logs.
const logFile = process.env.LOG_FILE || null;
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || null;
if (logFile && !adminPasswordHash) logger.warn('LOG_FILE is set but ADMIN_PASSWORD_HASH is not - /admin/logs will not be mounted');
if (adminPasswordHash && !logFile) logger.warn('ADMIN_PASSWORD_HASH is set but LOG_FILE is not - /admin/logs will not be mounted');

// Express's `trust proxy`, verbatim - '1' and 'loopback' both mean something
// to it, so this is not parsed into a boolean here. Unset is a direct
// connection, where the socket address is the visitor's.
const trustProxyArg = argv['trust-proxy'];
const trustProxy =
  trustProxyArg === undefined ? false : typeof trustProxyArg === 'string' && /^\d+$/.test(trustProxyArg) ? Number(trustProxyArg) : trustProxyArg;

const scan = remoteBase
  ? () => scanRemote(remoteBase, argv.prefix as string)
  : () => scanDirectory(imagesDir as string, { center: argv.center as string | undefined, sharedDir: sharedDir as string | undefined });

logger.info(
  remoteBase ? { remoteBase, prefix: argv.prefix } : { imagesDir },
  remoteBase ? 'fetching manifest' : 'scanning'
);
const manifest = await scan();
const centerFile = manifest.shared.center?.file ?? '(none)';
logger.info(
  {
    rooms: manifest.count,
    centerFile,
    genericTiles: manifest.shared.generic.length,
    genericDistillTiles: manifest.shared.genericDistill.filter(Boolean).length,
  },
  'corpus scanned'
);
// A shared directory with no center means the map has no blank tile to draw at
// the origin or to fall back on - worth saying, since it reads on the map as a
// hole rather than an error.
if (!manifest.shared.center && !remoteBase)
  logger.warn({ sharedDir }, 'no center tile found - expected center_tile.* (or pass --center)');

if (manifest.metadata) {
  const { matched, entries } = manifest.metadata;
  logger.info({ matched, entries }, 'rooms with keywords or story');
  // Matched 0 against non-zero entries is the keys-drifted signal, and the
  // map reads it the same as having no sidecar - the one case worth saying
  // out loud (see scanDirectory's `metadata` note).
  if (matched === 0) logger.warn('none of the sidecar entries matched a room - are the keys the image filenames?');
}

// The sidecar is read here so roomContent.ts's duplicate-permalink warning
// lands in the startup log, beside the rest of what this corpus turned out to
// be. The catalog routes share this one memoized load.
await loadRoomContent(manifest, imagesDir);

// The text tower is optional - app.ts's `hasTextModel` says why. Without it
// a search still ranks by keywords and story, so this is a note, not a
// warning, said at startup rather than left to be discovered on the first
// query.
if (!hasTextModel()) logger.info('no CLIP text model installed - search will rank by keywords and story only');

logger.info(watch ? 'bundling client (watch mode)' : 'bundling client');
// `app` is assigned below, after this closure is built - referenced here only
// from onEnd, which never fires before then.
// eslint-disable-next-line prefer-const -- reassigned once below, after the closure that reads it exists
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
  // The center shelf's spine webfont is bundled the same self-hosted way, as a
  // base64 data URI, so a title renders without a font CDN request - see
  // spineFont.ts.
  loader: { '.svg': 'text', '.woff2': 'dataurl', '.vert': 'text', '.frag': 'text' },
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

// Once per process, not per request: a running process cannot change which
// revision it is (AGENTS.md, "Deploying to the VPS"; see version.ts).
const commit = resolveCommit(repoRoot);

app = createApp({
  manifest,
  imagesDir,
  sharedDir,
  config,
  getBundleJs: () => bundleJs,
  readIndexHtml: () => readFile(join(webDir, 'index.html'), 'utf8'),
  readStyleCss: () => readFile(join(webDir, 'style.css'), 'utf8'),
  publicDir: join(webDir, 'public'),
  watch,
  basePath,
  favorites,
  trustProxy,
  commit,
  logFile,
  adminPasswordHash,
});

const server = app.listen(port, () => {
  // Express itself always serves from root - the VPS's prefix-stripping
  // proxy_pass (see deploy/README.md) is what makes basePath true for anyone
  // arriving through it - so this box's own address is unprefixed even when
  // --base-path is set. Hitting it directly here would 404 against
  // <base href>'s prefix; that's expected, not a bug to chase.
  //
  // Express binds every interface, so the demo is already reachable from a
  // phone on the same network - but only if you know which address to type.
  // Listing them is the difference between "it is exposed" and "it is usable".
  logger.info({ port, addresses: lanAddresses(), watch, commit }, 'the library is open');
  if (basePath !== '/')
    logger.info({ basePath }, '<base href> is set for a reverse proxy that strips it - see deploy/README.md');
  if (favorites) {
    const rooms = Object.keys(favorites.counts()).length;
    logger.info({ favoritesPath, rooms }, 'favorites store loaded');
    if (!trustProxy)
      logger.info('direct connections assumed for favorites - behind a reverse proxy, pass --trust-proxy 1');
  }
  if (logFile && adminPasswordHash) logger.info({ logFile }, 'admin log viewer mounted at /admin/logs');
});

// The backstop. The check above races anything that grabs the port in the
// moment between, and it is the only thing standing between a failed bind and
// an exit code of 0 - an unhandled 'error' here would otherwise be reported
// after the success banner has already been printed.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') logger.error({ port }, 'port was taken before this server could bind it - nothing is being served');
  else logger.error({ err }, 'the server failed to start');
  process.exit(1);
});

// The store's debounced snapshot timer is unref'd (see favorites.ts), so
// these handlers are what flush pending favorites when the process is asked
// to stop.
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
