import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomAtPoint } from './picking.ts';
import { CELL_ASPECT, pxPerCell, worldToScreen } from './camera.js';
import { createLayout } from '../../../map/ordering.ts';

const rect = { width: 1280, height: 800 };
const layout = createLayout({ roomCount: 40, contentRatio: 0.3, seed: 1, aspect: CELL_ASPECT });
const order = Array.from({ length: 40 }, (_, i) => i);
const cam = { x: 0.5, y: 0.5, zoom: 220 };

/** The viewport point at the middle of a given cell. */
const centreOf = (x, y, camera = cam) => worldToScreen(x + 0.5, y + 0.5, camera, rect);

test('a point inside a content slot picks that slot', () => {
  const slot = layout.slots[7];
  const p = centreOf(slot.x, slot.y);
  const hit = roomAtPoint(p.x, p.y, cam, rect, layout, order);
  assert.ok(hit, 'expected a hit on a known content slot');
  assert.equal(hit.x, slot.x);
  assert.equal(hit.y, slot.y);
  assert.equal(hit.rank, 7);
  assert.equal(hit.id, order[7]);
});

test('the picked room follows the ranking, not the cell', () => {
  // The map's whole mechanic: slots stay put and the order pours into them, so
  // the same point must pick a different room after a search.
  const slot = layout.slots[3];
  const p = centreOf(slot.x, slot.y);
  const reversed = [...order].reverse();
  assert.equal(roomAtPoint(p.x, p.y, cam, rect, layout, order).id, order[3]);
  assert.equal(roomAtPoint(p.x, p.y, cam, rect, layout, reversed).id, reversed[3]);
});

test('the center room is never picked', () => {
  // It is the controls, not a corpus room, and it has no metadata to show.
  const p = centreOf(0, 0);
  assert.equal(roomAtPoint(p.x, p.y, cam, rect, layout, order), null);
});

test('a generic cell is picked as generic, not as a room', () => {
  // Unlike the center, a generic cell has something to say (see
  // `describe.js`), so it picks - just without an id or rank.
  let checked = 0;
  for (let x = -6; x <= 6 && checked < 5; x++)
    for (let y = -6; y <= 6 && checked < 5; y++) {
      if (layout.rankOf(x, y) !== -1 || (x === 0 && y === 0)) continue;
      const p = centreOf(x, y);
      const hit = roomAtPoint(p.x, p.y, cam, rect, layout, order);
      assert.ok(hit, `expected a hit on generic cell ${x},${y}`);
      assert.equal(hit.generic, true);
      assert.equal(hit.x, x);
      assert.equal(hit.y, y);
      assert.equal(hit.id, undefined);
      checked++;
    }
  assert.ok(checked > 0, 'no generic cells were available to check');
});

test('a rank beyond the end of the order is generic, not a crash', () => {
  // The "rooms on the map" slider shortens the order without moving slots.
  const slot = layout.slots[30];
  const p = centreOf(slot.x, slot.y);
  const hit = roomAtPoint(p.x, p.y, cam, rect, layout, order.slice(0, 10));
  assert.ok(hit);
  assert.equal(hit.generic, true);
});

test('picking is exact at cell edges rather than rounding into the neighbour', () => {
  // Cells are addressed by their lower corner, so the boundary belongs to the
  // higher cell. Rounding instead of flooring would shift every pick half a
  // cell up and left, which is invisible at the center and wrong at the edges.
  const slot = layout.slots[5];
  const per = pxPerCell(cam);
  const topLeft = worldToScreen(slot.x, slot.y, cam, rect);

  const justInside = roomAtPoint(topLeft.x + 0.5, topLeft.y + 0.5, cam, rect, layout, order);
  assert.ok(justInside && justInside.x === slot.x && justInside.y === slot.y, 'just inside the corner');

  const before = roomAtPoint(topLeft.x - 0.5, topLeft.y + per.y / 2, cam, rect, layout, order);
  assert.ok(!before || before.x === slot.x - 1, 'just left of the corner is the previous cell');
});

test('picking follows the camera, at any zoom', () => {
  const slot = layout.slots[11];
  for (const zoom of [40, 220, 700]) {
    const camera = { ...cam, zoom, x: slot.x + 0.5, y: slot.y + 0.5 };
    // The camera is centered on the slot, so the middle of the screen is it.
    const hit = roomAtPoint(rect.width / 2, rect.height / 2, camera, rect, layout, order);
    assert.ok(hit, `nothing picked at zoom ${zoom}`);
    assert.equal(hit.x, slot.x, `zoom ${zoom}`);
    assert.equal(hit.y, slot.y, `zoom ${zoom}`);
  }
});

test('picking uses the cell shape, not a square cell', () => {
  // A cell is 4:3, so a point 0.9 of a cell WIDTH below a cell's top edge is
  // already in the cell below it. Treating the world as square would keep it in
  // the same row and pick the wrong room everywhere off-center.
  assert.ok(CELL_ASPECT < 1, 'this test assumes a short cell');
  const slot = layout.slots[9];
  const per = pxPerCell(cam);
  const topLeft = worldToScreen(slot.x, slot.y, cam, rect);

  const down = roomAtPoint(topLeft.x + per.x / 2, topLeft.y + per.x * 0.9, cam, rect, layout, order);
  assert.ok(!down || down.y === slot.y + 1, 'a cell width down is the next row for a short cell');
});
