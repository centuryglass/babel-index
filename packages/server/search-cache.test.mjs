import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLruCache, createLimiter } from './search-cache.mjs';

// --- createLruCache -----------------------------------------------------

test('a miss returns undefined', () => {
  const cache = createLruCache(2);
  assert.equal(cache.get('nope'), undefined);
});

test('a stored value round-trips', () => {
  const cache = createLruCache(2);
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.size, 1);
});

test('evicts the least recently used entry once over capacity', () => {
  const cache = createLruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3); // 'a' is oldest and unread since - evicted
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});

test('reading an entry counts as using it, so it survives the next eviction', () => {
  const cache = createLruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // 'a' is now the most recently used
  cache.set('c', 3); // 'b' is oldest now - evicted, not 'a'
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('re-setting an existing key refreshes its recency without growing the cache', () => {
  const cache = createLruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 10); // 'a' is most recent again
  cache.set('c', 3); // 'b' is oldest - evicted
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), 10);
  assert.equal(cache.get('b'), undefined);
});

test('a capacity of 1 keeps only the last write', () => {
  const cache = createLruCache(1);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
});

test('rejects a capacity under 1', () => {
  assert.throws(() => createLruCache(0), RangeError);
  assert.throws(() => createLruCache(-1), RangeError);
});

// --- createLimiter -------------------------------------------------------

test('runs jobs immediately while under the concurrency cap', async () => {
  const run = createLimiter(2);
  let active = 0;
  let peak = 0;
  const job = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return 'done';
  };
  const results = await Promise.all([run(job), run(job)]);
  assert.deepEqual(results, ['done', 'done']);
  assert.equal(peak, 2);
});

test('queues jobs past the concurrency cap rather than running them all at once', async () => {
  const run = createLimiter(2);
  let active = 0;
  let peak = 0;
  const job = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
  };
  await Promise.all([run(job), run(job), run(job), run(job), run(job)]);
  assert.equal(peak, 2, 'never more than the cap ran at once');
});

test('a rejection frees the slot for the next queued job', async () => {
  const run = createLimiter(1);
  const failing = run(() => Promise.reject(new Error('boom')));
  const succeeding = run(() => Promise.resolve('ok'));
  await assert.rejects(failing, /boom/);
  assert.equal(await succeeding, 'ok', 'the failure must not wedge the queue');
});

test('results are returned to the caller that queued them, not mixed up', async () => {
  const run = createLimiter(1);
  const results = await Promise.all([1, 2, 3, 4].map((n) => run(() => Promise.resolve(n * 10))));
  assert.deepEqual(results, [10, 20, 30, 40]);
});

test('rejects a concurrency cap under 1', () => {
  assert.throws(() => createLimiter(0), RangeError);
});
