import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTileLocator, createUrlFor } from './rooms.ts';
import { CENTER, FAV_ON, FAV_OFF, genericId } from './tiles.ts';

function manifest(extraLevels: any[] = []): any {
  return {
    mode: 'offline',
    imagesBase: 'images',
    sharedBase: 'shared',
    shared: {
      center: { file: 'center.png', url: 'shared/center.png' },
      generic: [{ file: 'g1.png', url: 'shared/generic/g1.png' }],
    },
    rooms: [
      { id: 0, file: '001.jpg', url: 'images/001.jpg', bytes: 1 },
      { id: 1, file: '002.jpg', url: 'images/002.jpg', bytes: 1 },
      { id: 2, file: '003.jpg', url: 'images/003.jpg', bytes: 1 },
      { id: 3, file: '004.jpg', url: 'images/004.jpg', bytes: 1 },
      { id: 4, file: '005.jpg', url: 'images/005.jpg', bytes: 1 },
    ],
    count: 5,
    embeddings: null,
    metadata: null,
    tagLinks: null,
    levels: [
      { level: 0, dir: null },
      { level: 1, dir: '512' },
      ...extraLevels,
    ],
  };
}

const SHEET_LEVEL = {
  level: 2,
  dir: null,
  sheet: { tileW: 10, tileH: 8, cols: 2, rows: 2, roomsPerSheet: 4, sheetCount: 2, dir: '256-sheets', ext: 'jpg' },
};

// --- per-file levels ---------------------------------------------------------

test('a per-file level resolves to a bare url with no rect', () => {
  const locate = createTileLocator(manifest());
  assert.deepEqual(locate(0, 0), { url: 'images/001.jpg', rect: null });
  assert.deepEqual(locate(0, 1), { url: 'images/512/001.jpg', rect: null });
});

test('a level the corpus does not have resolves to null', () => {
  const locate = createTileLocator(manifest());
  assert.equal(locate(0, 2), null);
});

test('a room id the manifest does not have resolves to null', () => {
  const locate = createTileLocator(manifest());
  assert.equal(locate(99, 0), null);
});

// --- shared assets ------------------------------------------------------------

test('the center and generic tiles resolve flat, at level 0 only', () => {
  const locate = createTileLocator(manifest());
  assert.deepEqual(locate(CENTER, 0), { url: 'shared/center.png', rect: null });
  assert.equal(locate(CENTER, 1), null, 'shared tiles have no coarser levels yet');
  assert.deepEqual(locate(genericId(0), 0), { url: 'shared/generic/g1.png', rect: null });
});

test('the favorite badge faces resolve flat off sharedBase, even absent from manifest.shared', () => {
  // Fixed app art, not a scanned corpus asset - so unlike the center and the
  // generic tiles, there is nothing describing them in `manifest.shared`.
  const locate = createTileLocator(manifest());
  assert.deepEqual(locate(FAV_ON, 0), { url: 'shared/fav_on.png', rect: null });
  assert.deepEqual(locate(FAV_OFF, 0), { url: 'shared/fav_off.png', rect: null });
  assert.equal(locate(FAV_ON, 1), null, 'the badge has no coarser levels either');
});

// --- sheet-packed levels -----------------------------------------------------

test('a sheet-packed level resolves to the sheet url plus this room’s rect', () => {
  const locate = createTileLocator(manifest([SHEET_LEVEL]));
  assert.deepEqual(locate(0, 2), { url: 'images/256-sheets/sheet-0000.jpg', rect: { sx: 0, sy: 0, sw: 10, sh: 8 } });
  assert.deepEqual(locate(1, 2), { url: 'images/256-sheets/sheet-0000.jpg', rect: { sx: 10, sy: 0, sw: 10, sh: 8 } });
  assert.deepEqual(locate(2, 2), { url: 'images/256-sheets/sheet-0000.jpg', rect: { sx: 0, sy: 8, sw: 10, sh: 8 } });
});

test('a room past roomsPerSheet lands in the next sheet', () => {
  const locate = createTileLocator(manifest([SHEET_LEVEL]));
  assert.deepEqual(locate(4, 2), { url: 'images/256-sheets/sheet-0001.jpg', rect: { sx: 0, sy: 0, sw: 10, sh: 8 } });
});

test('a room id past what the sheet count actually covers resolves to null', () => {
  const locate = createTileLocator(manifest([{ ...SHEET_LEVEL, sheet: { ...SHEET_LEVEL.sheet, sheetCount: 1 } }]));
  assert.equal(locate(4, 2), null, 'sheet index 1 would be needed, but only sheet 0 exists');
});

// --- createUrlFor: the bare-url view for <img> callers -----------------------

test('createUrlFor matches createTileLocator for a per-file level', () => {
  const urlFor = createUrlFor(manifest());
  assert.equal(urlFor(0, 0), 'images/001.jpg');
  assert.equal(urlFor(0, 1), 'images/512/001.jpg');
});

test('createUrlFor resolves a sheet-packed level to null, not a misleading whole-sheet url', () => {
  // An <img> tag cannot address a source rect - a caller falling back to
  // another level (as the catalog already does) is the correct behaviour,
  // not drawing the wrong tile.
  const urlFor = createUrlFor(manifest([SHEET_LEVEL]));
  assert.equal(urlFor(0, 2), null);
});
