import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUploadList, crossOriginFetchedKeys, diffAgainstManifest, guessContentType } from './lib.ts';
import type { Manifest } from '../../packages/map/manifest.ts';
import type { AnimationManifest } from '../center-animation/lib.ts';

const join = (...parts: string[]) => parts.join('/');

function animation(): AnimationManifest {
  const cycle = (name: string) => ({
    name,
    sheet: `sheets/${name}.png`,
    frames: 7,
    columns: 3,
    rows: 3,
    frameWidth: 64,
    frameHeight: 90,
    rect: { x: 0.5, y: 0.5, w: 0.06, h: 0.11 },
  });
  return { frameDurationMs: 100, tile: { w: 1024, h: 768 }, cycles: [cycle('center_0'), cycle('center_1')] };
}

function manifest(): Manifest {
  return {
    mode: 'offline',
    imagesBase: 'images',
    sharedBase: 'shared',
    count: 2,
    rooms: [
      { id: 0, file: '001.jpg', url: 'images/001.jpg', bytes: 0 },
      { id: 1, file: '002.jpg', url: 'images/002.jpg', bytes: 0 },
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
    'shared/clear_history_book.png',
    'shared/distill_off.png',
    'shared/distill_on.png',
    'shared/fav_center_switch_base.png',
    'shared/fav_count_on.png',
    'shared/fav_mine_on.png',
    'shared/fav_off.png',
    'shared/fav_on.png',
    'shared/generic/a.jpg',
  ]);

  const level0 = uploads.find((u) => u.key === 'sample/001.jpg');
  assert.equal(level0.local, 'corpus/001.jpg');
  const level1 = uploads.find((u) => u.key === 'sample/512/001.jpg');
  assert.equal(level1.local, 'corpus/512/001.jpg');
});

test('buildUploadList uploads one entry per sheet file for a sheet-packed level, not per room', () => {
  const m = manifest();
  m.levels.push({
    level: 2,
    w: 256,
    h: 192,
    dir: null,
    sheet: { tileW: 256, tileH: 192, cols: 2, rows: 1, roomsPerSheet: 2, sheetCount: 1, dir: '256-sheets', ext: 'jpg' },
  });
  const uploads = buildUploadList(m, { imagesDir: 'corpus', sharedDir: 'assets', prefix: 'sample' }, join);
  const keys = uploads.map((u) => u.key).sort();
  assert.ok(keys.includes('sample/256-sheets/sheet-0000.jpg'));
  assert.ok(!keys.some((k) => k.includes('/256/')), 'a sheet-packed level never uploads per-room files');

  const sheet = uploads.find((u) => u.key === 'sample/256-sheets/sheet-0000.jpg');
  assert.equal(sheet.local, 'corpus/256-sheets/sheet-0000.jpg');
});

test('buildUploadList omits metadata/embeddings/tagLinks/shared entries the manifest does not have, but always uploads the fixed favorite badge, distill toggle, and clear-history book art', () => {
  const m = manifest();
  m.metadata = null;
  m.tagLinks = null;
  m.embeddings = null;
  m.shared = { center: null, generic: [] };
  const uploads = buildUploadList(m, { imagesDir: 'corpus', sharedDir: 'assets', prefix: 'sample' }, join);
  assert.deepEqual(
    uploads.map((u) => u.key).sort(),
    [
      'sample/001.jpg',
      'sample/002.jpg',
      'sample/512/001.jpg',
      'sample/512/002.jpg',
      'shared/clear_history_book.png',
      'shared/distill_off.png',
      'shared/distill_on.png',
      'shared/fav_center_switch_base.png',
      'shared/fav_count_on.png',
      'shared/fav_mine_on.png',
      'shared/fav_off.png',
      'shared/fav_on.png',
    ]
  );
});

test('buildUploadList uploads the loading-animation manifest and one entry per sheet when the caller found one', () => {
  const uploads = buildUploadList(
    manifest(),
    { imagesDir: 'corpus', sharedDir: 'assets', prefix: 'sample', animation: animation() },
    join
  );
  const byKey = new Map(uploads.map((u) => [u.key, u.local]));
  assert.equal(byKey.get('shared/animation/manifest.json'), 'assets/animation/manifest.json');
  assert.equal(byKey.get('shared/animation/sheets/center_0.png'), 'assets/animation/sheets/center_0.png');
  assert.equal(byKey.get('shared/animation/sheets/center_1.png'), 'assets/animation/sheets/center_1.png');
});

test('buildUploadList uploads no animation entries when the caller found no manifest', () => {
  const uploads = buildUploadList(
    manifest(),
    { imagesDir: 'corpus', sharedDir: 'assets', prefix: 'sample', animation: null },
    join
  );
  assert.ok(!uploads.some((u) => u.key.startsWith('shared/animation/')));
});

test('diffAgainstManifest uploads new and changed files, skips matching hashes present in the bucket', () => {
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
  const existingKeys = new Set(['k/a', 'k/b']);

  const { toUpload, unchanged } = diffAgainstManifest(uploads, hashes, remoteManifest, existingKeys);
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
  const { toUpload, unchanged } = diffAgainstManifest(uploads, hashes, {}, new Set<string>());
  assert.equal(toUpload.length, 1);
  assert.equal(unchanged.length, 0);
});

test('diffAgainstManifest re-uploads a key whose hash matches but is missing from the live bucket listing', () => {
  const uploads = [{ local: '/a', key: 'k/a' }];
  const hashes = new Map([['/a', 'hash-a']]);
  const remoteManifest = { 'k/a': 'hash-a' }; // recorded as uploaded before...
  const existingKeys = new Set<string>(); // ...but not actually present in the bucket (deleted, or lost)

  const { toUpload, unchanged } = diffAgainstManifest(uploads, hashes, remoteManifest, existingKeys);
  assert.deepEqual(
    toUpload.map((u) => u.key),
    ['k/a']
  );
  assert.equal(unchanged.length, 0);
});

test('crossOriginFetchedKeys lists the fetch()-read sidecars, omitting what the manifest lacks', () => {
  assert.deepEqual(crossOriginFetchedKeys(manifest(), 'sample').sort(), [
    'sample/embeddings.bin',
    'sample/embeddings.json',
    'sample/metadata.json',
    'sample/tagLinks.json',
  ]);

  const m = manifest();
  m.metadata = null;
  m.tagLinks = null;
  m.embeddings = null;
  assert.deepEqual(crossOriginFetchedKeys(m, 'sample'), []);
});

test('crossOriginFetchedKeys includes the animation manifest and sheets, which are fetch()-read too', () => {
  assert.deepEqual(crossOriginFetchedKeys(manifest(), 'sample', animation()).sort(), [
    'sample/embeddings.bin',
    'sample/embeddings.json',
    'sample/metadata.json',
    'sample/tagLinks.json',
    'shared/animation/manifest.json',
    'shared/animation/sheets/center_0.png',
    'shared/animation/sheets/center_1.png',
  ]);
});

test('guessContentType covers every extension this tool uploads', () => {
  assert.equal(guessContentType('sample/metadata.json'), 'application/json');
  assert.equal(guessContentType('sample/embeddings.bin'), 'application/octet-stream');
  assert.equal(guessContentType('shared/center_tile.png'), 'image/png');
  assert.equal(guessContentType('shared/generic/a.webp'), 'image/webp');
  assert.equal(guessContentType('sample/001.jpg'), 'image/jpeg');
});
