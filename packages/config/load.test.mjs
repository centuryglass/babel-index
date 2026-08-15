import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './load.mjs';
import { DEFAULTS } from './config.mjs';

/** A throwaway directory with the given files, cleaned up afterwards. */
async function withFiles(files, run) {
  const dir = await mkdtemp(join(tmpdir(), 'babel-config-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('no config file is the normal case, and says nothing', async () => {
  await withFiles({}, async (dir) => {
    const c = await loadConfig({ path: join(dir, 'absent.json') });
    // Asked for by name, so its absence is worth one line - but it still loads.
    assert.equal(c.source, null);
    assert.equal(c.map.contentRatio, DEFAULTS.map.contentRatio);
    assert.match(c.notes.join('\n'), /no such config file/);
  });
});

test('a partial overlay changes only what it names', async () => {
  await withFiles({ 'config.json': JSON.stringify({ map: { contentRatio: 0.5 } }) }, async (dir) => {
    const c = await loadConfig({ path: join(dir, 'config.json') });
    assert.equal(c.map.contentRatio, 0.5);
    assert.equal(c.map.slotSeed, DEFAULTS.map.slotSeed, 'untouched keys keep their defaults');
    assert.equal(c.search.weights.keyword, DEFAULTS.search.weights.keyword);
    assert.deepEqual(c.notes, []);
    assert.equal(c.source, join(dir, 'config.json'));
  });
});

test('a malformed config file is reported, not swallowed', async () => {
  // The failure that matters: a file that exists, was meant to take effect, and
  // did not. Falling back silently would leave the reader tuning a dead file.
  await withFiles({ 'config.json': '{ not json' }, async (dir) => {
    const c = await loadConfig({ path: join(dir, 'config.json') });
    assert.equal(c.source, null);
    assert.equal(c.map.contentRatio, DEFAULTS.map.contentRatio);
    assert.match(c.notes.join('\n'), /could not read/);
  });
});

test('validation notes survive the trip through the loader', async () => {
  await withFiles({ 'config.json': JSON.stringify({ camera: { minZoom: 0 } }) }, async (dir) => {
    const c = await loadConfig({ path: join(dir, 'config.json') });
    assert.match(c.notes.join('\n'), /widens the range/);
  });
});
