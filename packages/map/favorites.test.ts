import { test } from 'node:test';
import assert from 'node:assert/strict';
import { favoriteOrder, favoriteStrength, favoriteCount } from './favorites.ts';

/** Four rooms, ids 0..3, files a.jpg..d.jpg - the `files` lookup stands in for `manifest.rooms`. */
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

test('favoriteStrength is null for relevance mode [SR-26]', () => {
  const base = [3, 1, 0, 2];
  assert.equal(
    favoriteStrength(base, { mode: 'relevance', files, counts: {}, mine: new Set() }),
    null
  );
});

test('favoriteStrength is null for random mode - a shuffle carries no confidence claim', () => {
  const base = [3, 1, 0, 2];
  assert.equal(
    favoriteStrength(base, { mode: 'random', files, counts: {}, mine: new Set(), randomSeed: 5 }),
    null
  );
});

test('favoriteStrength boosts favorites to 1 and leaves the rest at 0 [SR-28]', () => {
  const order = favoriteOrder([3, 1, 0, 2], {
    mode: 'mine',
    files,
    counts: {},
    mine: new Set(['a.jpg', 'c.jpg']),
  });
  assert.deepEqual(order, [0, 2, 3, 1]);
  const strength = favoriteStrength(order, {
    mode: 'mine',
    files,
    counts: {},
    mine: new Set(['a.jpg', 'c.jpg']),
  });
  assert.deepEqual(Array.from(strength), [1, 1, 0, 0]);
});

test('favoriteStrength with count mode boosts every room with a nonzero count', () => {
  const order = favoriteOrder([0, 1, 2, 3], {
    mode: 'count',
    files,
    counts: { 'c.jpg': 9, 'a.jpg': 2, 'd.jpg': 2 },
    mine: new Set(),
  });
  assert.deepEqual(order, [2, 0, 3, 1]);
  const strength = favoriteStrength(order, {
    mode: 'count',
    files,
    counts: { 'c.jpg': 9, 'a.jpg': 2, 'd.jpg': 2 },
    mine: new Set(),
  });
  const byId = new Map(order.map((id, i) => [id, strength[i]]));
  assert.equal(byId.get(2), 1);
  assert.equal(byId.get(0), 1);
  assert.equal(byId.get(3), 1);
  assert.equal(byId.get(1), 0);
});

test('random mode is a permutation, seed-stable, and differs across seeds', () => {
  const base = [0, 1, 2, 3, 4, 5, 6, 7];
  const input = (randomSeed: number) =>
    ({ mode: 'random', files, counts: {}, mine: new Set<string>(), randomSeed }) as const;
  const a = favoriteOrder(base, input(1));
  assert.deepEqual([...a].sort((x, y) => x - y), base, 'still every id, just reordered');
  assert.deepEqual(a, favoriteOrder(base, input(1)), 'same seed reproduces the same order');
  assert.notDeepEqual(a, favoriteOrder(base, input(2)), 'a different seed gives a different order');
});

