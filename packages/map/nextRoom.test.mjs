import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRoom } from './nextRoom.ts';
import { createLayout } from './ordering.js';

const layout = createLayout({ roomCount: 30, contentRatio: 0.15, seed: 1 });

test('finds the nearest room in the given direction, skipping wallpaper', () => {
  // Walk east from the origin until a room turns up; the walk under test must
  // find exactly that cell, not the first generic one it passes.
  let x = 1;
  while (layout.rankOf(x, 0) === -1) x++;
  const found = nextRoom(layout, { x: 0, y: 0 }, { dx: 1, dy: 0 });
  assert.deepEqual(found, { x, y: 0 });
});

test('never returns the starting cell, even when it is itself a room', () => {
  const slot = layout.slots[0];
  // Standing exactly on a room and walking dx=0,dy=0 would return `from`
  // immediately if the walk did not step first - assert it always steps.
  const found = nextRoom(layout, slot, { dx: 1, dy: 0 });
  assert.ok(!found || found.x !== slot.x || found.y !== slot.y);
});

test('walking off the far edge of the content region finds nothing', () => {
  // Far outside the boundary in every direction: any straight line from here
  // never re-enters the ranked region.
  const far = Math.ceil(layout.boundaryRadius) + 10000;
  const found = nextRoom(layout, { x: far, y: far }, { dx: 1, dy: 0 });
  assert.equal(found, null);
});

test('the four directions are independent', () => {
  const slot = layout.slots[2];
  // From one cell short of a known slot, walking toward it in the right
  // direction finds it; walking any other direction from that same point must
  // not coincidentally land on it too.
  const before = { x: slot.x - 1, y: slot.y };
  const east = nextRoom(layout, before, { dx: 1, dy: 0 });
  assert.deepEqual(east, { x: slot.x, y: slot.y });

  const north = nextRoom(layout, before, { dx: 0, dy: -1 });
  const south = nextRoom(layout, before, { dx: 0, dy: 1 });
  for (const other of [north, south]) {
    if (other) assert.ok(other.x !== slot.x || other.y !== slot.y);
  }
});

test('a corpus with only wallpaper never finds a room', () => {
  const empty = createLayout({ roomCount: 0, contentRatio: 0.5, seed: 1 });
  const found = nextRoom(empty, { x: 0, y: 0 }, { dx: 1, dy: 0 });
  assert.equal(found, null);
});
