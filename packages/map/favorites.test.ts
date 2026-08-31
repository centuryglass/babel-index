import { test } from 'node:test';
import assert from 'node:assert/strict';
import { favoriteOrder, favoriteSort, favoriteCount } from './favorites.ts';

/** Four rooms, ids 0..3, named for what they are. */
const files = [{ file: 'a.jpg' }, { file: 'b.jpg' }, { file: 'c.jpg' }, { file: 'd.jpg' }];

test('relevance hands back the very same array, so a memo sees no change', () => {
  const base = [3, 1, 0, 2];
  assert.equal(
    favoriteOrder(base, { mode: 'relevance', files, counts: {}, mine: new Set() }),
    base
  );
});

test('my favorites move to the front and keep the base order inside each group', () => {
  const base = [3, 1, 0, 2];
  const order = favoriteOrder(base, {
    mode: 'mine',
    files,
    counts: {},
    mine: new Set(['a.jpg', 'c.jpg']),
  });
  assert.deepEqual(order, [0, 2, 3, 1]);
  assert.notEqual(order, base, 'and the base array is not mutated');
  assert.deepEqual(base, [3, 1, 0, 2]);
});

test('global counts sort descending, with the base order breaking ties', () => {
  const base = [0, 1, 2, 3];
  assert.deepEqual(
    favoriteOrder(base, {
      mode: 'count',
      files,
      counts: { 'c.jpg': 9, 'a.jpg': 2, 'd.jpg': 2 },
      mine: new Set(),
    }),
    [2, 0, 3, 1]
  );
});

test('a room nobody has favorited sorts as zero rather than dropping out', () => {
  const order = favoriteOrder([0, 1], { mode: 'count', files, counts: {}, mine: new Set() });
  assert.deepEqual(order, [0, 1], 'no counts at all is the base order, not an empty list');
});

test('a favorite for a file this corpus does not have is simply not found', () => {
  const order = favoriteOrder([0, 1], {
    mode: 'mine',
    files,
    counts: {},
    mine: new Set(['gone.jpg', 'b.jpg']),
  });
  assert.deepEqual(order, [1, 0]);
  assert.equal(favoriteCount(files, new Set(['gone.jpg', 'b.jpg'])), 1);
});

test('a base order that is already filtered stays filtered', () => {
  // filterBlockedIds runs first, so a blocked room is absent from `base` and a
  // sort must not reintroduce it.
  const order = favoriteOrder([0, 2], {
    mode: 'mine',
    files,
    counts: {},
    mine: new Set(['b.jpg', 'c.jpg']),
  });
  assert.deepEqual(order, [2, 0]);
});

test('favoriteSort in relevance mode passes certainty through by identity', () => {
  const certainty = new Float32Array([0.9, 0.4, 0.1, 0]);
  const base = [3, 1, 0, 2];
  const result = favoriteSort(base, { mode: 'relevance', files, counts: {}, mine: new Set() }, {
    order: base,
    certainty,
  });
  assert.equal(result.order, base);
  assert.equal(result.certainty, certainty);
});

test('favoriteSort in relevance mode with no search returns null certainty', () => {
  const base = [3, 1, 0, 2];
  const result = favoriteSort(base, { mode: 'relevance', files, counts: {}, mine: new Set() });
  assert.equal(result.certainty, null);
});

test('favoriteSort with no search boosts favorites to 1 and leaves the rest at 0', () => {
  const base = [3, 1, 0, 2];
  const result = favoriteSort(base, {
    mode: 'mine',
    files,
    counts: {},
    mine: new Set(['a.jpg', 'c.jpg']),
  });
  assert.deepEqual(result.order, [0, 2, 3, 1]);
  assert.deepEqual(Array.from(result.certainty), [1, 1, 0, 0]);
});

test('favoriteSort composes the boost with a running search rather than replacing it', () => {
  const base = [3, 1, 0, 2];
  // The search is sure about 'b' (id 1) and unsure about everything else.
  const search = { order: base, certainty: new Float32Array([0.1, 0.8, 0.05, 0.05]) };
  const result = favoriteSort(
    base,
    { mode: 'mine', files, counts: {}, mine: new Set(['a.jpg']) },
    search
  );
  assert.deepEqual(result.order, [0, 3, 1, 2]);
  // a.jpg (id 0): favorited -> boosted to 1. b.jpg (id 1): search was already
  // sure (0.8), not favorited -> kept, not zeroed. Everything else at its
  // own search certainty.
  const byId = new Map(result.order.map((id, i) => [id, result.certainty[i]]));
  const close = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(close(byId.get(0), 1));
  assert.ok(close(byId.get(1), 0.8));
  assert.ok(close(byId.get(3), 0.1));
  assert.ok(close(byId.get(2), 0.05));
});

test('favoriteSort certainty is monotone non-increasing with rank', () => {
  const base = [0, 1, 2, 3];
  const search = { order: base, certainty: new Float32Array([0.9, 0.2, 0.95, 0.1]) };
  const result = favoriteSort(
    base,
    { mode: 'count', files, counts: { 'a.jpg': 5, 'c.jpg': 3 }, mine: new Set() },
    search
  );
  for (let i = 1; i < result.certainty.length; i++) {
    assert.ok(result.certainty[i] <= result.certainty[i - 1], `rank ${i} must not exceed rank ${i - 1}`);
  }
});

test('favoriteSort with count mode boosts every room with a nonzero count', () => {
  const base = [0, 1, 2, 3];
  const result = favoriteSort(base, {
    mode: 'count',
    files,
    counts: { 'c.jpg': 9, 'a.jpg': 2, 'd.jpg': 2 },
    mine: new Set(),
  });
  assert.deepEqual(result.order, [2, 0, 3, 1]);
  const byId = new Map(result.order.map((id, i) => [id, result.certainty[i]]));
  assert.equal(byId.get(2), 1);
  assert.equal(byId.get(0), 1);
  assert.equal(byId.get(3), 1);
  assert.equal(byId.get(1), 0);
});
