/**
 * The demo server's routes, separated from the CLI that starts it.
 *
 * `index.ts` owns argv, the esbuild bundle and the listening socket; this
 * file owns the endpoints. The split is so the API can be exercised with a
 * plain `fetch` against an ephemeral port - no browser, no bundler, no
 * fixtures on disk beyond the images directory under test.
 */
import { availableParallelism } from 'node:os';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { resolveConfig } from '../config/config.ts';
import { createLruCache, createLimiter } from './search-cache.ts';
import { normalizeBasePath } from './base-path.ts';
import { logger } from './logger.ts';
import { loadRoomContent } from './roomContent.ts';
import { renderCatalogList, renderRoomPage, escapeHtml } from './catalogPage.ts';
import { renderHelpPage, renderAboutPage } from './staticPages.tsx';
import { robotsTxt, renderSitemap } from './seo.ts';
import { generateRandomBookText } from '../web/src/lib/babelBook.ts';
import { roomPath } from '../map/slug.ts';
import { alphabeticalOrder, pageCount } from '../web/src/lib/catalog.ts';
import { createUrlFor } from '../web/src/lib/rooms.ts';
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

// Dev-only live reload, behind the `watch` option below. One EventSource
// covers both restart shapes: a client-only rebuild broadcasts 'reload' on
// the still-open connection; a full process restart (`node --watch` on the
// server itself) kills the connection outright, and EventSource's
// auto-reconnect after an error re-opens it - which reads to the client the
// same as "the server just came back", the signal wanted either way.
// Relative, resolved against the `<base href>` injected into index.html
// below, so watch mode works under a subpath as at root (see base-path.ts).
const LIVE_RELOAD_TAG = '<script src="__live-reload.js"></script>';
const LIVE_RELOAD_CLIENT = `(function () {
  let sawError = false;
  const es = new EventSource('api/live-reload');
  es.onmessage = () => location.reload();
  es.onerror = () => { sawError = true; };
  es.onopen = () => { if (sawError) location.reload(); };
})();
`;

/**
 * This request's own origin with the `--base-path`-normalized prefix
 * appended - e.g. `https://centuryglass.us/babel-index/`. Used for anything
 * a link unfurler or crawler reads directly (og:url/og:image, robots.txt's
 * Sitemap line, every sitemap.xml url), since those never see `<base href>`.
 *
 * `req.protocol`/`req.get('host')` follow the same `trust proxy` setting
 * favorites' `req.ip` does: correct behind a reverse proxy only once
 * `--trust-proxy` is passed.
 */
export function requestOrigin(req: Request, base: string): string {
  return `${req.protocol}://${req.get('host')}${base}`;
}

/** `path` made absolute against `origin`, unless it already is one (remote-mode urls already are). */
function absoluteAsset(origin: string, path: string): string {
  return /^https?:\/\//.test(path) ? path : `${origin}${path}`;
}

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
  /** resolved config (see packages/config); the defaults when absent */
  config?: ResolvedConfig;
  /** the built client, fixed for the process's lifetime */
  bundleJs?: string;
  /** the built client, read on each request instead - how `watch` mode
   *  serves a bundle that gets rebuilt in place */
  getBundleJs?: () => string;
  /** read on each request, so editing the page needs no restart */
  readIndexHtml?: () => Promise<string>;
  /** read on each request, so editing a margin or a color needs no restart
   *  either - see packages/web/style.css, index.html's one stylesheet link */
  readStyleCss?: () => Promise<string>;
  /** dev convenience: serve the live-reload client and expose
   *  `app.locals.broadcastReload` for a rebuild to call */
  watch?: boolean;
  /** directory of app-level static assets (favicon, touch icon, manifest,
   *  OG/Twitter card image) - see packages/web/public. Not corpus content, so
   *  it is unrelated to imagesDir/sharedDir; served at the same root paths
   *  index.html's icon/manifest links use. Absent (the default in most
   *  tests) means none of those files exist and only the bare /favicon.ico
   *  204 below answers - same "no store, no feature" shape as `favorites`. */
  publicDir?: string | null;
  /** where the app is reverse-proxied to, e.g. '/babel-index/' (default '/').
   *  Every route below stays mounted at its own unprefixed path - see
   *  base-path.ts - this only sets the `<base href>` the served HTML carries,
   *  so the browser resolves this file's relative urls under the subpath. */
  basePath?: string;
  /** where global favorite counts live (see favorites.ts). Absent - the
   *  default, and every test that does not ask for it - means the favorite
   *  routes are not mounted at all and the client renders no favorite UI,
   *  rather than a count nothing can record. */
  favorites?: FavoriteStore | null;
  /** passed straight to Express's `trust proxy` setting. It has to be set for
   *  a deployment behind a reverse proxy, or `req.ip` is the proxy's own
   *  address - one hash for every visitor, and every favorite count capped at
   *  one. Default false: correct for a direct connection, which is what the
   *  demo is. See index.ts's `--trust-proxy`. */
  trustProxy?: string | number | boolean;
  /** the revision this process is running, reported by /api/health (see
   *  version.ts). Null - the default, and every test - means the server
   *  cannot name its own revision, which /api/health reports honestly rather
   *  than omitting. */
  commit?: string | null;
}

/** Build the app. */
export function createApp({
  manifest,
  imagesDir,
  sharedDir = imagesDir,
  config,
  bundleJs = '',
  getBundleJs,
  readIndexHtml,
  readStyleCss,
  watch = false,
  basePath = '/',
  favorites = null,
  trustProxy = false,
  publicDir = null,
  commit = null,
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
  const clipTextDtype = clientConfig.search.clipTextDtype;

  // Whether the client should offer favoriting at all. A flag rather than the
  // counts themselves: the manifest stays small (see the `metadata` note in
  // scanDirectory), and the counts are a second, cacheable thing that changes
  // on its own schedule.
  const favoritesInfo = favorites ? { enabled: true } : null;

  app.get('/api/manifest', (_req, res) =>
    res.json({ ...manifest, favorites: favoritesInfo, config: clientConfig })
  );

  /**
   * Liveness, for the deploy workflow to check a release against
   * (AGENTS.md, "Deploying to the VPS").
   *
   * `commit` is the reason this exists at all: a 200 from the old process
   * is indistinguishable from a 200 from the new one (see version.ts).
   * `rooms` is the second half - a corpus the scan came up empty on serves
   * a perfectly healthy library with nothing in it, which is what a wrong
   * --images path on a restarted unit looks like from outside.
   *
   * Everything here is already in memory, so the check cannot itself be
   * the thing that falls over under load. `no-store` because the point is
   * the current process's answer: a cache between here and the workflow
   * would report the revision that was running a minute ago.
   */
  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      commit,
      rooms: manifest.rooms.length,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // Which room files exist, for the favorite routes to validate against. Fixed
  // for the process's lifetime, like the manifest it reads: the corpus is
  // scanned once at startup (index.ts) and nothing re-reads it while serving.
  const roomFiles = new Set(manifest.rooms.map((room) => room.file));

  /**
   * Search.
   *
   * The server runs only the text tower: string -> 512-dim query vector.
   * Ranking lives in the browser (rankByEmbedding against embeddings.bin),
   * so a re-rank or a search-history restore costs no round trip and the
   * endpoint stays a stateless thing that could sit in front of a static
   * bundle.
   *
   * Two fallbacks return a deterministic pseudo-ranking instead, so the
   * mechanic - type a term, watch the library rearrange around the center -
   * survives without a model: no blob for this corpus, or the text tower
   * failing to load (offline with nothing cached). Both are labelled
   * `stub`, so the UI can say so rather than imply the order means
   * something.
   */
  app.get('/api/search', async (req, res) => {
    const q = String(req.query.q ?? '')
      .trim()
      .slice(0, clientConfig.search.maxQueryLength);
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
      // The note reaching the browser omits local paths and stack traces;
      // the operator's copy, with those, goes to the logger.
      logger.error({ err, query: q }, 'CLIP text-tower inference failed');
      // No model installed at all is a permanent fact about this machine;
      // anything else is a load that may yet succeed.
      const note = hasTextModel()
        ? `the CLIP text model failed to load: ${err?.message ?? err}`
        : 'no CLIP text model installed - ranking by keywords and story only';
      res.json({ stub: true, query: q, order: stubRanking(manifest.rooms, q), note });
    }
  });

  /**
   * Favorites.
   *
   * Three routes, mounted only when a store exists (what is recorded, and
   * why it is a set rather than a counter, is favorites.ts and AGENTS.md's
   * "Favorites"):
   *
   *   GET    /api/favorites        every room with at least one, by file
   *   POST   /api/favorites/:file  this visitor favorites the room
   *   DELETE /api/favorites/:file  they stop
   *
   * No route answers "have I favorited this": a reader's own list lives in
   * their browser (`persist.ts`) and the server never assembles a
   * per-visitor view. The writes carry no body, so no body parser is
   * mounted; the room is named in the path and validated against the
   * corpus, which is also what keeps an arbitrary string out of the store.
   *
   * Identity and throttling sit on different keys (AGENTS.md,
   * "Favorite writes are rate-limited by `req.ip`"):
   * `X-Favorite-Client` - a token the browser generates once, see
   * `useFavorites.ts` - decides whose favorite a write records; the rate
   * bucket below, keyed on the address, decides how fast a write can come.
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
      const clientId = req.get('X-Favorite-Client') ?? '';
      if (!CLIENT_ID_PATTERN.test(clientId))
        return res.status(400).json({ error: 'missing or invalid client id' });
      // req.ip is undefined only for a socket that has already gone away.
      const ip = req.ip ?? '';
      if (!favoriteBuckets.take(ip))
        return res.status(429).json({ error: 'too many favorites at once - try again in a moment' });
      const count = favorites[method](file, clientId);
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

  // App-level static assets (favicon, touch icon, manifest, OG/Twitter card
  // image) - see packages/web/public. `express.static` 404s through to the
  // fallback below rather than intercepting anything else mounted here, since
  // none of app.ts's other routes share a name with a file in that directory.
  if (publicDir) app.use(express.static(publicDir, { maxAge: '1h' }));

  // Without a publicDir there is no favicon.ico to serve - answer 204 rather
  // than let it 404 log on every load.
  app.get('/favicon.ico', (_req, res) => res.status(204).end());

  app.get('/bundle.js', (_req, res) => {
    res.type('application/javascript').send(getBundleJs ? getBundleJs() : bundleJs);
  });

  // Plain CSS, not part of the esbuild bundle - re-read on each request like
  // index.html below, so a margin or color tweak needs no restart.
  if (readStyleCss)
    app.get('/style.css', async (_req, res, next) => {
      try {
        res.type('css').send(await readStyleCss());
      } catch (err) {
        next(err);
      }
    });

  /**
   * Renders `index.html` for any of this app's HTML routes - `/` plain, and
   * the SSR catalog/room pages below. One implementation so `<base href>`
   * injection, the og:/twitter: absolute-url fill-in, and live-reload stay
   * in one place regardless of which route is served.
   *
   * `canonicalPath` is the relative-to-base suffix of the page actually
   * being served (`''` for `/`, `'catalog'`, `'catalog/<slug>'`, ...) -
   * callers already know it, so this doesn't re-derive it from `req`.
   * `bodyHtml`/`initialRoute` are what makes a route more than `/`: real
   * content inside `#root` for crawlers/no-JS, and a hint for `main.tsx` to
   * boot straight into the matching interactive view once JS runs (see
   * index.html's own comment on `%%SSR_BODY%%`/`%%INITIAL_ROUTE_SCRIPT%%`).
   */
  const renderPage = async (
    req: Request,
    res: Response,
    next: NextFunction,
    {
      title,
      description,
      ogImagePath,
      canonicalPath,
      bodyHtml = '',
      initialRoute = null,
      status = 200,
    }: {
      title: string;
      description: string;
      ogImagePath: string;
      canonicalPath: string;
      bodyHtml?: string;
      initialRoute?: { mode: 'catalog'; room?: string } | { mode: 'help' } | { mode: 'about' } | null;
      status?: number;
    }
  ) => {
    if (!readIndexHtml) return res.status(404).end();
    try {
      let html = await readIndexHtml();
      // Must land before any relative url the page itself contains
      // (bundle.js's script tag, any future stylesheet/icon link) - `<base
      // href>` only affects resolution for markup that follows it.
      html = html.replace('<head>', `<head>\n    <base href="${base}">`);
      const origin = requestOrigin(req, base);
      // A room filename containing `</script>` (unlikely but not impossible)
      // would close this tag early. JSON.stringify escapes quotes and
      // backslashes but leaves `<` alone, so `<` is written as `<` -
      // the only character here that can affect HTML parsing.
      const routeScript = initialRoute
        ? `<script>window.__INITIAL_ROUTE__ = ${JSON.stringify(initialRoute).replace(/</g, '\\u003c')};</script>`
        : '';
      // Global replaces: every occurrence of a placeholder name is
      // substituted, wherever it sits - a mention inside one of index.html's
      // comments would be rewritten just like a real tag, which is why those
      // comments avoid spelling the names out.
      html = html
        .replace(/%%TITLE%%/g, escapeHtml(title))
        .replace(/%%DESCRIPTION%%/g, escapeHtml(description))
        .replace(/%%CANONICAL_URL%%/g, `${origin}${canonicalPath}`)
        .replace(/%%OG_IMAGE_URL%%/g, absoluteAsset(origin, ogImagePath))
        .replace(/%%SSR_BODY%%/g, bodyHtml)
        .replace(/%%INITIAL_ROUTE_SCRIPT%%/g, routeScript);
      if (watch) html = html.replace('</body>', `${LIVE_RELOAD_TAG}</body>`);
      res.status(status).type('html').send(html);
    } catch (err) {
      next(err);
    }
  };

  const DEFAULT_TITLE = 'The Index of Babel';
  const DEFAULT_DESCRIPTION =
    'A pannable, zoomable map of AI-generated library rooms, loosely based on the Library of Babel.';

  if (readIndexHtml) {
    app.get('/', (req, res, next) =>
      renderPage(req, res, next, {
        title: DEFAULT_TITLE,
        description: DEFAULT_DESCRIPTION,
        ogImagePath: 'og-image.jpg',
        canonicalPath: '',
      })
    );

    /**
     * The SSR catalog list: real, crawlable per-room links and content in
     * `order` - packages/web/src/lib/catalog.ts's own alphabetical idle
     * order; nothing here searches server-side. Paginated with the same
     * `config.catalog.perPage` the client uses.
     *
     * `?page=` is 1-based on this public url; `pageOf`'s own contract is
     * 0-based, so the conversion happens right here rather than leaking a
     * public url convention into that pure module.
     */
    app.get('/catalog', async (req, res, next) => {
      try {
        const pageNum = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
        const { metadata, tagLinks, slugs } = await loadRoomContent(manifest, imagesDir ?? null);
        const order = alphabeticalOrder(manifest.rooms, metadata);
        const urlFor = createUrlFor(manifest);
        const perPage = clientConfig.catalog.perPage;
        const { title, description, bodyHtml } = renderCatalogList({
          rooms: manifest.rooms,
          metadata,
          tagLinks,
          slugs: slugs.slugs,
          order,
          page: pageNum - 1,
          perPage,
          urlFor,
          base,
        });
        await renderPage(req, res, next, {
          title,
          description,
          ogImagePath: 'og-image.jpg',
          canonicalPath: pageNum > 1 ? `catalog?page=${pageNum}` : 'catalog',
          bodyHtml,
          initialRoute: { mode: 'catalog' },
        });
      } catch (err) {
        next(err);
      }
    });

    /**
     * One room's permalink, keyed by its title (`packages/map/slug.ts`).
     *
     * A room answers to its filename stem as well, and anything but the
     * canonical slug redirects to it - so a retitled room's old links still
     * land, and a crawler is handed one url for one page.
     *
     * The lowercase retry is for a url that has been through something that
     * capitalises. Every slug in the table is already lowercase, so it can
     * only ever find the room the reader asked for, and the redirect then puts
     * them on its real url.
     */
    app.get('/catalog/:slug', async (req, res, next) => {
      try {
        const { metadata, tagLinks, slugs } = await loadRoomContent(manifest, imagesDir ?? null);
        const asked = req.params.slug;
        const id = slugs.lookup.get(asked) ?? slugs.lookup.get(asked.toLowerCase());
        if (id === undefined) {
          await renderPage(req, res, next, {
            title: `Room not found · ${DEFAULT_TITLE}`,
            description: 'No such room in this library.',
            ogImagePath: 'og-image.jpg',
            canonicalPath: roomPath(encodeURIComponent(asked)),
            bodyHtml: `<div class="ssr-page"><h1>No such room</h1><p><a href="${base}catalog">Back to the catalog</a></p></div>`,
            status: 404,
          });
          return;
        }
        if (asked !== slugs.slugs[id]) {
          // 302, not 301: a browser caches a permanent redirect forever, so a
          // retitled room would leave a reader's own cache sending them to a
          // url this corpus no longer has - the failure the stem alias exists
          // to prevent. Nothing on the site links a stem, and the sitemap
          // lists only canonical urls, so there is little for a crawler to
          // consolidate here anyway.
          //
          // `base` is the public prefix the proxy strips (AGENTS.md,
          // "Deployment and the base path"), so a root-absolute Location built
          // from it is what the browser needs: a Location resolves against the
          // request url, never against `<base href>`.
          res.redirect(302, `${base}${roomPath(slugs.slugs[id])}`);
          return;
        }
        const result = renderRoomPage({ rooms: manifest.rooms, metadata, tagLinks, id, base });
        await renderPage(req, res, next, {
          title: result.title,
          description: result.description,
          ogImagePath: result.ogImagePath,
          canonicalPath: roomPath(slugs.slugs[id]),
          bodyHtml: result.bodyHtml,
          // The filename, not the slug: it is what `main.tsx` matches a room
          // on, so translating here is what keeps the client from building a
          // second slug table to read its own url.
          initialRoute: { mode: 'catalog', room: manifest.rooms[id].file },
        });
      } catch (err) {
        next(err);
      }
    });

    /**
     * One-shot SSR-linkable routes for the two static dialogs reachable from
     * the center shelf - a no-JS/crawler-readable page plus an
     * `initialRoute` hint so `main.tsx` opens the matching dialog once JS
     * takes over (the same pattern as `/catalog` above, minimal bodyHtml
     * rather than real per-corpus SSR content since neither page has any).
     */
    app.get('/help', (req, res, next) => {
      const { title, description, bodyHtml } = renderHelpPage(base);
      renderPage(req, res, next, {
        title,
        description,
        ogImagePath: 'og-image.jpg',
        canonicalPath: 'help',
        bodyHtml,
        initialRoute: { mode: 'help' },
      });
    });

    app.get('/about', (req, res, next) => {
      const { title, description, bodyHtml } = renderAboutPage(base);
      renderPage(req, res, next, {
        title,
        description,
        ogImagePath: 'og-image.jpg',
        canonicalPath: 'about',
        bodyHtml,
        initialRoute: { mode: 'about' },
      });
    });
  }

  /**
   * The generated "equivalent code" easter egg the artist's statement links
   * onward to (`ArtistStatementOverlay`'s `.statement-link` -> `BabelBookOverlay`),
   * served as plain text for a reader who follows the link with no JS. Infinite,
   * generated content with nothing to index, so `robots.txt` disallows it below.
   */
  app.get('/babel-book', (_req, res) => {
    res.type('text/plain').send(generateRandomBookText());
  });

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(robotsTxt(requestOrigin(req, base)));
  });

  app.get('/sitemap.xml', async (req, res, next) => {
    try {
      // A room's url is built from its title, so this needs the metadata join
      // before it can name a single room.
      const { slugs } = await loadRoomContent(manifest, imagesDir ?? null);
      const pages = pageCount(manifest.rooms.length, clientConfig.catalog.perPage);
      res.type('application/xml').send(renderSitemap(requestOrigin(req, base), slugs.slugs, pages));
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
 * Whether the CLIP text tower can be loaded at all.
 *
 * `import.meta.resolve` asks the resolver where the package is without
 * executing a byte of it, so this is answerable at startup - which the lazy
 * `textTower()` is not, since loading the model is the expensive thing it
 * exists to defer.
 *
 * It matters because the package is optional. `onnxruntime-node`, which
 * transformers.js needs, publishes for win32/darwin/linux only; on anything
 * else (Android under Termux, say) npm refuses it. As a required dependency
 * that takes the whole install down with it; as an optional one it is
 * skipped, everything else installs, and the demo runs - ranking by
 * keywords and story instead of by CLIP. This is how the server says so at
 * startup rather than leaving it to be discovered on the first search.
 */
export function hasTextModel(): boolean {
  try {
    import.meta.resolve('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

// Module-level like `textTowerPromises` below: a warm cache is a resource of
// the process, not of one `createApp()` call, and tests build more than one
// app. The cache key folds in dtype (see the route above) so a config that
// loads a different precision never reads back vectors computed at another
// one. Capacity is a guess, not a measurement: repeat searches (history,
// re-searching the same term) are common enough for a small cache to pay for
// itself, and 512 floats per entry keeps 200 of them cheap to hold.
const EMBED_CACHE_SIZE = 200;
const embedCache = createLruCache(EMBED_CACHE_SIZE);

// Bounds how many CLIP text-tower inferences run at once. Sized to the CPU
// like any other CPU-bound worker pool: past that many threads are fighting
// for the same cores rather than doing useful work, so a burst of distinct
// queries degrades to queueing latency instead of thrashing the machine.
//
// Queueing is otherwise invisible server-side - throughput pins at the cap
// and only latency shows it. Logging here, throttled, means a real traffic
// spike leaves a trace in the journal.
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

/**
 * Load the CLIP text tower once, lazily.
 *
 * A dynamic `import` so the heavy dependency is pulled only when a real
 * search actually runs - the stub path, and every test that never sets up a
 * blob, stay free of it. The promise is memoised, so concurrent first
 * requests share one load rather than racing two model downloads.
 */
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
 * What a `X-Favorite-Client` header must look like to be trusted as a
 * favorites identity: long enough to carry real randomness (a UUID is 36
 * chars), short enough that a header full of garbage cannot bloat the HMAC
 * input `favorites.ts` builds.
 */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Token buckets for the favorite writes, one per address.
 *
 * Keyed on `req.ip` by its caller, not on `X-Favorite-Client`: a client id is
 * free to mint, so bucketing on it would let a script spend a fresh burst on
 * every request by sending a new one (AGENTS.md, "Favorites"). This bounds
 * how fast one connection makes the process hash things - the set semantics
 * in favorites.ts, not this, cap what any client can do to a count. In memory
 * and never persisted: a restart forgets everyone, and no record of who
 * asked for what is kept.
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
