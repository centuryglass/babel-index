import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { loadRoomContent, MISSING_ALT_LISTED } from './roomContent.ts';
import { logger } from './logger.ts';
import type { Manifest } from '../map/manifest.ts';
import type { AddressInfo } from 'node:net';

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    mode: 'offline',
    imagesBase: 'images',
    sharedBase: 'shared',
    shared: {
      center: null, generic: [], genericDistill: [],
      levels: [{ level: 0, dir: null }], distillLevels: [{ level: 0, dir: null }],
      favoriteLevels: [{ level: 0, dir: null }],
    },
    rooms: [
      { id: 0, file: 'a.jpg', url: 'images/a.jpg', bytes: 1 },
      { id: 1, file: 'b.jpg', url: 'images/b.jpg', bytes: 1 },
    ],
    count: 2,
    embeddings: null,
    metadata: null,
    tagLinks: null,
    levels: [{ level: 0, w: null, h: null, dir: null }],
    ...overrides,
  };
}

test('local mode reads metadata.json/tagLinks.json off imagesDir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'babel-room-content-'));
  try {
    await writeFile(join(dir, 'metadata.json'), JSON.stringify({ 'a.jpg': { title: 'Alpha', story: 'A story.' } }));
    await writeFile(join(dir, 'tagLinks.json'), JSON.stringify({ gothic: 'https://example.com/gothic' }));
    const manifest = baseManifest({
      metadata: { url: 'images/metadata.json', matched: 1, entries: 1 },
      tagLinks: { url: 'images/tagLinks.json', count: 1 },
    });

    const { metadata, tagLinks } = await loadRoomContent(manifest, dir);
    assert.equal(metadata[0]?.title, 'Alpha');
    assert.equal(metadata[1], null);
    assert.deepEqual(tagLinks, { gothic: 'https://example.com/gothic' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a manifest with no metadata/tagLinks entry loads neither, without touching disk', async () => {
  const manifest = baseManifest();
  const { metadata, tagLinks } = await loadRoomContent(manifest, '/does/not/exist');
  assert.deepEqual(metadata, [null, null]);
  assert.equal(tagLinks, null);
});

test('a load is memoized per manifest - a second call does not re-read the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'babel-room-content-'));
  try {
    await writeFile(join(dir, 'metadata.json'), JSON.stringify({ 'a.jpg': { title: 'Alpha' } }));
    const manifest = baseManifest({ metadata: { url: 'images/metadata.json', matched: 1, entries: 1 } });

    const first = await loadRoomContent(manifest, dir);
    // Mutate the file on disk - if the loader re-read, the second call would see it.
    await writeFile(join(dir, 'metadata.json'), JSON.stringify({ 'a.jpg': { title: 'Changed' } }));
    const second = await loadRoomContent(manifest, dir);
    assert.strictEqual(first, second);
    assert.equal(second.metadata[0]?.title, 'Alpha');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('remote mode fetches the manifest\'s absolute urls instead of reading a directory', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/metadata.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ 'a.jpg': { title: 'Remote Alpha' } }));
      return;
    }
    if (req.url === '/tagLinks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ gothic: 'https://example.com/gothic' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const manifest = baseManifest({
      mode: 'remote',
      metadata: { url: `${base}/metadata.json`, matched: 1, entries: 1 },
      tagLinks: { url: `${base}/tagLinks.json`, count: 1 },
    });

    const { metadata, tagLinks } = await loadRoomContent(manifest, null);
    assert.equal(metadata[0]?.title, 'Remote Alpha');
    assert.deepEqual(tagLinks, { gothic: 'https://example.com/gothic' });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a malformed or unreachable sidecar is tolerated, not thrown', async () => {
  const manifest = baseManifest({
    metadata: { url: 'images/metadata.json', matched: 0, entries: 0 },
    tagLinks: { url: 'images/tagLinks.json', count: 0 },
  });
  // No such directory at all - readFile rejects for both files.
  const { metadata, tagLinks } = await loadRoomContent(manifest, '/definitely/does/not/exist');
  assert.deepEqual(metadata, [null, null]);
  assert.equal(tagLinks, null);
});

test('rooms with no alt text are named in one warning, whether their entry lacks alt or they have no entry', async (t) => {
  const warn = t.mock.method(logger, 'warn', (_obj: unknown, _msg?: string) => {});
  const dir = await mkdtemp(join(tmpdir(), 'babel-room-content-'));
  try {
    await writeFile(
      join(dir, 'metadata.json'),
      JSON.stringify({ 'a.jpg': { title: 'Alpha', alt: 'A shelved wall.' }, 'b.jpg': { title: 'Beta' } })
    );
    const shared = baseManifest().shared;
    const manifest = baseManifest({
      rooms: [
        { id: 0, file: 'a.jpg', url: 'images/a.jpg', bytes: 1 },
        { id: 1, file: 'b.jpg', url: 'images/b.jpg', bytes: 1 },
        { id: 2, file: 'c.jpg', url: 'images/c.jpg', bytes: 1 },
      ],
      count: 3,
      // The shared tiles have no alt text either, but they are not rooms.
      shared: {
        ...shared,
        center: { file: 'center_tile.jpg', url: 'shared/center_tile.jpg' },
        generic: [{ file: 'generic1.jpg', url: 'shared/generic/generic1.jpg' }],
      },
      metadata: { url: 'images/metadata.json', matched: 2, entries: 2 },
    });

    await loadRoomContent(manifest, dir);
    await loadRoomContent(manifest, dir);
    assert.equal(warn.mock.callCount(), 1, 'a memoized second load says nothing');
    assert.deepEqual(warn.mock.calls[0].arguments[0], { missing: 2, files: ['b.jpg', 'c.jpg'] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corpus whose every room has alt text warns about nothing', async (t) => {
  const warn = t.mock.method(logger, 'warn', (_obj: unknown, _msg?: string) => {});
  const dir = await mkdtemp(join(tmpdir(), 'babel-room-content-'));
  try {
    await writeFile(
      join(dir, 'metadata.json'),
      JSON.stringify({ 'a.jpg': { title: 'Alpha', alt: 'A shelved wall.' }, 'b.jpg': { title: 'Beta', alt: 'Another.' } })
    );
    const manifest = baseManifest({ metadata: { url: 'images/metadata.json', matched: 2, entries: 2 } });

    await loadRoomContent(manifest, dir);
    assert.equal(warn.mock.callCount(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the missing-alt warning counts every room but lists only the first MISSING_ALT_LISTED', async (t) => {
  const warn = t.mock.method(logger, 'warn', (_obj: unknown, _msg?: string) => {});
  const files = Array.from({ length: MISSING_ALT_LISTED + 5 }, (_, i) => `${String(i).padStart(3, '0')}.jpg`);
  // No sidecar at all, so no room has alt text.
  const manifest = baseManifest({
    rooms: files.map((file, id) => ({ id, file, url: `images/${file}`, bytes: 1 })),
    count: files.length,
  });

  await loadRoomContent(manifest, '/does/not/exist');
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(warn.mock.calls[0].arguments[0], { missing: files.length, files: files.slice(0, MISSING_ALT_LISTED) });
});
