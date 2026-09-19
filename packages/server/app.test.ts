import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { connect } from 'node:net';
import { createApp, stubRanking, hasTextModel, createRateBuckets } from './app.ts';
import { createJsonFavoriteStore, type FavoriteStore } from './favorites.ts';
import { hashPassword } from './admin-auth.ts';
import type { CreateAppOptions } from './app.ts';
import { scanDirectory } from './scan.ts';
import { DEFAULTS, resolveConfig } from '../config/config.ts';
import * as fixture from './image-fixtures.ts';
import type { AddressInfo } from 'node:net';

/**
 * Bring up the real app on an ephemeral port against a throwaway corpus.
 * No browser and no bundler: the endpoints are the thing under test.
 */
async function serving(
  run: (ctx: { base: string; dir: string; port: number; get: (p: string, init?: RequestInit) => Promise<Response> }) => Promise<void>,
  { files, ...opts }: { files?: Record<string, Buffer | string> } & Partial<CreateAppOptions> = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'babel-api-'));
  const contents = files ?? {
    'center.png': fixture.png(1024, 1024),
    '001.jpg': fixture.jpeg(512, 512),
    '002.jpg': fixture.jpeg(512, 512),
    '003.png': fixture.png(256, 256),
  };
  for (const [name, body] of Object.entries(contents)) await writeFile(join(dir, name), body);

  const app = createApp({
    manifest: await scanDirectory(dir),
    imagesDir: dir,
    bundleJs: 'console.log("bundle")',
    ...opts,
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Accepts both an Express-route path ('/api/manifest') and a manifest
    // url (relative, no leading slash, since app.ts's urls resolve against
    // <base href> in the browser - see base-path.ts) without the caller
    // having to know which kind it was handed.
    return await run({ base, dir, port, get: (p, init) => fetch(`${base}/${p.replace(/^\//, '')}`, init) });
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Send a request path exactly as written.
 *
 * `fetch` normalises `..` out of a URL before it reaches the wire, so it
 * cannot express the attack this is checking for.
 */
function rawGet(port: number, path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let body = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => (body += d));
    sock.on('error', reject);
    sock.on('end', () => resolve({ status: Number(body.slice(9, 12)), text: body }));
  });
}

// --- health -----------------------------------------------------------------

test('/api/health reports the revision it was given, and the corpus it found', async () => {
  await serving(
    async ({ get }) => {
      const res = await get('/api/health');
      assert.equal(res.status, 200);
      // no-store is what makes the deploy check meaningful: a cached answer
      // could report the previous revision (see app.ts's /api/health).
      assert.match(res.headers.get('cache-control'), /no-store/);

      const health = await res.json();
      assert.equal(health.ok, true);
      assert.equal(health.commit, 'f'.repeat(40));
      // The deploy script refuses a release that came up serving nothing, so
      // this has to be the real count rather than a fixed truthy value.
      assert.equal(health.rooms, 3);
      assert.equal(typeof health.uptimeSeconds, 'number');
    },
    { commit: 'f'.repeat(40) }
  );
});

test('/api/health says so honestly when the revision is unknown', async () => {
  await serving(async ({ get }) => {
    const health = await (await get('/api/health')).json();
    // Null, not absent: the deploy workflow distinguishes "this server cannot
    // name its revision" from "this server is older than the field".
    assert.equal(health.ok, true);
    assert.equal(health.commit, null);
    assert.ok('commit' in health);
  });
});

// --- manifest ---------------------------------------------------------------

test('/api/manifest serves the scan', async () => {
  await serving(async ({ get }) => {
    const res = await get('/api/manifest');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);

    const m = await res.json();
    assert.equal(m.mode, 'offline');
    assert.equal(m.count, 3);
    assert.equal(m.rooms.length, 3);
    assert.equal(m.shared.center.file, 'center.png');
    // The client indexes `manifest.rooms` by the id the layout hands it, so
    // ids must be exactly the array positions.
    m.rooms.forEach((room, i) => {
      assert.equal(room.id, i);
      assert.ok(room.url.startsWith('images/'));
      assert.equal(typeof room.bytes, 'number');
    });
  });
});

test('/api/manifest carries the config, and never the operator notes', async () => {
  await serving(async ({ get }) => {
    const m = await (await get('/api/manifest')).json();
    // The client reads all three of these on its first render, so their absence
    // is not a degraded map, it is a crash.
    assert.ok(m.config.camera.minVisibleCells > 0);
    assert.ok(m.config.map.contentRatio > 0);
    assert.ok(m.config.search.weights.clip >= 0);
    // `notes` is for whoever started the server; shipping it would invite the
    // client to start caring what the config could not honour.
    assert.equal(m.config.notes, undefined);
    assert.equal(m.config.source, undefined);
  });
});

test('/api/manifest serves the defaults when the app was given no config', async () => {
  // index.ts always passes one, but app.ts is built to be usable without the
  // CLI, and a manifest with no config block would crash the client.
  await serving(async ({ get }) => {
    const m = await (await get('/api/manifest')).json();
    assert.equal(m.config.map.contentRatio, DEFAULTS.map.contentRatio);
  });
});

test('a narrowed config reaches the client narrowed', async () => {
  await serving(
    async ({ get }) => {
      const m = await (await get('/api/manifest')).json();
      assert.equal(m.config.camera.maxZoom, 120);
    },
    { config: resolveConfig({ camera: { maxZoom: 120 } }) }
  );
});

test('every url in the manifest actually serves', async () => {
  await serving(async ({ get }) => {
    const m = await (await get('/api/manifest')).json();
    for (const { url } of [...m.rooms, m.shared.center, ...m.shared.generic]) {
      const res = await get(url);
      assert.equal(res.status, 200, url);
      assert.ok((await res.arrayBuffer()).byteLength > 0, url);
    }
  });
});

test('shared tiles are served from a shared directory outside the corpus', async () => {
  // The demo shape: the rooms are one directory, the shared tiles another.
  const rootFiles = {
    'rooms/001.jpg': fixture.jpeg(512, 512),
    'rooms/002.jpg': fixture.jpeg(512, 512),
    'center_tile.png': fixture.png(1024, 768),
    'generic/v1.webp': fixture.webpVp8(1024, 768),
  };
  const root = await mkdtemp(join(tmpdir(), 'babel-shareddir-'));
  try {
    for (const [name, body] of Object.entries(rootFiles)) {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }
    const imagesDir = join(root, 'rooms');
    const app = createApp({
      manifest: await scanDirectory(imagesDir, { sharedDir: root }),
      imagesDir,
      sharedDir: root,
    });
    const server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const m = await (await fetch(`${origin}/api/manifest`)).json();
      assert.equal(m.count, 2, 'the shared tiles are not corpus rooms');
      assert.equal(m.shared.center.url, 'shared/center_tile.png');
      assert.deepEqual(m.shared.generic.map((v) => v.url), ['shared/generic/v1.webp']);
      for (const { url } of [m.shared.center, ...m.shared.generic]) {
        const res = await fetch(`${origin}/${url}`);
        assert.equal(res.status, 200, url);
        assert.ok((await res.arrayBuffer()).byteLength > 0, url);
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the metadata sidecar is advertised and actually serves', async () => {
  const sidecar = { '001.jpg': { keywords: ['brutalism'], story: 'A room of unread indices.' } };
  await serving(
    async ({ get }) => {
      const m = await (await get('/api/manifest')).json();
      assert.equal(m.metadata.matched, 1);

      // Advertising a url the static mount does not serve would leave the
      // client fetching a 404 forever and every room undescribed.
      const res = await get(m.metadata.url);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), sidecar);
    },
    {
      files: {
        'center.png': fixture.png(64, 64),
        '001.jpg': fixture.jpeg(64, 64),
        '002.jpg': fixture.jpeg(64, 64),
        'metadata.json': JSON.stringify(sidecar),
      },
    }
  );
});

test('tagLinks.json is advertised and actually serves', async () => {
  const tagLinks = { brutalism: 'https://en.wikipedia.org/wiki/Brutalist_architecture' };
  await serving(
    async ({ get }) => {
      const m = await (await get('/api/manifest')).json();
      assert.equal(m.tagLinks.count, 1);

      const res = await get(m.tagLinks.url);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), tagLinks);
    },
    {
      files: {
        'center.png': fixture.png(64, 64),
        '001.jpg': fixture.jpeg(64, 64),
        'tagLinks.json': JSON.stringify(tagLinks),
      },
    }
  );
});

// --- search -----------------------------------------------------------------

test('/api/search is deterministic for a query and different across queries', async () => {
  await serving(async ({ get }) => {
    const order = async (q) => (await (await get(`/api/search?q=${encodeURIComponent(q)}`)).json()).order;

    const first = await order('babel');
    assert.deepEqual(await order('babel'), first, 'searching twice must not reshuffle the library');
    assert.notDeepEqual(await order('borges'), first, 'a different query must move something');
  });
});

test('a search ranks every room exactly once', async () => {
  await serving(async ({ get }) => {
    const res = await (await get('/api/search?q=hexagon')).json();
    assert.equal(res.stub, true, 'the UI says so rather than implying the results mean anything');
    assert.equal(res.query, 'hexagon');
    assert.deepEqual([...res.order].sort((a, b) => a - b), [0, 1, 2]);
  });
});

test('an empty or whitespace query clears the order rather than ranking', async () => {
  await serving(async ({ get }) => {
    for (const q of ['', '%20%20', '%09']) {
      const res = await (await get(`/api/search?q=${q}`)).json();
      assert.equal(res.order, null, `q=${q}`);
      assert.equal(res.query, '');
    }
    // No parameter at all behaves the same way.
    assert.equal((await (await get('/api/search')).json()).order, null);
  });
});

test('search is trimmed, so a stray space is the same search', async () => {
  await serving(async ({ get }) => {
    const a = await (await get('/api/search?q=babel')).json();
    const b = await (await get('/api/search?q=%20babel%20')).json();
    assert.deepEqual(b.order, a.order);
    assert.equal(b.query, 'babel');
  });
});

test('a query over maxQueryLength is truncated server-side, not just in the browser', async () => {
  await serving(
    async ({ get }) => {
      const short = await (await get('/api/search?q=hexagonqq')).json();
      const long = await (await get('/api/search?q=hexagonqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')).json();
      assert.equal(short.query, 'hexagonqq');
      assert.equal(long.query, 'hexagonqq', 'a direct request past the client cap must still be sliced');
    },
    { config: resolveConfig({ search: { maxQueryLength: 9 } }) }
  );
});

test('the ranking survives corpus growth without depending on corpus size', async () => {
  // Ids are what the ranking is keyed on, so a room's score must not depend on
  // how many other rooms happen to be present.
  const rooms = (n) => Array.from({ length: n }, (_, id) => ({ id }));
  const small = stubRanking(rooms(10), 'babel');
  const large = stubRanking(rooms(200), 'babel');
  assert.deepEqual(large.filter((id) => id < 10), small);
});

test('the ranking is a permutation at every size, including the empty corpus', async () => {
  for (const n of [0, 1, 2, 500]) {
    const order = stubRanking(Array.from({ length: n }, (_, id) => ({ id })), 'x');
    assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i));
  }
});

test('queries that differ by one character produce different orders', async () => {
  const rooms = Array.from({ length: 64 }, (_, id) => ({ id }));
  const seen = new Set();
  for (const q of ['a', 'b', 'c', 'ab', 'ba', 'library', 'librarY'])
    seen.add(stubRanking(rooms, q).join(','));
  assert.equal(seen.size, 7, 'the hash is collapsing distinct queries');
});

// --- static images ----------------------------------------------------------

test('/images serves the corpus and 404s the rest', async () => {
  await serving(async ({ get }) => {
    const res = await get('/images/001.jpg');
    assert.equal(res.status, 200);
    assert.ok((await res.arrayBuffer()).byteLength > 0);
    assert.equal((await get('/images/nope.jpg')).status, 404);
  });
});

test('/images will not serve anything outside the images directory', async () => {
  const secret = 'sk-not-a-real-secret';
  await serving(
    async ({ port, dir }) => {
      // The file is real and one level up, so a successful escape is
      // unmistakable rather than indistinguishable from a 404.
      const parent = join(dir, '..');
      const name = `babel-escape-${process.pid}.txt`;
      await writeFile(join(parent, name), secret);
      try {
        for (const path of [
          `/images/../${name}`,
          `/images/..%2f${name}`,
          `/images/%2e%2e%2f${name}`,
          `/images/..%252f${name}`,
          `/images/....//${name}`,
          `/images/%2e%2e/%2e%2e/etc/passwd`,
          `/images/../../../../etc/passwd`,
        ]) {
          const res = await rawGet(port, path);
          assert.ok(res.status >= 300, `${path} served with ${res.status}`);
          assert.ok(!res.text.includes(secret), `${path} leaked a file outside the corpus`);
          assert.ok(!res.text.includes('root:'), `${path} leaked /etc/passwd`);
        }
      } finally {
        await rm(join(parent, name), { force: true });
      }
    },
    { files: { 'center.png': fixture.png(8, 8), '001.jpg': fixture.jpeg(8, 8) } }
  );
});

test('images are cached hard, since a room never changes under its name', async () => {
  await serving(async ({ get }) => {
    const cc = (await get('/images/001.jpg')).headers.get('cache-control');
    assert.match(cc, /max-age=3600/);
    assert.match(cc, /immutable/);
  });
});

// --- the page ---------------------------------------------------------------

test('/bundle.js is served as javascript, no-cache so a deploy is picked up on the next load', async () => {
  await serving(async ({ get }) => {
    const res = await get('/bundle.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.equal(await res.text(), 'console.log("bundle")');
    assert.match(res.headers.get('cache-control'), /no-cache/);
  });
});

test('/style.css is served as css, re-read each request so edits need no restart, no-cache for the same reason as /bundle.js', async () => {
  let reads = 0;
  await serving(
    async ({ get }) => {
      const res = await get('/style.css');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /css/);
      assert.equal(await res.text(), 'body { color: red; }');
      assert.match(res.headers.get('cache-control'), /no-cache/);
      await get('/style.css');
      assert.equal(reads, 2);
    },
    { readStyleCss: async () => (reads++, 'body { color: red; }') }
  );
});

test('/ serves the page, re-read each request so edits need no restart', async () => {
  let reads = 0;
  await serving(
    async ({ get }) => {
      const res = await get('/');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.match(await res.text(), /<canvas>/);
      await get('/');
      assert.equal(reads, 2);
    },
    { readIndexHtml: async () => (reads++, '<canvas></canvas>') }
  );
});

test('renderPage is no-cache, so a stale copy can never point a returning visitor at a bundle.js the server has moved past', async () => {
  await serving(
    async ({ get }) => {
      const res = await get('/');
      assert.match(res.headers.get('cache-control'), /no-cache/);
    },
    { readIndexHtml: async () => '<canvas></canvas>' }
  );
});

test('basePath defaults to "/" - no <base> tag lands to change existing behaviour', async () => {
  await serving(
    async ({ get }) => {
      const html = await (await get('/')).text();
      assert.match(html, /<base href="\/">/);
    },
    { readIndexHtml: async () => '<head></head><canvas></canvas>' }
  );
});

test('--base-path lands as <base href>, ahead of anything that resolves against it', async () => {
  await serving(
    async ({ get }) => {
      const html = await (await get('/')).text();
      // Express itself is still unprefixed (the VPS's nginx config strips the
      // prefix before this request arrives) - '/' is still the route that
      // answers. Only the tag changes.
      const headIndex = html.indexOf('<head>');
      const baseIndex = html.indexOf('<base href="/babel-index/">');
      assert.ok(baseIndex > headIndex, 'expected <base> right after <head>');
      assert.ok(baseIndex < html.indexOf('<script'), 'expected <base> before anything that resolves against it');
    },
    { basePath: '/babel-index/', readIndexHtml: async () => '<head></head><script src="bundle.js"></script>' }
  );
});

test('--base-path normalizes a bare name to a leading and trailing slash', async () => {
  await serving(
    async ({ get }) => {
      const html = await (await get('/')).text();
      assert.match(html, /<base href="\/babel-index\/">/);
    },
    { basePath: 'babel-index', readIndexHtml: async () => '<head></head>' }
  );
});

test('the favicon is answered rather than logged as a 404 on every load', async () => {
  await serving(async ({ get }) => {
    assert.equal((await get('/favicon.ico')).status, 204);
  });
});

test('publicDir serves the favicon and OG image instead of the bare 204', async () => {
  const publicDir = await mkdtemp(join(tmpdir(), 'babel-public-'));
  try {
    await writeFile(join(publicDir, 'favicon.ico'), Buffer.from([0, 1, 2]));
    await writeFile(join(publicDir, 'og-image.jpg'), Buffer.from([3, 4, 5]));
    await serving(
      async ({ get }) => {
        const favicon = await get('/favicon.ico');
        assert.equal(favicon.status, 200);
        assert.deepEqual([...new Uint8Array(await favicon.arrayBuffer())], [0, 1, 2]);
        assert.equal((await get('/og-image.jpg')).status, 200);
        // A file the directory doesn't have still falls through cleanly
        // rather than the static mount swallowing the request.
        assert.equal((await get('/site.webmanifest')).status, 404);
      },
      { publicDir }
    );
  } finally {
    await rm(publicDir, { recursive: true, force: true });
  }
});

test('the served index.html fills in an absolute og:image/og:url, since link unfurlers never see <base href>', async () => {
  await serving(
    async ({ get, port }) => {
      const html = await (await get('/')).text();
      assert.match(html, new RegExp(`<meta property="og:url" content="http://127\\.0\\.0\\.1:${port}/"`));
      assert.match(
        html,
        new RegExp(`<meta property="og:image" content="http://127\\.0\\.0\\.1:${port}/og-image\\.jpg"`)
      );
      assert.match(
        html,
        new RegExp(`<meta name="twitter:image" content="http://127\\.0\\.0\\.1:${port}/og-image\\.jpg"`)
      );
    },
    {
      readIndexHtml: async () =>
        '<head><meta property="og:url" content="%%CANONICAL_URL%%" /><meta property="og:image" content="%%OG_IMAGE_URL%%" /><meta name="twitter:image" content="%%OG_IMAGE_URL%%" /></head>',
    }
  );
});

// A minimal stand-in for the real index.html, carrying every placeholder
// app.ts's renderPage fills in - not the real file, since these tests care
// about the server-side substitution, not the real page's markup.
const SSR_INDEX_HTML =
  '<head><title>%%TITLE%%</title><meta name="description" content="%%DESCRIPTION%%" />' +
  '<meta property="og:url" content="%%CANONICAL_URL%%" /><meta property="og:image" content="%%OG_IMAGE_URL%%" />' +
  '%%NOSCRIPT_REDIRECT%%' +
  '</head><body><div id="root">%%SSR_BODY%%</div>%%INITIAL_ROUTE_SCRIPT%%</body>';

test('GET /catalog lists real room links and titles, alphabetically, with correct per-page canonical/og tags', async () => {
  await serving(
    async ({ get, port }) => {
      const res = await get('/catalog');
      assert.equal(res.status, 200);
      const html = await res.text();
      // No metadata in this corpus, so every room is addressed by its stem.
      assert.match(html, /href="\/catalog\/001"/);
      assert.match(html, /href="\/catalog\/002"/);
      assert.match(html, /href="\/catalog\/003"/);
      assert.doesNotMatch(html, /href="\/catalog\/00\d\.jpg"/, 'an image extension in a page url is a lie about what it serves');
      assert.match(html, new RegExp(`<meta property="og:url" content="http://127\\.0\\.0\\.1:${port}/catalog"`));
      assert.match(html, /window\.__INITIAL_ROUTE__ = \{"mode":"catalog"\}/);

      const page2 = await (await get('/catalog?page=2')).text();
      assert.match(page2, new RegExp(`content="http://127\\.0\\.0\\.1:${port}/catalog\\?page=2"`));
    },
    {
      files: {
        'center.png': fixture.png(1024, 1024),
        '001.jpg': fixture.jpeg(512, 512),
        '002.jpg': fixture.jpeg(512, 512),
        '003.jpg': fixture.jpeg(512, 512),
      },
      readIndexHtml: async () => SSR_INDEX_HTML,
    }
  );
});

test('GET /catalog/:slug is addressed by title, carries that room\'s content, and 404s an unknown slug', async () => {
  await serving(
    async ({ get, port }) => {
      const res = await get('/catalog/reading-room');
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /A quiet reading room\./);
      assert.match(html, /gothic/);
      assert.match(html, new RegExp(`content="http://127\\.0\\.0\\.1:${port}/images/001\\.jpg"`));
      assert.match(html, new RegExp(`<meta property="og:url" content="http://127\\.0\\.0\\.1:${port}/catalog/reading-room"`));
      // The client keys rooms by filename, so the route hands it that rather
      // than the slug it was reached by.
      assert.match(html, /window\.__INITIAL_ROUTE__ = \{"mode":"catalog","room":"001\.jpg"\}/);

      // An untitled room keeps its stem, and no url anywhere carries the
      // image extension.
      assert.equal((await get('/catalog/002')).status, 200);
      assert.equal((await get('/catalog/001.jpg')).status, 404);
      assert.equal((await get('/catalog/nope')).status, 404);
    },
    {
      files: {
        'center.png': fixture.png(1024, 1024),
        '001.jpg': fixture.jpeg(512, 512),
        '002.jpg': fixture.jpeg(512, 512),
        'metadata.json': JSON.stringify({
          '001.jpg': { title: 'Reading Room', keywords: [{ text: 'gothic', type: null }], story: 'A quiet reading room.' },
        }),
      },
      readIndexHtml: async () => SSR_INDEX_HTML,
    }
  );
});

test('GET /map/:slug serves the same room content, opens map mode, and no-JS-redirects to the catalog url', async () => {
  await serving(
    async ({ get, port }) => {
      const res = await get('/map/reading-room');
      assert.equal(res.status, 200);
      const html = await res.text();
      // Same crawlable content as /catalog/:slug - the two routes are the
      // same page, differing only in which mode a JS reader boots into.
      assert.match(html, /A quiet reading room\./);
      assert.match(html, /gothic/);
      assert.match(html, /window\.__INITIAL_ROUTE__ = \{"mode":"map","room":"001\.jpg"\}/);
      // og:url names this route's own url, same as every other SSR page -
      // a link unfurler reads the meta tags straight off this response
      // without ever running the noscript redirect below.
      assert.match(html, new RegExp(`<meta property="og:url" content="http://127\\.0\\.0\\.1:${port}/map/reading-room"`));
      // A no-JS visitor (or a crawler that never runs main.tsx) is bounced
      // to that same catalog url instead of being stranded on a page with
      // no way to browse onward.
      assert.match(html, /<noscript><meta http-equiv="refresh" content="0; url=\/catalog\/reading-room"><\/noscript>/);

      assert.equal((await get('/map/002')).status, 200);
      assert.equal((await get('/map/nope')).status, 404);
    },
    {
      files: {
        'center.png': fixture.png(1024, 1024),
        '001.jpg': fixture.jpeg(512, 512),
        '002.jpg': fixture.jpeg(512, 512),
        'metadata.json': JSON.stringify({
          '001.jpg': { title: 'Reading Room', keywords: [{ text: 'gothic', type: null }], story: 'A quiet reading room.' },
        }),
      },
      readIndexHtml: async () => SSR_INDEX_HTML,
    }
  );
});

test('a titled room\'s stem and a stale slug redirect and stay on the /map prefix they were asked on', async () => {
  await serving(
    async ({ get }) => {
      const res = await get('/map/001', { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/map/reading-room');
    },
    {
      files: {
        'center.png': fixture.png(1024, 1024),
        '001.jpg': fixture.jpeg(512, 512),
        'metadata.json': JSON.stringify({ '001.jpg': { title: 'Reading Room', keywords: [], story: null } }),
      },
      readIndexHtml: async () => SSR_INDEX_HTML,
    }
  );
});

test('a titled room\'s filename stem still resolves, redirecting to the title url', async () => {
  // The stability half of the permalink scheme: a title is corpus data and can
  // be rewritten, and the stem is what `scan.ts` reads off the directory.
  await serving(
    async ({ get }) => {
      const res = await get('/catalog/001', { redirect: 'manual' });
      assert.equal(res.status, 302, 'a permanent redirect would outlive the title it points at');
      assert.equal(res.headers.get('location'), '/catalog/reading-room');

      // Case is forgiven the same way, so a url that has been through
      // something that capitalises still lands.
      const shouted = await get('/catalog/Reading-Room', { redirect: 'manual' });
      assert.equal(shouted.status, 302);
      assert.equal(shouted.headers.get('location'), '/catalog/reading-room');
    },
    {
      files: {
        'center.png': fixture.png(1024, 1024),
        '001.jpg': fixture.jpeg(512, 512),
        'metadata.json': JSON.stringify({ '001.jpg': { title: 'Reading Room', keywords: [], story: null } }),
      },
      readIndexHtml: async () => SSR_INDEX_HTML,
    }
  );
});

test('GET /robots.txt and /sitemap.xml reference every room, and work even without readIndexHtml', async () => {
  await serving(async ({ get, port }) => {
    const robots = await get('/robots.txt');
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type'), /text\/plain/);
    const robotsText = await robots.text();
    assert.match(robotsText, new RegExp(`Sitemap: http://127\\.0\\.0\\.1:${port}/sitemap\\.xml`));
    // The generated /babel-book easter egg has nothing to index.
    assert.match(robotsText, /^Disallow: \/babel-book$/m);

    const sitemap = await get('/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type'), /application\/xml/);
    const xml = await sitemap.text();
    assert.match(xml, /<loc>[^<]*\/catalog\/001<\/loc>/);
    assert.match(xml, /<loc>[^<]*\/catalog\/002<\/loc>/);
    assert.match(xml, /<loc>[^<]*\/catalog\/003<\/loc>/);
  });
});

test('GET /help and /about are one-shot SSR-linkable, with an initialRoute hint for main.tsx', async () => {
  await serving(
    async ({ get }) => {
      const help = await get('/help');
      assert.equal(help.status, 200);
      const helpHtml = await help.text();
      assert.match(helpHtml, /<h1>Help<\/h1>/);
      // Real prose from HelpBody.tsx, not a second SSR-only copy of it.
      assert.match(helpHtml, /class="help-body"/);
      assert.match(helpHtml, /zoomable, pannable map of library/);
      assert.match(helpHtml, /window\.__INITIAL_ROUTE__ = \{"mode":"help"\}/);

      const about = await get('/about');
      assert.equal(about.status, 200);
      const aboutHtml = await about.text();
      assert.match(aboutHtml, /Artist/);
      // Real prose from ArtistStatementPages.tsx, not a second SSR-only copy.
      assert.match(aboutHtml, /class="book-page statement-page statement-story"/);
      assert.match(aboutHtml, /Library of Babel holds every possible arrangement/);
      // The live button becomes a plain link for a no-JS visitor, rather than
      // dropping the easter egg it opens.
      assert.match(aboutHtml, /<a class="statement-link" href="\/babel-book">Run the same thing here<\/a>/);
      assert.match(aboutHtml, /window\.__INITIAL_ROUTE__ = \{"mode":"about"\}/);
    },
    { readIndexHtml: async () => SSR_INDEX_HTML }
  );
});

test('GET /babel-book serves generated plain text, a fresh book on every request', async () => {
  await serving(async ({ get }) => {
    const res = await get('/babel-book');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const first = await res.text();
    assert.ok(first.length > 0);

    const second = await (await get('/babel-book')).text();
    assert.notEqual(first, second, 'each request generates its own random book');
  });
});

test('the optional CLIP model is reported, not assumed', () => {
  // `@huggingface/transformers` is optional, so the server has to be able to
  // say whether it is there; app.ts's `hasTextModel` carries the why.
  //
  // Resolution only: this must not load the package, or the check costs as
  // much as the thing it checks for.
  assert.equal(typeof hasTextModel(), 'boolean');

  // And it must agree with reality on whichever machine is running the suite,
  // rather than being a constant that happens to look right here.
  let resolvable = true;
  try {
    import.meta.resolve('@huggingface/transformers');
  } catch {
    resolvable = false;
  }
  assert.equal(hasTextModel(), resolvable);
});

test('a search still ranks when the text model cannot be loaded', async () => {
  // The degradation the optional dependency rests on: with no model the
  // server returns a stub order rather than a 500, and the browser still
  // ranks by keywords and story (see the /api/search doc in app.ts).
  await serving(async ({ get }) => {
    const res = await (await get('/api/search?q=gilt')).json();
    assert.equal(res.stub, true);
    assert.deepEqual([...res.order].sort((a, b) => a - b), [0, 1, 2]);
    // Whatever the note says, it must not paste a module resolution error - it
    // reaches the browser, and local filesystem paths have no business there.
    if (res.note) assert.ok(!/imported from|node_modules|ERR_MODULE_NOT_FOUND/.test(res.note), res.note);
  });
});

// --- favorites --------------------------------------------------------------

/** The store the favorite tests run against, in a throwaway directory. */
async function withStore(run: (store: FavoriteStore, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'babel-favapi-'));
  try {
    const path = join(dir, 'favorites.json');
    await run(await createJsonFavoriteStore({ path, flushMs: 0 }), path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the favorite routes are absent, and the manifest says so, with no store', async () => {
  await serving(async ({ base, get }) => {
    const manifest = await (await get('/api/manifest')).json();
    assert.equal(manifest.favorites, null);
    assert.equal((await fetch(`${base}/api/favorites`)).status, 404);
    assert.equal((await fetch(`${base}/api/favorites/001.jpg`, { method: 'POST' })).status, 404);
  });
});

/** A request carrying a valid `X-Favorite-Client` header. */
const asClient = (id: string) => ({ headers: { 'X-Favorite-Client': id } });

test('favoriting is a set membership, and the manifest advertises the feature', async () => {
  await withStore(async (favorites) => {
    await serving(
      async ({ base, get }) => {
        const manifest = await (await get('/api/manifest')).json();
        assert.deepEqual(manifest.favorites, { enabled: true });

        const post = () => fetch(`${base}/api/favorites/001.jpg`, { method: 'POST', ...asClient('client-aaaaaaaa') });
        assert.deepEqual(await (await post()).json(), { file: '001.jpg', count: 1, favorited: true });
        assert.deepEqual(await (await post()).json(), { file: '001.jpg', count: 1, favorited: true },
          'the same client id favoriting twice is still one favorite');

        const counts = await (await get('/api/favorites')).json();
        assert.deepEqual(counts, { counts: { '001.jpg': 1 } });

        const del = await fetch(`${base}/api/favorites/001.jpg`, { method: 'DELETE', ...asClient('client-aaaaaaaa') });
        assert.deepEqual(await del.json(), { file: '001.jpg', count: 0, favorited: false });
        assert.deepEqual(await (await get('/api/favorites')).json(), { counts: {} });
      },
      { favorites }
    );
  });
});

test('two client ids sharing one connection are two favorites, not one', async () => {
  await withStore(async (favorites) => {
    await serving(
      async ({ base, get }) => {
        await fetch(`${base}/api/favorites/001.jpg`, { method: 'POST', ...asClient('client-aaaaaaaa') });
        await fetch(`${base}/api/favorites/001.jpg`, { method: 'POST', ...asClient('client-bbbbbbbb') });
        assert.deepEqual(await (await get('/api/favorites')).json(), { counts: { '001.jpg': 2 } },
          'identity is the client id, not the address every request in this test shares');
      },
      { favorites }
    );
  });
});

test('a write with no client id, or one too short to trust, is rejected', async () => {
  await withStore(async (favorites) => {
    await serving(
      async ({ base, get }) => {
        assert.equal((await fetch(`${base}/api/favorites/001.jpg`, { method: 'POST' })).status, 400);
        assert.equal((await fetch(`${base}/api/favorites/001.jpg`, { method: 'POST', ...asClient('short') })).status, 400);
        assert.deepEqual(await (await get('/api/favorites')).json(), { counts: {} });
      },
      { favorites }
    );
  });
});

test('a room this corpus does not have cannot be favorited', async () => {
  await withStore(async (favorites) => {
    await serving(
      async ({ base, get }) => {
        const res = await fetch(`${base}/api/favorites/${encodeURIComponent('../../etc/passwd')}`, {
          method: 'POST',
          ...asClient('client-aaaaaaaa'),
        });
        assert.equal(res.status, 404);
        assert.deepEqual(await (await get('/api/favorites')).json(), { counts: {} });
      },
      { favorites }
    );
  });
});

test('the counts endpoint is never cached', async () => {
  await withStore(async (favorites) => {
    await serving(
      async ({ get }) => {
        assert.match((await get('/api/favorites')).headers.get('cache-control'), /no-store/);
      },
      { favorites }
    );
  });
});

test('a burst of writes is rate limited rather than served without end', async () => {
  const buckets = createRateBuckets({ burst: 2, refillMs: 60_000 });
  assert.equal(buckets.take('10.0.0.1'), true);
  assert.equal(buckets.take('10.0.0.1'), true);
  assert.equal(buckets.take('10.0.0.1'), false, 'the bucket is empty');
  assert.equal(buckets.take('10.0.0.2'), true, 'and it is per address');
});

// --- admin log viewer --------------------------------------------------------

/** A request carrying valid HTTP Basic Auth for the given plaintext password. */
const asAdmin = (password: string) => ({
  headers: { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` },
});

test('the log routes are absent with no logFile/adminPasswordHash configured', async () => {
  await serving(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/logs`)).status, 404);
    assert.equal((await fetch(`${base}/admin/logs`)).status, 404);
  });
});

test('the log routes stay unmounted with only one of logFile/adminPasswordHash set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'babel-logapi-'));
  try {
    const logFile = join(dir, 'server.log');
    await writeFile(logFile, '');
    await serving(async ({ base }) => assert.equal((await fetch(`${base}/api/logs`)).status, 404), { logFile });
    await serving(async ({ base }) => assert.equal((await fetch(`${base}/api/logs`)).status, 404), {
      adminPasswordHash: hashPassword('sesame'),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/api/logs requires auth, then returns parsed entries oldest first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'babel-logapi-'));
  try {
    const logFile = join(dir, 'server.log');
    await writeFile(
      logFile,
      JSON.stringify({ level: 30, msg: 'first', time: 1 }) + '\n' + JSON.stringify({ level: 50, msg: 'second', time: 2 }) + '\n'
    );
    await serving(
      async ({ base }) => {
        const noAuth = await fetch(`${base}/api/logs`);
        assert.equal(noAuth.status, 401);
        assert.match(noAuth.headers.get('www-authenticate') ?? '', /Basic/);

        const wrongAuth = await fetch(`${base}/api/logs`, asAdmin('wrong'));
        assert.equal(wrongAuth.status, 401);

        const res = await fetch(`${base}/api/logs`, asAdmin('sesame'));
        assert.equal(res.status, 200);
        assert.match(res.headers.get('cache-control') ?? '', /no-store/);
        const { entries } = await res.json();
        assert.deepEqual(
          entries.map((e: { msg?: string }) => e.msg),
          ['first', 'second']
        );
      },
      { logFile, adminPasswordHash: hashPassword('sesame') }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('/api/logs?minLevel filters, and /admin/logs renders the same entries as HTML', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'babel-logapi-'));
  try {
    const logFile = join(dir, 'server.log');
    await writeFile(
      logFile,
      JSON.stringify({ level: 30, msg: 'info line', time: 1 }) + '\n' + JSON.stringify({ level: 50, msg: 'error line', time: 2 }) + '\n'
    );
    await serving(
      async ({ base }) => {
        const filtered = await (await fetch(`${base}/api/logs?minLevel=50`, asAdmin('sesame'))).json();
        assert.deepEqual(
          filtered.entries.map((e: { msg?: string }) => e.msg),
          ['error line']
        );

        const page = await fetch(`${base}/admin/logs`, asAdmin('sesame'));
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type') ?? '', /html/);
        const html = await page.text();
        assert.ok(html.includes('info line'));
        assert.ok(html.includes('error line'));

        const fragment = await (await fetch(`${base}/admin/logs/fragment`, asAdmin('sesame'))).text();
        assert.ok(fragment.startsWith('<ul id="entries">'));
        assert.ok(fragment.includes('info line'));
      },
      { logFile, adminPasswordHash: hashPassword('sesame') }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
