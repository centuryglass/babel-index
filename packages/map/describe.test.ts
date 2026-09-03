import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCell, describeRoom, describeArrangement, describeCatalog } from './describe.ts';
import { createLayout } from './ordering.ts';

// `createLayout` requires a real cell shape; the corpus is never square.
const ASPECT = 720 / 1280;

const layout = createLayout({ roomCount: 40, contentRatio: 0.3, seed: 1, aspect: ASPECT });
const order = Array.from({ length: 40 }, (_, i) => i);

/** A room whose slot rank is known, so the message can be checked exactly. */
const roomAt = (rank) => layout.slots[rank];

test('the center room is named, not ranked', () => {
  const d = describeCell(0, 0, { layout, order });
  assert.equal(d.kind, 'center');
  assert.equal(d.description, null);
});

test('a generic cell reads as a Babel shelf', () => {
  let checked = false;
  for (let x = -6; x <= 6 && !checked; x++)
    for (let y = -6; y <= 6 && !checked; y++) {
      if (layout.rankOf(x, y) !== -1 || (x === 0 && y === 0)) continue;
      const d = describeCell(x, y, { layout, order });
      assert.equal(d.kind, 'generic');
      // Unlike the center, a generic cell has something to say - the room
      // card opened on it should tell a reader this is wallpaper, not an
      // unindexed room. Not pinning the exact wording, just that there is
      // some.
      assert.ok(typeof d.description === 'string' && d.description.length > 0);
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

test('a room carries the picture caption separately from its story', () => {
  const slot = roomAt(2);
  const id = order[2];
  const metadata = [];
  metadata[id] = {
    keywords: [{ text: 'brass', type: 'material' }],
    story: 'A fiction about the room.',
    alt: 'A report of the image.',
  };
  const d = describeCell(slot.x, slot.y, { layout, order, metadata });
  assert.equal(d.description, 'A fiction about the room.');
  assert.equal(d.picture, 'A report of the image.');
  // The two never merge: a reader has to be able to tell which they are being
  // told, so the caption stays out of the name as well.
  assert.doesNotMatch(d.name, /report of the image/);
});

test('no caption is null everywhere, and nothing invents one', () => {
  const slot = roomAt(3);
  const id = order[3];
  const metadata = [];
  metadata[id] = { keywords: [{ text: 'brass', type: 'material' }], story: 'A story.' };
  assert.equal(describeCell(slot.x, slot.y, { layout, order, metadata }).picture, null);
  assert.equal(describeCell(slot.x, slot.y, { layout, order }).picture, null);
  assert.equal(describeCell(0, 0, { layout, order }).picture, null, 'the center has no picture');
});

// --- the arrangement, for a reader who cannot watch it happen ---------------

test('an arrangement says how big the map is and whether the search clustered', () => {
  const uniform = createLayout({ roomCount: 40, contentRatio: 0.3, seed: 1, aspect: ASPECT });
  assert.equal(uniform.gradedCount, 0, 'no search, no cluster');
  const said = describeArrangement(uniform);
  assert.match(said, /40 rooms on the map/);
  assert.match(said, /spread evenly/);

  // A confident search lifts the leading ranks above the baseline, and that
  // count IS the cluster the animation is drawing.
  const certainty = Array.from({ length: 40 }, (_, i) => Math.max(0, 1 - i / 8));
  const clustered = createLayout({
    roomCount: 40, contentRatio: 0.3, seed: 1, aspect: ASPECT,
    density: { certainty, peak: 1, floor: 0.05 },
  });
  assert.ok(clustered.gradedCount > 0);
  assert.match(describeArrangement(clustered), new RegExp(`${clustered.gradedCount} clustered`));
});

test('the arrangement never mentions the animation, which is the optional half', () => {
  const layoutNow = createLayout({ roomCount: 12, contentRatio: 0.5, seed: 3, aspect: ASPECT });
  const said = describeArrangement(layoutNow);
  assert.doesNotMatch(said, /slid|sliding|animat|moving/i);
});

// --- the naming primitive under describeCell, and the catalog's sentence ----

test('describeRoom names a room exactly as describeCell does for the same room', () => {
  const metadata = [];
  metadata[order[3]] = { keywords: [{ text: 'gilt' }, { text: 'oak' }], story: 'A hall.', alt: null };

  const cell = roomAt(3);
  const viaCell = describeCell(cell.x, cell.y, { layout, order, metadata });
  const direct = describeRoom(order[3], 3, order.length, metadata[order[3]]);

  // The whole reason the split exists: one implementation, two ways in.
  assert.deepEqual(direct, viaCell);
  assert.match(direct.name, /rank 4 of 40 — gilt, oak/);
});

test('describeRoom reads as well with no metadata at all', () => {
  const d = describeRoom(7, 0, 12);
  assert.equal(d.description, null);
  assert.equal(d.picture, null);
  assert.match(d.name, /Room 7, rank 1 of 12 — no description recorded/);
});

test('the catalog says what it is ordered by, and folds in the signals note', () => {
  assert.match(describeCatalog({ total: 27 }), /27 rooms in alphabetical order/);

  const searched = describeCatalog({ total: 27, query: '  gilt ', note: 'ranked by keywords + CLIP' });
  assert.match(searched, /27 rooms ranked for “gilt”/);
  assert.match(searched, /ranked by keywords \+ CLIP/);

  // No note is not an empty clause.
  assert.ok(!describeCatalog({ total: 3, query: 'oak' }).endsWith('. '));
});
