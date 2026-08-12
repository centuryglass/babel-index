/**
 * The demo server's routes, separated from the CLI that starts it.
 *
 * `index.mjs` owns argv, the esbuild bundle and the listening socket; this file
 * owns the four endpoints. Split so the API can be exercised with a plain
 * `fetch` against an ephemeral port - no browser, no bundler, no fixtures on
 * disk beyond the images directory under test.
 */
import express from 'express';

/**
 * Build the app.
 *
 * @param {object} opts
 * @param {object} opts.manifest       the initial scan (see scan.mjs)
 * @param {string} opts.imagesDir      directory the corpus is served from
 * @param {() => Promise<object>} [opts.rescan] re-read the directory
 * @param {string} [opts.bundleJs]     the built client
 * @param {() => Promise<string>} [opts.readIndexHtml] read on each request, so
 *                                     editing the page needs no restart
 */
export function createApp({ manifest, imagesDir, rescan, bundleJs = '', readIndexHtml }) {
  const app = express();

  app.get('/api/manifest', (_req, res) => res.json(manifest));

  app.post('/api/rescan', async (_req, res, next) => {
    if (!rescan) return res.status(501).json({ error: 'rescan not available' });
    try {
      manifest = await rescan();
      res.json({ count: manifest.count });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Offline search.
   *
   * There is no CLIP here. This returns a deterministic pseudo-ranking derived
   * from the query string so the *mechanic* - type a term, watch the library
   * rearrange around the centre - can be exercised without a model. It is
   * labelled as a stub in the response so the UI can say so rather than
   * implying the results mean something.
   */
  app.get('/api/search', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ stub: true, query: q, order: null });
    res.json({ stub: true, query: q, order: stubRanking(manifest.rooms, q) });
  });

  // express.static resolves and confines paths itself, so `..` in a request
  // cannot climb out of the images directory.
  app.use('/images', express.static(imagesDir, { maxAge: '1h', immutable: true }));

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
