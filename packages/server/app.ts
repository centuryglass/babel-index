/**
 * The demo server's routes, separated from the CLI that starts it.
 *
 * `index.ts` owns argv, the esbuild bundle and the listening socket; this file
 * owns the four endpoints. Split so the API can be exercised with a plain
 * `fetch` against an ephemeral port - no browser, no bundler, no fixtures on
 * disk beyond the images directory under test.
 */
import { availableParallelism } from 'node:os';
import express, { type Express, type Request, type Response } from 'express';
import { resolveConfig } from '../config/config.ts';
import { createLruCache, createLimiter } from './search-cache.ts';
import { normalizeBasePath } from './base-path.ts';
import { logger } from './logger.ts';
import type { Manifest } from '../map/manifest.ts';
import type { Config } from '../config/config.ts';
import type { FavoriteStore } from './favorites.ts';

/** A resolved config as `loadConfig()` (packages/config/load.ts) returns it -
 *  `Config` plus where it came from, if anywhere. */
type ResolvedConfig = Config & { source?: string | null };

// Must be the same CLIP as tools/embed/embed.ts used for the images, or the
// text and image towers point into different spaces and every ranking is quiet
// nonsense. The image side is fixed the moment embeddings.bin is written; this
// is the matching text side.
const TEXT_MODEL = 'Xenova/clip-vit-base-patch32';

// Dev-only live reload (see the `watch` option below). One mechanism covers
// two different restart shapes: a client-only rebuild broadcasts 'reload' on
// the still-open connection, while a full process restart (`node --watch` on
// the server itself) kills the connection outright - EventSource's own
// auto-reconnect then re-opens it, and `onopen` after a prior error is
// indistinguishable from "the server just came back", which is exactly the
// signal we want.
// Relative, like every other url this file hands the browser (see
// base-path.ts) - resolved against the `<base href>` injected into
// index.html below, so watch mode works the same under a subpath as at root.
const LIVE_RELOAD_TAG = '<script src="__live-reload.js"></script>';
const LIVE_RELOAD_CLIENT = `(function () {
  let sawError = false;
  const es = new EventSource('api/live-reload');
  es.onmessage = () => location.reload();
  es.onerror = () => { sawError = true; };
  es.onopen = () => { if (sawError) location.reload(); };
})();
`;

export interface CreateAppOptions {
  /** the initial scan (see scan.ts or remote.ts) */
  manifest: Manifest;
  /** directory the corpus is served from (local mode); omit in remote mode,
   *  where the manifest's urls already point directly at R2/Cloudflare and
   *  this server never serves images at all (see remote.ts) */
  imagesDir?: string | null;
  /** directory the shared tiles are served from, under /shared (local mode
   *  default: the images directory) */
  sharedDir?: string | null;
  /** re-read the corpus (directory or remote manifest) */
  rescan: () => Promise<Manifest>;
  /** resolved config (see packages/config); the defaults when absent */
  config?: ResolvedConfig;
  /** the built client, fixed for the process's lifetime */
  bundleJs?: string;
  /** the built client, read on each request instead - how `watch` mode
   *  serves a bundle that gets rebuilt in place */
  getBundleJs?: () => string;
  /** read on each request, so editing the page needs no restart */
  readIndexHtml?: () => Promise<string>;
  /** dev convenience: serve the live-reload client and expose
   *  `app.locals.broadcastReload` for a rebuild to call */
  watch?: boolean;
  /** where the app is reverse-proxied to, e.g. '/babel-index/' (default '/').
   *  Every route below stays mounted at its own unprefixed path - see
   *  base-path.ts - this only sets the `<base href>` the served HTML carries,
   *  so the browser resolves this file's relative urls under the subpath. */
  basePath?: string;
  /** where global favorite counts live (see favorites.ts). Absent - the
   *  default, and every test that does not ask for it - means the three
   *  favorite routes are not mounted at all and the client renders no favorite
   *  UI, rather than a count nothing can record. */
  favorites?: FavoriteStore | null;
  /** passed straight to Express's `trust proxy` setting. It has to be set for
   *  a deployment behind a reverse proxy, or `req.ip` is the proxy's own
   *  address - one hash for every visitor, and every favorite count capped at
   *  one. Default false: correct for a direct connection, which is what the
   *  demo is. See index.ts's `--trust-proxy`. */
  trustProxy?: string | number | boolean;
}

/** Build the app. */
export function createApp({
  manifest,
  imagesDir,
  sharedDir = imagesDir,
  rescan,
  config,
  bundleJs = '',
  getBundleJs,
  readIndexHtml,
  watch = false,
  basePath = '/',
  favorites = null,
  trustProxy = false,
}: CreateAppOptions): Express {
  const app = express();
  const base = normalizeBasePath(basePath);

  // Only when asked for: Express's default (off) is the truthful reading of a
  // direct connection, and trusting a header nobody strips would let any
  // client pick its own address - which here means picking its own favorite
  // hash, one per request, without limit.
  if (trustProxy !== false) app.set('trust proxy', trustProxy);

  // Config rides on the manifest rather than getting an endpoint of its own:
  // the client already blocks on this fetch before it can render, and a second
  // round trip for a hundred bytes would only add a state where the map exists
  // and does not yet know its own zoom range. `notes` is for the operator, not
  // the browser, so it is stripped here - index.ts prints it at startup.
  const { notes: _notes, source: _source, ...clientConfig } = config ?? (resolveConfig() as ResolvedConfig);
  const clipTextDtype = clientConfig.search?.clipTextDtype ?? 'fp32';

  // Whether the client should offer favoriting at all. A flag rather than the
  // counts themselves: the manifest is on the path to the first frame, and the
  // counts are a second, cacheable thing that changes on its own schedule.
  const favoritesInfo = favorites ? { enabled: true } : null;

  app.get('/api/manifest', (_req, res) =>
    res.json({ ...manifest, favorites: favoritesInfo, config: clientConfig })
  );

  // Which room files exist, for the favorite routes to validate against. Kept
  // in step with `manifest` through the rescan below - a room that has left the
  // corpus stops being favoritable the moment the scan says so.
  let roomFiles = new Set(manifest.rooms.map((room) => room.file));

  app.post('/api/rescan', async (_req, res, next) => {
    try {
      manifest = await rescan();
      roomFiles = new Set(manifest.rooms.map((room) => room.file));
      res.json({ count: manifest.count });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Search.
   *
   * The server runs only the *text* tower: string -> 512-dim query vector. The
   * browser owns ranking (rankByEmbedding against embeddings.bin), so a re-rank
   * or a search-history restore costs no round trip and the endpoint stays a
   * tiny stateless thing that could sit in front of a static bundle.
   *
   * Two fallbacks keep the mechanic - type a term, watch the library rearrange
   * around the center - alive without a model: no blob for this corpus, or the
   * model failing to load (offline with nothing cached). Both return a
   * deterministic pseudo-ranking, labelled `stub` so the UI can say so rather
   * than imply the order means something.
   */
  app.get('/api/search', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ query: q, order: null });

    if (!manifest.embeddings)
      return res.json({ stub: true, query: q, order: stubRanking(manifest.rooms, q) });

    try {
      const cacheKey = `${clipTextDtype} ${q}`;
      let vector = embedCache.get(cacheKey);
      if (!vector) {
        vector = await embedLimiter(() => embedQuery(q, clipTextDtype));
        embedCache.set(cacheKey, vector);
      }
      res.json({ stub: false, query: q, vector });
    } catch (err) {
      // The note reaching the browser deliberately omits local paths and stack
      // traces - the operator's copy, with those, goes to the logger instead.
      // Previously this failure had NO server-side trace at all: a broken
      // install (present but failing to load, not simply absent) surfaced only
      // as a client-facing note nobody was watching for.
      logger.error({ err, query: q }, 'CLIP text-tower inference failed');
      // The two cases are worth telling apart: no model installed at all is a
      // permanent fact about this machine, and anything else is a load that
      // may yet succeed.
      const note = hasTextModel()
        ? `the CLIP text model failed to load: ${err?.message ?? err}`
        : 'no CLIP text model installed - ranking by keywords and story only';
      res.json({ stub: true, query: q, order: stubRanking(manifest.rooms, q), note });
    }
  });

  /**
   * Favorites.
   *
   * Three routes, mounted only when a store exists (see favorites.ts for what
   * is actually recorded and why it is a set rather than a counter):
   *
   *   GET    /api/favorites        every room with at least one, by file
   *   POST   /api/favorites/:file  this address favorites the room
   *   DELETE /api/favorites/:file  it stops
   *
   * There is deliberately NO route that answers "have I favorited this" - a
   * reader's own list lives in their browser (`persist.ts`) and the server
   * never assembles a per-visitor view of it. The two writes carry no body, so
   * no body parser is mounted; the room is named in the path and validated
   * against the corpus, which is also what keeps an arbitrary string out of the
   * store.
   */
  if (favorites) {
    const favoriteBuckets = createRateBuckets();

    app.get('/api/favorites', (_req, res) => {
      // Never cached: a count that is one page-load stale reads as a favorite
      // that did not register, which is the one thing this endpoint exists to
      // report.
      res.set('Cache-Control', 'no-store');
      res.json({ counts: favorites.counts() });
    });

    const write = (method: 'add' | 'remove') => (req: Request, res: Response) => {
      const file = String(req.params.file);
      if (!roomFiles.has(file)) return res.status(404).json({ error: 'no such room' });
      // req.ip is undefined only for a socket that has already gone away.
      const ip = req.ip ?? '';
      if (!favoriteBuckets.take(ip))
        return res.status(429).json({ error: 'too many favorites at once - try again in a moment' });
      const count = favorites[method](file, ip);
      res.json({ file, count, favorited: method === 'add' });
    };

    app.post('/api/favorites/:file', write('add'));
    app.delete('/api/favorites/:file', write('remove'));
  }

  // In remote mode there is no local directory to serve at all: the manifest's
  // urls (rewritten by remote.ts's scanRemote) already point the browser
  // directly at R2/Cloudflare, so this server never sees an /images or
  // /shared request in the first place.
  if (imagesDir) {
    // express.static resolves and confines paths itself, so `..` in a request
    // cannot climb out of the images directory.
    app.use('/images', express.static(imagesDir, { maxAge: '1h', immutable: true }));

    // The shared tiles (center + generic tiles) live outside the corpus, so
    // they get their own mount. When sharedDir is the images directory the two
    // overlap harmlessly - the manifest still addresses shared tiles via /shared.
    app.use('/shared', express.static(sharedDir, { maxAge: '1h', immutable: true }));
  }

  // The tab icon would otherwise be a 404 on every load.
  app.get('/favicon.ico', (_req, res) => res.status(204).end());

  app.get('/bundle.js', (_req, res) => {
    res.type('application/javascript').send(getBundleJs ? getBundleJs() : bundleJs);
  });

  if (readIndexHtml)
    app.get('/', async (_req, res, next) => {
      try {
        let html = await readIndexHtml();
        // Must land before any relative url the page itself contains
        // (bundle.js's script tag, any future stylesheet/icon link) - `<base
        // href>` only affects resolution for markup that follows it.
        html = html.replace('<head>', `<head>\n    <base href="${base}">`);
        if (watch) html = html.replace('</body>', `${LIVE_RELOAD_TAG}</body>`);
        res.type('html').send(html);
      } catch (err) {
        next(err);
      }
    });

  if (watch) {
    app.get('/__live-reload.js', (_req, res) => {
      res.type('application/javascript').send(LIVE_RELOAD_CLIENT);
    });

    const clients = new Set<Response>();
    app.get('/api/live-reload', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    });
    app.locals.broadcastReload = () => {
      for (const res of clients) res.write('data: reload\n\n');
    };
  }

  return app;
}

/**
 * Load the CLIP text tower once, lazily.
 *
 * Dynamic `import` so the heavy dependency is pulled only when a real search
 * actually runs - the stub path, and every test that never sets up a blob,
 * stays free of it. The promise is memoised, so concurrent first requests share
 * one load rather than racing two model downloads.
 *
 * Whether the CLIP text tower could be loaded at all.
 *
 * `import.meta.resolve` asks the resolver where the package IS without
 * executing a byte of it, so this costs nothing and can be answered at startup
 * - which the lazy `textTower()` below deliberately cannot, since loading the
 * model is the expensive thing it exists to defer.
 *
 * It matters because the package is OPTIONAL. `onnxruntime-node`, which
 * transformers.js needs, publishes for win32/darwin/linux only; on anything
 * else (Android under Termux, say) npm refuses it, and as a required dependency
 * that takes the whole install down with it. As an optional one it is skipped,
 * everything else installs, and the demo runs - ranking by keywords and story
 * instead of by CLIP. This is how the server says so out loud rather than
 * leaving it to be discovered on the first search.
 */
export function hasTextModel(): boolean {
  try {
    import.meta.resolve('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

// Module-level for the same reason as `textTowerPromises` below: CPU cores and
// a warm cache are resources of the process, not of one `createApp()` call, and
// tests build more than one app per process. The cache key folds in dtype (see
// the route above) so a config that loads a different precision never reads a
// vector computed at another one back out. Capacity is a guess, not a
// measurement - repeat searches (history, re-searching the same term) are
// common enough that even a small cache earns its keep, and 512 floats per
// entry keeps 200 of them cheap to hold.
const EMBED_CACHE_SIZE = 200;
const embedCache = createLruCache(EMBED_CACHE_SIZE);

// Bounds how many CLIP text-tower inferences run at once. Sized to the CPU,
// like the concurrency any other CPU-bound worker pool would use - past that
// many threads are fighting for the same cores rather than doing useful work,
// so a burst of distinct queries degrades to queueing latency instead of
// thrashing the machine.
//
// A load test against the live deploy showed exactly that degradation
// (throughput pinned at the limiter's cap, latency climbing with the queue)
// with no visible signal server-side - the only way to know it was happening
// was to be the one running the test. Logging it here, throttled, means a
// real traffic spike leaves a trace instead of just "the site felt slow that
// one time."
const SATURATION_LOG_INTERVAL_MS = 5_000;
let lastSaturationLog = 0;
const embedLimiter = createLimiter(Math.max(1, availableParallelism()), {
  onSaturated: ({ active, queued }) => {
    const now = Date.now();
    if (now - lastSaturationLog < SATURATION_LOG_INTERVAL_MS) return;
    lastSaturationLog = now;
    logger.warn({ active, queued }, 'search concurrency limit reached - requests are queueing');
  },
});

// Keyed by dtype rather than one bare promise: `createApp` may be built more
// than once in a process (tests do this) with different config, and reusing
// a model loaded at the wrong precision would be silently wrong rather than
// slow.
const textTowerPromises = new Map<string, Promise<{ tokenizer: any; model: any }>>();
function textTower(dtype: string): Promise<{ tokenizer: any; model: any }> {
  if (!textTowerPromises.has(dtype))
    textTowerPromises.set(
      dtype,
      (async () => {
        const { AutoTokenizer, CLIPTextModelWithProjection } = await import('@huggingface/transformers');
        const [tokenizer, model] = await Promise.all([
          AutoTokenizer.from_pretrained(TEXT_MODEL),
          CLIPTextModelWithProjection.from_pretrained(TEXT_MODEL, { dtype: dtype as any }),
        ]);
        return { tokenizer, model };
      })()
    );
  return textTowerPromises.get(dtype) as Promise<{ tokenizer: any; model: any }>;
}

/**
 * A query string to a unit-length 512-dim vector in CLIP's shared space.
 *
 * L2-normalised here so the client's int8 dot product is a cosine directly -
 * the image rows were normalised the same way when the blob was written.
 *
 * @param dtype transformers.js precision to load the text tower at
 */
async function embedQuery(q: string, dtype: string): Promise<number[]> {
  const { tokenizer, model } = await textTower(dtype);
  const inputs = tokenizer([q], { padding: true, truncation: true });
  const { text_embeds } = await model(inputs);
  const v = Float32Array.from(text_embeds.tolist()[0]);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return Array.from(v);
}

/**
 * The stub ranking: a hash of the query mixed with each room id.
 *
 * The only properties that matter are that the same query always gives the
 * same order (so the map does not reshuffle when you search twice) and that
 * different queries give different ones (so the mechanic is visible).
 *
 * @returns room ids, best first
 */
export function stubRanking(rooms: { id: number }[], query: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < query.length; i++) h = Math.imul(h ^ query.charCodeAt(i), 16777619);

  const scored = rooms.map((room) => {
    let s = Math.imul(room.id + 1, h >>> 0) >>> 0;
    s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) >>> 0;
    return { id: room.id, score: ((s ^ (s >>> 13)) >>> 0) / 4294967296 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.id);
}

/**
 * A token bucket per address for the favorite writes.
 *
 * Not a durability or a correctness measure - the set semantics already cap
 * what one address can do to a count - just a bound on how fast a script can
 * make this process hash things. In memory and never persisted, so it forgets
 * everyone on restart and holds no record of who asked for what: the same
 * reason favorites.ts stores no addresses.
 */
const RATE_BURST = 20;
const RATE_REFILL_MS = 1000;
const RATE_MAX_TRACKED = 10_000;

export function createRateBuckets({ burst = RATE_BURST, refillMs = RATE_REFILL_MS } = {}) {
  const seen = new Map<string, { tokens: number; at: number }>();
  return {
    /** @returns whether this address may spend a token now */
    take(key: string): boolean {
      const now = Date.now();
      // Bounded so a spray of forged addresses (or an honest crowd) cannot grow
      // this map without limit. Oldest-first, which is a Map's own iteration
      // order here since every touch rewrites its entry at the end.
      if (seen.size >= RATE_MAX_TRACKED && !seen.has(key)) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      const entry = seen.get(key) ?? { tokens: burst, at: now };
      entry.tokens = Math.min(burst, entry.tokens + (now - entry.at) / refillMs);
      entry.at = now;
      const allowed = entry.tokens >= 1;
      if (allowed) entry.tokens -= 1;
      seen.delete(key);
      seen.set(key, entry);
      return allowed;
    },
  };
}
