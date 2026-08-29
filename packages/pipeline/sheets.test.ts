import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { sheetPlan, sheetPosition, sheetDirName, sheetFileName, writeSheets } from './sheets.ts';

async function makeImage(path: string, w: number, h: number, background = { r: 40, g: 34, b: 28 }) {
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background } })
    .jpeg()
    .toBuffer();
  await writeFile(path, buf);
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'sheets-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CONFIG = { roomsPerSheet: 4, cols: 2, rows: 2 };

// --- the plan ----------------------------------------------------------------

test('sheetCount covers the corpus, rounding up', () => {
  assert.equal(sheetPlan(0, CONFIG).sheetCount, 0);
  assert.equal(sheetPlan(4, CONFIG).sheetCount, 1);
  assert.equal(sheetPlan(5, CONFIG).sheetCount, 2);
  assert.equal(sheetPlan(8, CONFIG).sheetCount, 2);
  assert.equal(sheetPlan(9, CONFIG).sheetCount, 3);
});

test('a grid that cannot hold roomsPerSheet fails loudly', () => {
  assert.throws(() => sheetPlan(10, { roomsPerSheet: 4, cols: 3, rows: 1 }));
});

test('sheetPosition walks the grid row by row, wrapping into the next sheet', () => {
  assert.deepEqual(sheetPosition(0, CONFIG), { sheetIndex: 0, col: 0, row: 0 });
  assert.deepEqual(sheetPosition(1, CONFIG), { sheetIndex: 0, col: 1, row: 0 });
  assert.deepEqual(sheetPosition(2, CONFIG), { sheetIndex: 0, col: 0, row: 1 });
  assert.deepEqual(sheetPosition(3, CONFIG), { sheetIndex: 0, col: 1, row: 1 });
  assert.deepEqual(sheetPosition(4, CONFIG), { sheetIndex: 1, col: 0, row: 0 });
});

test('every room index maps into exactly one cell, no overlaps', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 37; i++) {
    const { sheetIndex, col, row } = sheetPosition(i, CONFIG);
    const key = `${sheetIndex}:${col}:${row}`;
    assert.ok(!seen.has(key), `room ${i} collides with an earlier room at ${key}`);
    seen.add(key);
  }
});

test('directory and file naming', () => {
  assert.equal(sheetDirName(256), '256-sheets');
  assert.equal(sheetFileName(0), 'sheet-0000.jpg');
  assert.equal(sheetFileName(12), 'sheet-0012.jpg');
});

// --- writing -------------------------------------------------------------

test('writes one sheet per roomsPerSheet rooms, at the packed grid size', async () => {
  await withTempDir(async (dir) => {
    const levelDir = join(dir, '64');
    await mkdir(levelDir, { recursive: true });
    const files = ['000.jpg', '001.jpg', '002.jpg', '003.jpg', '004.jpg'];
    for (const f of files) await makeImage(join(levelDir, f), 64, 48);

    const result = await writeSheets({ levelDir, files, tileSize: { w: 64, h: 48 }, plan: CONFIG });
    assert.equal(result.sheetCount, 2);
    assert.equal(result.written, 2);
    assert.equal(result.cached, 0);

    const sheetDir = levelDir + '-sheets';
    const meta0 = await sharp(join(sheetDir, 'sheet-0000.jpg')).metadata();
    assert.equal(meta0.width, 128); // 2 cols * 64
    assert.equal(meta0.height, 96); // 2 rows * 48
  });
});

test('a second run against unchanged tiles recomposites nothing', async () => {
  await withTempDir(async (dir) => {
    const levelDir = join(dir, '64');
    await mkdir(levelDir, { recursive: true });
    const files = ['000.jpg', '001.jpg', '002.jpg', '003.jpg'];
    for (const f of files) await makeImage(join(levelDir, f), 64, 48);

    const first = await writeSheets({ levelDir, files, tileSize: { w: 64, h: 48 }, plan: CONFIG });
    const second = await writeSheets({ levelDir, files, tileSize: { w: 64, h: 48 }, plan: CONFIG });

    assert.equal(first.written, 1);
    assert.equal(second.written, 0);
    assert.equal(second.cached, 1);
  });
});

test('changing one member tile invalidates only the sheet it belongs to', async () => {
  await withTempDir(async (dir) => {
    const levelDir = join(dir, '64');
    await mkdir(levelDir, { recursive: true });
    const files = ['000.jpg', '001.jpg', '002.jpg', '003.jpg', '004.jpg', '005.jpg'];
    for (const f of files) await makeImage(join(levelDir, f), 64, 48);
    await writeSheets({ levelDir, files, tileSize: { w: 64, h: 48 }, plan: CONFIG });

    // Only member 004.jpg (sheet 1) changes.
    await makeImage(join(levelDir, '004.jpg'), 64, 48, { r: 200, g: 10, b: 10 });
    const second = await writeSheets({ levelDir, files, tileSize: { w: 64, h: 48 }, plan: CONFIG });

    assert.equal(second.written, 1, 'only the sheet containing the changed tile is rebuilt');
    assert.equal(second.cached, 1, 'the untouched sheet is left alone');
  });
});

test('the hashes sidecar records one combined hash per sheet', async () => {
  await withTempDir(async (dir) => {
    const levelDir = join(dir, '64');
    await mkdir(levelDir, { recursive: true });
    const files = ['000.jpg', '001.jpg', '002.jpg', '003.jpg'];
    for (const f of files) await makeImage(join(levelDir, f), 64, 48);
    await writeSheets({ levelDir, files, tileSize: { w: 64, h: 48 }, plan: CONFIG });

    const hashes = JSON.parse(await readFile(join(levelDir + '-sheets', 'hashes.json'), 'utf8'));
    assert.deepEqual(Object.keys(hashes), ['0']);
    assert.match(hashes['0'], /^[0-9a-f]{64}$/);
  });
});

test('a partial final sheet is still written, holding fewer rooms', async () => {
  await withTempDir(async (dir) => {
    const levelDir = join(dir, '64');
    await mkdir(levelDir, { recursive: true });
    const files = ['000.jpg', '001.jpg', '002.jpg'];
    for (const f of files) await makeImage(join(levelDir, f), 64, 48);

    const result = await writeSheets({ levelDir, files, tileSize: { w: 64, h: 48 }, plan: CONFIG });
    assert.equal(result.sheetCount, 1);
    assert.equal(result.written, 1);
  });
});
