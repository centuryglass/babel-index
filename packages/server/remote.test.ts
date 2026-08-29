import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { scanRemote } from './remote.ts';
import type { Manifest } from '../map/manifest.ts';
import type { AddressInfo } from 'node:net';

/**
 * A throwaway HTTP server standing in for the bucket - just enough to answer
 * a manifest fetch, the way a public R2 bucket/CDN would.
 */
async function remoteHost(
  routes: Record<string, { body: Buffer | string; type?: string; status?: number }>,
  run: (base: string) => Promise<void>
) {
  const server = createServer((req, res) => {
    const entry = req.url ? routes[req.url] : undefined;
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(entry.status ?? 200, { 'content-type': entry.type ?? 'application/octet-stream' });
    res.end(entry.body);
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await run(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function sampleManifest(): Manifest {
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
    tagLinks: { url: '/images/tagLinks.json', count: 1 },
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
      assert.equal(manifest.tagLinks.url, `${base}/corpus-sample/tagLinks.json`);
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

test('a sheet-packed level round-trips through rebase untouched - it carries no url of its own', async () => {
  // rebase() only rewrites literal stored urls (rooms/shared/embeddings/...).
  // A sheet-packed level's `sheet.dir` is a bare relative path, addressed the
  // same formula-based way `dir` always has been, resolved client-side against
  // the already-rebased `imagesBase` - so this must survive verbatim.
  const manifest = sampleManifest();
  manifest.levels.push({
    level: 2,
    w: 256,
    h: 192,
    dir: null,
    sheet: { tileW: 256, tileH: 192, cols: 16, rows: 16, roomsPerSheet: 256, sheetCount: 1, dir: '256-sheets', ext: 'jpg' },
  });

  await remoteHost(
    { '/corpus-sample/manifest.json': { body: JSON.stringify(manifest), type: 'application/json' } },
    async (base) => {
      const remote = await scanRemote(base, 'corpus-sample');
      const level2 = remote.levels.find((l) => l.level === 2);
      assert.ok(level2);
      assert.deepEqual(level2.sheet, manifest.levels[1].sheet, 'sheet geometry must pass through unchanged');
      assert.ok(level2.sheet);
      // The only thing that changed is imagesBase, which the client combines
      // with sheet.dir itself - proving the full url a room resolves to.
      assert.equal(`${remote.imagesBase}/${level2.sheet.dir}/sheet-0000.jpg`, `${base}/corpus-sample/256-sheets/sheet-0000.jpg`);
    }
  );
});
