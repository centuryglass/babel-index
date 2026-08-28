import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUploadList, diffAgainstManifest, guessContentType } from './lib.ts';

const join = (...parts) => parts.join('/');

function manifest() {
  return {
    rooms: [
      { id: 0, file: '001.jpg' },
      { id: 1, file: '002.jpg' },
    ],
    levels: [
      { level: 0, w: 1024, h: 1024, dir: null },
      { level: 1, w: 512, h: 512, dir: '512' },
    ],
    metadata: { url: '/images/metadata.json', matched: 2, entries: 2 },
    tagLinks: { url: '/images/tagLinks.json', count: 3 },
    embeddings: { url: '/images/embeddings.bin', dim: 512, count: 2, model: 'x' },
    shared: {
      center: { file: 'center_tile.png', url: '/shared/center_tile.png' },
      generic: [{ file: 'a.jpg', url: '/shared/generic/a.jpg' }],
    },
  };
}

test('buildUploadList covers rooms at every non-zero level, sidecars, and shared assets', () => {
  const uploads = buildUploadList(manifest(), { imagesDir: 'corpus', sharedDir: 'assets', prefix: 'sample' }, join);
  const keys = uploads.map((u) => u.key).sort();
  assert.deepEqual(keys, [
    'sample/001.jpg',
    'sample/002.jpg',
    'sample/512/001.jpg',
    'sample/512/002.jpg',
    'sample/embeddings.bin',
    'sample/embeddings.json',
    'sample/metadata.json',
    'sample/tagLinks.json',
    'shared/center_tile.png',
    'shared/generic/a.jpg',
  ]);

  const level0 = uploads.find((u) => u.key === 'sample/001.jpg');
  assert.equal(level0.local, 'corpus/001.jpg');
  const level1 = uploads.find((u) => u.key === 'sample/512/001.jpg');
  assert.equal(level1.local, 'corpus/512/001.jpg');
});

test('buildUploadList omits metadata/embeddings/tagLinks/shared entries the manifest does not have', () => {
  const m = manifest();
  m.metadata = null;
  m.tagLinks = null;
  m.embeddings = null;
  m.shared = { center: null, generic: [] };
  const uploads = buildUploadList(m, { imagesDir: 'corpus', sharedDir: 'assets', prefix: 'sample' }, join);
  assert.deepEqual(
    uploads.map((u) => u.key).sort(),
    ['sample/001.jpg', 'sample/002.jpg', 'sample/512/001.jpg', 'sample/512/002.jpg']
  );
});

test('diffAgainstManifest uploads new and changed files, skips matching hashes', () => {
  const uploads = [
    { local: '/a', key: 'k/a' },
    { local: '/b', key: 'k/b' },
    { local: '/c', key: 'k/c' },
  ];
  const hashes = new Map([
    ['/a', 'hash-a'],
    ['/b', 'hash-b-new'],
    ['/c', 'hash-c'],
  ]);
  const remoteManifest = { 'k/a': 'hash-a', 'k/b': 'hash-b-old' }; // k/c never uploaded before

  const { toUpload, unchanged } = diffAgainstManifest(uploads, hashes, remoteManifest);
  assert.deepEqual(
    toUpload.map((u) => u.key).sort(),
    ['k/b', 'k/c']
  );
  assert.deepEqual(unchanged.map((u) => u.key), ['k/a']);
  assert.equal(toUpload.find((u) => u.key === 'k/b').hash, 'hash-b-new');
});

test('diffAgainstManifest treats an empty remote manifest as upload-everything', () => {
  const uploads = [{ local: '/a', key: 'k/a' }];
  const hashes = new Map([['/a', 'hash-a']]);
  const { toUpload, unchanged } = diffAgainstManifest(uploads, hashes, {});
  assert.equal(toUpload.length, 1);
  assert.equal(unchanged.length, 0);
});

test('guessContentType covers every extension this tool uploads', () => {
  assert.equal(guessContentType('sample/metadata.json'), 'application/json');
  assert.equal(guessContentType('sample/embeddings.bin'), 'application/octet-stream');
  assert.equal(guessContentType('shared/center_tile.png'), 'image/png');
  assert.equal(guessContentType('shared/generic/a.webp'), 'image/webp');
  assert.equal(guessContentType('sample/001.jpg'), 'image/jpeg');
});
