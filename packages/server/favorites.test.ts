import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonFavoriteStore } from './favorites.ts';

/** A throwaway snapshot path, cleaned up after `run`. */
async function inTmp(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'babel-fav-'));
  try {
    await run(join(dir, 'favorites.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a favorite is a set membership, so adding twice counts once', async () => {
  await inTmp(async (path) => {
    const store = await createJsonFavoriteStore({ path });
    assert.equal(store.add('001.jpg', '10.0.0.1'), 1);
    assert.equal(store.add('001.jpg', '10.0.0.1'), 1);
    assert.equal(store.add('001.jpg', '10.0.0.2'), 2);
    assert.deepEqual(store.counts(), { '001.jpg': 2 });
  });
});

test('removing is the same set operation, and an unknown favorite is a no-op', async () => {
  await inTmp(async (path) => {
    const store = await createJsonFavoriteStore({ path });
    store.add('001.jpg', '10.0.0.1');
    store.add('001.jpg', '10.0.0.2');
    assert.equal(store.remove('001.jpg', '10.0.0.1'), 1);
    assert.equal(store.remove('001.jpg', '10.0.0.1'), 1, 'removing what is not there changes nothing');
    assert.equal(store.remove('002.jpg', '10.0.0.1'), 0, 'a room nobody has favorited');
    assert.equal(store.remove('001.jpg', '10.0.0.2'), 0);
    assert.deepEqual(store.counts(), {}, 'an emptied room is absent, not zero');
  });
});

test('counts survive a restart, and the file holds hashes rather than addresses', async () => {
  await inTmp(async (path) => {
    const store = await createJsonFavoriteStore({ path, flushMs: 0 });
    store.add('001.jpg', '198.51.100.7');
    store.add('002.jpg', '198.51.100.7');
    await store.flush();

    const raw = await readFile(path, 'utf8');
    assert.ok(!raw.includes('198.51.100.7'), 'no raw address reaches the snapshot');

    const reopened = await createJsonFavoriteStore({ path });
    assert.deepEqual(reopened.counts(), { '001.jpg': 1, '002.jpg': 1 });
    // The salt persisted too, or this would record a second, different hash.
    assert.equal(reopened.add('001.jpg', '198.51.100.7'), 1);
  });
});

test('one visitor hashes differently in every room, so two rooms cannot be joined', async () => {
  await inTmp(async (path) => {
    const store = await createJsonFavoriteStore({ path, flushMs: 0 });
    store.add('001.jpg', '10.0.0.1');
    store.add('002.jpg', '10.0.0.1');
    await store.flush();

    const { rooms } = JSON.parse(await readFile(path, 'utf8'));
    assert.notEqual(rooms['001.jpg'][0], rooms['002.jpg'][0]);
  });
});

test('two stores do not share a salt, so a snapshot is only meaningful with its own file', async () => {
  await inTmp(async (a) => {
    await inTmp(async (b) => {
      const one = await createJsonFavoriteStore({ path: a, flushMs: 0 });
      const two = await createJsonFavoriteStore({ path: b, flushMs: 0 });
      one.add('001.jpg', '10.0.0.1');
      two.add('001.jpg', '10.0.0.1');
      await Promise.all([one.flush(), two.flush()]);
      const ha = JSON.parse(await readFile(a, 'utf8')).rooms['001.jpg'][0];
      const hb = JSON.parse(await readFile(b, 'utf8')).rooms['001.jpg'][0];
      assert.notEqual(ha, hb);
    });
  });
});

test('a file that exists but is not a snapshot throws rather than starting empty', async () => {
  await inTmp(async (path) => {
    await writeFile(path, '{"version":99,"rooms":{}}');
    await assert.rejects(() => createJsonFavoriteStore({ path }), /not a favorites snapshot/);
  });
});

test('flush is safe with nothing pending', async () => {
  await inTmp(async (path) => {
    const store = await createJsonFavoriteStore({ path });
    await store.flush();
    assert.deepEqual(store.counts(), {});
  });
});
