import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { scanRemote } from './remote.ts';

/**
 * A throwaway HTTP server standing in for the bucket - just enough to answer
 * a manifest fetch, the way a public R2 bucket/CDN would.
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
    imagesBase: '/images',
    sharedBase: '/shared',
    shared: { center: { file: 'center.png', url: '/shared/center.png' }, generic: [{ file: 'g1.png', url: '/shared/generic/g1.png' }] },
    rooms: [{ id: 0, file: '001.jpg', url: '/images/001.jpg', bytes: 42, w: 512, h: 512 }],
    count: 1,
    embeddings: { url: '/images/embeddings.bin', dim: 512, count: 1, model: 'x' },
    metadata: { url: '/images/metadata.json', matched: 1, entries: 1 },
    levels: [{ level: 0, w: 512, h: 512, dir: null }],
  };
}

test('scanRemote fetches the manifest.json a corpus was uploaded with', async () => {
  await remoteHost(
    { '/corpus-sample/manifest.json': { body: JSON.stringify(sampleManifest()), type: 'application/json' } },
    async (base) => {
      const manifest = await scanRemote(base, 'corpus-sample');
      assert.equal(manifest.mode, 'remote');
      assert.equal(manifest.source, `${base}/corpus-sample/manifest.json`);
      assert.equal(manifest.count, 1);
      // The local scan's own bookkeeping (where it ran, offline) is not a fact
      // about how it's being served now.
      assert.equal(manifest.directory, undefined);
    }
  );
});

test('scanRemote points every url directly at the remote host, not through this server', async () => {
  await remoteHost(
    { '/corpus-sample/manifest.json': { body: JSON.stringify(sampleManifest()), type: 'application/json' } },
    async (base) => {
      const manifest = await scanRemote(base, 'corpus-sample');
      assert.equal(manifest.imagesBase, `${base}/corpus-sample`);
      assert.equal(manifest.sharedBase, `${base}/shared`);
      assert.equal(manifest.rooms[0].url, `${base}/corpus-sample/001.jpg`);
      assert.equal(manifest.embeddings.url, `${base}/corpus-sample/embeddings.bin`);
      assert.equal(manifest.metadata.url, `${base}/corpus-sample/metadata.json`);
      assert.equal(manifest.shared.center.url, `${base}/shared/center.png`);
      assert.equal(manifest.shared.generic[0].url, `${base}/shared/generic/g1.png`);
    }
  );
});

test('scanRemote tolerates a trailing slash on the base url', async () => {
  await remoteHost(
    { '/corpus-sample/manifest.json': { body: JSON.stringify(sampleManifest()), type: 'application/json' } },
    async (base) => {
      const manifest = await scanRemote(`${base}/`, 'corpus-sample');
      assert.equal(manifest.count, 1);
      assert.equal(manifest.rooms[0].url, `${base}/corpus-sample/001.jpg`);
    }
  );
});

test('scanRemote raises a clear error when the manifest is missing', async () => {
  await remoteHost({}, async (base) => {
    await assert.rejects(() => scanRemote(base, 'corpus-sample'), /404/);
  });
});
