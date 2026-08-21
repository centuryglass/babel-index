import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCell } from './describe.js';
import { createLayout } from './ordering.js';

const layout = createLayout({ roomCount: 40, contentRatio: 0.3, seed: 1 });
const order = Array.from({ length: 40 }, (_, i) => i);

/** A room whose slot rank is known, so the message can be checked exactly. */
const roomAt = (rank) => layout.slots[rank];

test('the centre room is named, not ranked', () => {
  const d = describeCell(0, 0, { layout, order });
  assert.equal(d.kind, 'centre');
  assert.equal(d.description, null);
});

test('a generic cell reads as a blank wall', () => {
  let checked = false;
  for (let x = -6; x <= 6 && !checked; x++)
    for (let y = -6; y <= 6 && !checked; y++) {
      if (layout.rankOf(x, y) !== -1 || (x === 0 && y === 0)) continue;
      const d = describeCell(x, y, { layout, order });
      assert.equal(d.kind, 'generic');
      assert.equal(d.description, null);
      checked = true;
    }
  assert.ok(checked, 'no generic cell was available to check');
});

test('a described room names its rank and its keywords', () => {
  const slot = roomAt(2);
  const metadata = [];
  metadata[order[2]] = { keywords: [{ text: 'brass', type: null }, { text: 'spiral staircase', type: null }], story: 'A tale.' };

  const d = describeCell(slot.x, slot.y, { layout, order, metadata });
  assert.equal(d.kind, 'room');
  assert.equal(d.name, `Room ${order[2]}, rank 3 of 40 — brass, spiral staircase`);
  assert.equal(d.description, 'A tale.');
});

test('a room with no metadata is honest about it, not silent', () => {
  const slot = roomAt(5);
  const d = describeCell(slot.x, slot.y, { layout, order, metadata: [] });
  assert.equal(d.kind, 'room');
  assert.equal(d.name, `Room ${order[5]}, rank 6 of 40 — no description recorded`);
  assert.equal(d.description, null);
});

test('metadata is optional entirely, and reads the same as an empty one', () => {
  const slot = roomAt(5);
  const withNoArg = describeCell(slot.x, slot.y, { layout, order });
  const withEmpty = describeCell(slot.x, slot.y, { layout, order, metadata: [] });
  assert.deepEqual(withNoArg, withEmpty);
});

test('a story-only entry names the room without inventing keywords', () => {
  const slot = roomAt(1);
  const metadata = [];
  metadata[order[1]] = { keywords: [], story: 'Only a story.' };
  const d = describeCell(slot.x, slot.y, { layout, order, metadata });
  assert.match(d.name, /no description recorded$/);
  assert.equal(d.description, 'Only a story.');
});

test('the name follows the ranking, not the cell', () => {
  // Same mechanic as `picking.js`: slots stay put, the order pours into them.
  const slot = roomAt(4);
  const reversed = [...order].reverse();
  const forward = describeCell(slot.x, slot.y, { layout, order });
  const backward = describeCell(slot.x, slot.y, { layout, order: reversed });
  assert.notEqual(forward.name, backward.name);
  assert.match(forward.name, new RegExp(`^Room ${order[4]},`));
  assert.match(backward.name, new RegExp(`^Room ${reversed[4]},`));
});

test('a rank beyond the end of the order reads as generic, not a crash', () => {
  // The "rooms on the map" slider shortens the order without moving slots.
  const slot = roomAt(30);
  const d = describeCell(slot.x, slot.y, { layout, order: order.slice(0, 10) });
  assert.equal(d.kind, 'generic');
});
