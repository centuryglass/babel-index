import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { createApp, stubRanking } from './app.mjs';
import { scanDirectory } from './scan.mjs';
import { DEFAULTS, resolveConfig } from '../config/config.mjs';
import * as fixture from './image-fixtures.mjs';

/**
 * Bring up the real app on an ephemeral port against a throwaway corpus.
 * No browser and no bundler: the endpoints are the thing under test.
 */
async function serving(run, { files, ...opts } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'babel-api-'));
  const contents = files ?? {
    'base.png': fixture.png(1024, 1024),
    '001.jpg': fixture.jpeg(512, 512),
    '002.jpg': fixture.jpeg(512, 512),
    '003.png': fixture.png(256, 256),
  };
  for (const [name, body] of Object.entries(contents)) await writeFile(join(dir, name), body);

  const app = createApp({
    manifest: await scanDirectory(dir),
    imagesDir: dir,
    rescan: () => scanDirectory(dir),
    bundleJs: 'console.log("bundle")',
    ...opts,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    return await run({ base, dir, port: server.address().port, get: (p) => fetch(base + p) });
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
function rawGet(port, path) {
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
    assert.equal(m.generic.file, 'base.png');
    // The client indexes `manifest.rooms` by the id the layout hands it, so
    // ids must be exactly the array positions.
    m.rooms.forEach((room, i) => {
      assert.equal(room.id, i);
      assert.ok(room.url.startsWith('/images/'));
      assert.equal(typeof room.bytes, 'number');
    });
  });
});

test('/api/manifest carries the config, and never the operator notes', async () => {
  await serving(async ({ get }) => {
    const m = await (await get('/api/manifest')).json();
    // The client reads all three of these on its first render, so their absence
    // is not a degraded map, it is a crash.
    assert.ok(m.config.camera.defaultZoom > 0);
    assert.ok(m.config.map.contentRatio > 0);
    assert.ok(m.config.search.weights.clip >= 0);
    // `notes` is for whoever started the server; shipping it would invite the
    // client to start caring what the config could not honour.
    assert.equal(m.config.notes, undefined);
    assert.equal(m.config.source, undefined);
  });
});

test('/api/manifest serves the defaults when the app was given no config', async () => {
  // index.mjs always passes one, but app.mjs is built to be usable without the
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
      assert.equal(m.config.camera.defaultZoom, 120, 'the opening zoom came with it');
    },
    { config: resolveConfig({ camera: { maxZoom: 120 } }) }
  );
});

test('every url in the manifest actually serves', async () => {
  await serving(async ({ get }) => {
    const m = await (await get('/api/manifest')).json();
    for (const { url } of [...m.rooms, m.generic]) {
      const res = await get(url);
      assert.equal(res.status, 200, url);
      assert.ok((await res.arrayBuffer()).byteLength > 0, url);
    }
  });
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
        'base.png': fixture.png(64, 64),
        '001.jpg': fixture.jpeg(64, 64),
        '002.jpg': fixture.jpeg(64, 64),
        'metadata.json': JSON.stringify(sidecar),
      },
    }
  );
});

test('/api/rescan picks up new rooms', async () => {
  await serving(async ({ get, dir, base }) => {
    await writeFile(join(dir, '004.jpg'), fixture.jpeg(64, 64));
    const res = await fetch(`${base}/api/rescan`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { count: 4 });

    const m = await (await get('/api/manifest')).json();
    assert.equal(m.count, 4, 'the manifest must reflect the rescan, not the startup scan');
  });
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
    { files: { 'base.png': fixture.png(8, 8), '001.jpg': fixture.jpeg(8, 8) } }
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

test('/bundle.js is served as javascript', async () => {
  await serving(async ({ get }) => {
    const res = await get('/bundle.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.equal(await res.text(), 'console.log("bundle")');
  });
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

test('the favicon is answered rather than logged as a 404 on every load', async () => {
  await serving(async ({ get }) => {
    assert.equal((await get('/favicon.ico')).status, 204);
  });
});
