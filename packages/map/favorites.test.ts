import { test } from 'node:test';
import assert from 'node:assert/strict';
import { favoriteOrder, favoriteCount } from './favorites.ts';

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
