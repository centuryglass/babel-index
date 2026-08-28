import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, save, clear, KEYS } from './persist.ts';

/** A working store, so the happy path is not the only thing asserted. */
function memoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    size: () => map.size,
  };
}

/** Safari in private mode: reads work, writes throw. */
const writeThrows = () => ({
  getItem: () => null,
  setItem: () => {
    throw new DOMException('QuotaExceededError');
  },
  removeItem: () => {},
});

test('a value round-trips through a working store', () => {
  const store = memoryStore();
  assert.equal(save(KEYS.history, ['oak', 'gilt'], { store }), true);
  assert.deepEqual(load(KEYS.history, [], { store }), ['oak', 'gilt']);
  clear(KEYS.history, { store });
  assert.deepEqual(load(KEYS.history, ['fallback'], { store }), ['fallback']);
});

test('no storage at all is not an error - the fallback is the answer', () => {
  assert.deepEqual(load(KEYS.paging, 'scroll', { store: null }), 'scroll');
  assert.equal(save(KEYS.paging, 'pages', { store: null }), false);
  assert.equal(clear(KEYS.paging, { store: null }), false);
});

test('a store that throws on write drops the value rather than the caller', () => {
  const store = writeThrows();
  assert.equal(save(KEYS.history, ['oak'], { store }), false);
  assert.deepEqual(load(KEYS.history, [], { store }), []);
});

test('stored junk reads as absent, whether it is unparseable or merely wrong', () => {
  const store = memoryStore();

  // Not JSON at all - a hand-edited value, or a key from another app.
  store.setItem(KEYS.history, 'not json {');
  assert.deepEqual(load(KEYS.history, ['fallback'], { store }), ['fallback']);

  // Parses, but is not the shape this release expects. "It parsed" is not the
  // same as "it is usable", which is what `validate` exists for.
  store.setItem(KEYS.paging, JSON.stringify('sideways'));
  assert.equal(
    load(KEYS.paging, 'scroll', { store, validate: (v) => v === 'scroll' || v === 'pages' }),
    'scroll'
  );

  store.setItem(KEYS.paging, JSON.stringify('pages'));
  assert.equal(
    load(KEYS.paging, 'scroll', { store, validate: (v) => v === 'scroll' || v === 'pages' }),
    'pages'
  );
});

test('every key sits under one greppable prefix', () => {
  for (const key of Object.values(KEYS)) assert.match(key, /^babel:/);
});
