import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { scanRemote, mountProxy } from './remote.mjs';
import { createApp } from './app.mjs';
import * as fixture from './image-fixtures.mjs';

/**
 * A throwaway HTTP server standing in for the bucket - just enough to answer
 * GETs for a manifest and a few files, the way a public R2 bucket/CDN would.
 * @param {Record<string, {body: Buffer|string, type?: string, status?: number}>} routes
 */
async function remoteHost(routes, run) {
  const server = createServer((req, res) => {
    const entry = routes[req.url];
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(entry.status ?? 200, { 'content-type': entry.type ?? 'application/octet-stream' });
    res.end(entry.body);
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function sampleManifest() {
  return {
    mode: 'offline',
    directory: '/some/local/path',
    shared: { center: { file: 'center.png', url: '/shared/center.png' }, generic: [] },
    rooms: [{ id: 0, file: '001.jpg', url: '/images/001.jpg', bytes: 42, w: 512, h: 512 }],
    count: 1,
    embeddings: null,
    metadata: null,
    levels: [{ level: 0, w: 512, h: 512, dir: null }],
  };
}

// --- scanRemote ---------------------------------------------------------

test('scanRemote fetches the manifest.json a corpus was uploaded with', async () => {
  await remoteHost(
    { '/corpus-sample/manifest.json': { body: JSON.stringify(sampleManifest()), type: 'application/json' } },
    async (base) => {
      const manifest = await scanRemote(base, 'corpus-sample');
      assert.equal(manifest.mode, 'remote');
      assert.equal(manifest.source, `${base}/corpus-sample/manifest.json`);
      assert.equal(manifest.count, 1);
      assert.equal(manifest.rooms[0].url, '/images/001.jpg');
      // The local scan's own bookkeeping (where it ran, offline) is not a fact
      // about how it's being served now.
      assert.equal(manifest.directory, undefined);
    }
  );
});

test('scanRemote tolerates a trailing slash on the base url', async () => {
  await remoteHost(
    { '/corpus-sample/manifest.json': { body: JSON.stringify(sampleManifest()), type: 'application/json' } },
    async (base) => {
      const manifest = await scanRemote(`${base}/`, 'corpus-sample');
      assert.equal(manifest.count, 1);
    }
  );
});

test('scanRemote raises a clear error when the manifest is missing', async () => {
  await remoteHost({}, async (base) => {
    await assert.rejects(() => scanRemote(base, 'corpus-sample'), /404/);
  });
});

// --- mountProxy -----------------------------------------------------------

test('mountProxy streams a remote file through under the local mount path', async () => {
  const jpeg = fixture.jpeg(512, 512);
  await remoteHost(
    { '/corpus-sample/001.jpg': { body: jpeg, type: 'image/jpeg' } },
    async (base) => {
      const { default: express } = await import('express');
      const app = express();
      mountProxy(app, '/images', `${base}/corpus-sample`);
      const server = app.listen(0);
      await new Promise((r) => server.once('listening', r));
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/images/001.jpg`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /jpeg/);
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), jpeg);
      } finally {
        await new Promise((r) => server.close(r));
      }
    }
  );
});

test('mountProxy passes through a 404 for a file the remote does not have', async () => {
  await remoteHost({}, async (base) => {
    const { default: express } = await import('express');
    const app = express();
    mountProxy(app, '/images', `${base}/corpus-sample`);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/images/nope.jpg`);
      assert.equal(res.status, 404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

test('mountProxy refuses to forward a path-traversal segment', async () => {
  const { default: express } = await import('express');
  const app = express();
  mountProxy(app, '/images', 'https://assets.example.invalid/corpus-sample');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    for (const path of ['/images/../secret.txt', '/images/..%2fsecret.txt', '/images/%2e%2e/secret.txt']) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
      assert.ok(res.status >= 400, `${path} was not refused (${res.status})`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- end to end through createApp -----------------------------------------

test('a --remote-style app serves the manifest and proxies images/shared tiles', async () => {
  const jpeg = fixture.jpeg(512, 512);
  const png = fixture.png(1024, 1024);
  await remoteHost(
    {
      '/corpus-sample/001.jpg': { body: jpeg, type: 'image/jpeg' },
      '/shared/center.png': { body: png, type: 'image/png' },
    },
    async (base) => {
      const manifest = { ...sampleManifest(), mode: 'remote', source: `${base}/corpus-sample/manifest.json` };
      const app = createApp({
        manifest,
        remote: { imagesBase: `${base}/corpus-sample`, sharedBase: `${base}/shared` },
        rescan: async () => manifest,
        bundleJs: 'console.log("bundle")',
      });
      const server = app.listen(0);
      await new Promise((r) => server.once('listening', r));
      const origin = `http://127.0.0.1:${server.address().port}`;
      try {
        const m = await (await fetch(`${origin}/api/manifest`)).json();
        assert.equal(m.mode, 'remote');

        const room = await fetch(origin + m.rooms[0].url);
        assert.equal(room.status, 200);
        assert.deepEqual(Buffer.from(await room.arrayBuffer()), jpeg);

        const center = await fetch(origin + m.shared.center.url);
        assert.equal(center.status, 200);
        assert.deepEqual(Buffer.from(await center.arrayBuffer()), png);
      } finally {
        await new Promise((r) => server.close(r));
      }
    }
  );
});
