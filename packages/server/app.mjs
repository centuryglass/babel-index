/**
 * The demo server's routes, separated from the CLI that starts it.
 *
 * `index.mjs` owns argv, the esbuild bundle and the listening socket; this file
 * owns the four endpoints. Split so the API can be exercised with a plain
 * `fetch` against an ephemeral port - no browser, no bundler, no fixtures on
 * disk beyond the images directory under test.
 */
import { availableParallelism } from 'node:os';
import express from 'express';
import { resolveConfig } from '../config/config.ts';
import { createLruCache, createLimiter } from './search-cache.ts';

// Must be the same CLIP as tools/embed/embed.mjs used for the images, or the
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
const LIVE_RELOAD_TAG = '<script src="/__live-reload.js"></script>';
const LIVE_RELOAD_CLIENT = `(function () {
  let sawError = false;
  const es = new EventSource('/api/live-reload');
  es.onmessage = () => location.reload();
  es.onerror = () => { sawError = true; };
  es.onopen = () => { if (sawError) location.reload(); };
})();
`;

/**
 * Build the app.
 *
 * @param {object} opts
 * @param {import('../map/manifest.ts').Manifest} opts.manifest the initial scan
 *                                     (see scan.mjs or remote.mjs)
 * @param {string} [opts.imagesDir]    directory the corpus is served from (local mode);
 *                                     omit in remote mode, where the manifest's urls
 *                                     already point directly at R2/Cloudflare and this
 *                                     server never serves images at all (see remote.mjs)
 * @param {string} [opts.sharedDir]    directory the shared tiles are served from,
 *                                     under /shared (local mode default: the images directory)
 * @param {() => Promise<import('../map/manifest.ts').Manifest>} opts.rescan
 *                                     re-read the corpus (directory or remote manifest)
 * @param {object} [opts.config]       resolved config (see packages/config); the
 *                                     defaults when absent
 * @param {string} [opts.bundleJs]     the built client, fixed for the process's
 *                                     lifetime
 * @param {() => string} [opts.getBundleJs] the built client, read on each
 *                                     request instead - how `watch` mode serves
 *                                     a bundle that gets rebuilt in place
 * @param {() => Promise<string>} [opts.readIndexHtml] read on each request, so
 *                                     editing the page needs no restart
 * @param {boolean} [opts.watch]       dev convenience: serve the live-reload
 *                                     client and expose `app.locals.broadcastReload`
 *                                     for a rebuild to call
 */
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
}) {
  const app = express();

  // Config rides on the manifest rather than getting an endpoint of its own:
  // the client already blocks on this fetch before it can render, and a second
  // round trip for a hundred bytes would only add a state where the map exists
  // and does not yet know its own zoom range. `notes` is for the operator, not
  // the browser, so it is stripped here - index.mjs prints it at startup.
  const { notes: _notes, source: _source, ...clientConfig } = config ?? resolveConfig();
  const clipTextDtype = clientConfig.search?.clipTextDtype ?? 'fp32';

  app.get('/api/manifest', (_req, res) => res.json({ ...manifest, config: clientConfig }));

  app.post('/api/rescan', async (_req, res, next) => {
    try {
      manifest = await rescan();
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
      // The note reaches the browser, so it says what happened rather than
      // pasting a module resolution error with local paths in it. The two cases
      // are worth telling apart: no model installed at all is a permanent fact
      // about this machine, and anything else is a load that may yet succeed.
      const note = hasTextModel()
        ? `the CLIP text model failed to load: ${err?.message ?? err}`
        : 'no CLIP text model installed - ranking by keywords and story only';
      res.json({ stub: true, query: q, order: stubRanking(manifest.rooms, q), note });
    }
  });

  // In remote mode there is no local directory to serve at all: the manifest's
  // urls (rewritten by remote.mjs's scanRemote) already point the browser
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

    const clients = new Set();
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
 */
/**
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
 *
 * @returns {boolean}
 */
export function hasTextModel() {
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
const embedLimiter = createLimiter(Math.max(1, availableParallelism()));

// Keyed by dtype rather than one bare promise: `createApp` may be built more
// than once in a process (tests do this) with different config, and reusing
// a model loaded at the wrong precision would be silently wrong rather than
// slow.
const textTowerPromises = new Map();
function textTower(dtype) {
  if (!textTowerPromises.has(dtype))
    textTowerPromises.set(
      dtype,
      (async () => {
        const { AutoTokenizer, CLIPTextModelWithProjection } = await import('@huggingface/transformers');
        const [tokenizer, model] = await Promise.all([
          AutoTokenizer.from_pretrained(TEXT_MODEL),
          CLIPTextModelWithProjection.from_pretrained(TEXT_MODEL, { dtype }),
        ]);
        return { tokenizer, model };
      })()
    );
  return textTowerPromises.get(dtype);
}

/**
 * A query string to a unit-length 512-dim vector in CLIP's shared space.
 *
 * L2-normalised here so the client's int8 dot product is a cosine directly -
 * the image rows were normalised the same way when the blob was written.
 *
 * @param {string} q
 * @param {string} dtype transformers.js precision to load the text tower at
 * @returns {Promise<number[]>}
 */
async function embedQuery(q, dtype) {
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
 * @param {{id: number}[]} rooms
 * @param {string} query
 * @returns {number[]} room ids, best first
 */
export function stubRanking(rooms, query) {
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
