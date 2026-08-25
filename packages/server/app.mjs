/**
 * The demo server's routes, separated from the CLI that starts it.
 *
 * `index.mjs` owns argv, the esbuild bundle and the listening socket; this file
 * owns the four endpoints. Split so the API can be exercised with a plain
 * `fetch` against an ephemeral port - no browser, no bundler, no fixtures on
 * disk beyond the images directory under test.
 */
import express from 'express';
import { resolveConfig } from '../config/config.mjs';
import { mountProxy } from './remote.mjs';

// Must be the same CLIP as tools/embed/embed.mjs used for the images, or the
// text and image towers point into different spaces and every ranking is quiet
// nonsense. The image side is fixed the moment embeddings.bin is written; this
// is the matching text side.
const TEXT_MODEL = 'Xenova/clip-vit-base-patch32';

/**
 * Build the app.
 *
 * @param {object} opts
 * @param {object} opts.manifest       the initial scan (see scan.mjs or remote.mjs)
 * @param {string} [opts.imagesDir]    directory the corpus is served from (local mode)
 * @param {string} [opts.sharedDir]    directory the shared tiles are served from,
 *                                     under /shared (local mode default: the images directory)
 * @param {{imagesBase: string, sharedBase: string}} [opts.remote] when set,
 *                                     `/images` and `/shared` proxy these remote
 *                                     bases instead of serving `imagesDir`/`sharedDir`
 *                                     from disk (see remote.mjs)
 * @param {() => Promise<object>} opts.rescan re-read the corpus (directory or remote manifest)
 * @param {object} [opts.config]       resolved config (see packages/config); the
 *                                     defaults when absent
 * @param {string} [opts.bundleJs]     the built client
 * @param {() => Promise<string>} [opts.readIndexHtml] read on each request, so
 *                                     editing the page needs no restart
 */
export function createApp({ manifest, imagesDir, sharedDir = imagesDir, remote, rescan, config, bundleJs = '', readIndexHtml }) {
  const app = express();

  // Config rides on the manifest rather than getting an endpoint of its own:
  // the client already blocks on this fetch before it can render, and a second
  // round trip for a hundred bytes would only add a state where the map exists
  // and does not yet know its own zoom range. `notes` is for the operator, not
  // the browser, so it is stripped here - index.mjs prints it at startup.
  const { notes: _notes, source: _source, ...clientConfig } = config ?? resolveConfig();

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
      const vector = await embedQuery(q);
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

  if (remote) {
    // The corpus lives on a remote host (see remote.mjs); /images and /shared
    // proxy it rather than serving a local directory, so nothing downstream -
    // the client, createUrlFor, the manifest's urls - has to know the
    // difference.
    mountProxy(app, '/images', remote.imagesBase);
    mountProxy(app, '/shared', remote.sharedBase);
  } else {
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
    res.type('application/javascript').send(bundleJs);
  });

  if (readIndexHtml)
    app.get('/', async (_req, res, next) => {
      try {
        res.type('html').send(await readIndexHtml());
      } catch (err) {
        next(err);
      }
    });

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

let textTowerPromise = null;
function textTower() {
  if (!textTowerPromise)
    textTowerPromise = (async () => {
      const { AutoTokenizer, CLIPTextModelWithProjection } = await import('@huggingface/transformers');
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(TEXT_MODEL),
        CLIPTextModelWithProjection.from_pretrained(TEXT_MODEL, { dtype: 'fp32' }),
      ]);
      return { tokenizer, model };
    })();
  return textTowerPromise;
}

/**
 * A query string to a unit-length 512-dim vector in CLIP's shared space.
 *
 * L2-normalised here so the client's int8 dot product is a cosine directly -
 * the image rows were normalised the same way when the blob was written.
 *
 * @param {string} q
 * @returns {Promise<number[]>}
 */
async function embedQuery(q) {
  const { tokenizer, model } = await textTower();
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
