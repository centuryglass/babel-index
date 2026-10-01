import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlidePlanner, idFor } from './slidePlan.ts';
import type { DrawItem } from './drawList.ts';
import { CENTER, FAV_ON, FAV_OFF, genericId, type Drawable, type RoomId, type TileCache } from './tiles.ts';
import { CENTER as BOARD_CENTER, GENERIC as BOARD_GENERIC } from '../../../map/board.ts';
import type { Board, BoardValue } from '../../../map/moves.ts';

const ZOOM = 220;

/** A cache that has every id at every level, and remembers which images it handed out for which id. */
function readyCache() {
  const ids = new Map<Drawable, RoomId>();
  const cache: TileCache = {
    beginFrame: () => {},
    request: () => null,
    get: (id, want) => {
      const img = { width: 96, height: 96 } as unknown as Drawable;
      ids.set(img, id);
      return { img, rect: null, level: want };
    },
    isReady: () => true,
    prefetch: () => {},
    pin: () => {},
    size: () => 0,
    sizeOf: () => 0,
    sheetCount: () => 0,
    overBudget: () => 0,
    pendingPrefetch: () => 0,
    hasPrefetchCapacity: () => true,
    clear: () => {},
  };
  return { cache, idOf: (img: Drawable) => ids.get(img) };
}

/** A board big enough to cover the viewport, the center at board (8, 8) and rooms elsewhere. */
function board(): Board {
  const width = 17;
  const height = 17;
  const cells: BoardValue[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      cells.push(x === 8 && y === 8 ? BOARD_CENTER : (x + y) % 3 === 0 ? BOARD_GENERIC : y * width + x);
  return { width, height, cells };
}

const images = (items: readonly DrawItem[], length: number) =>
  items.slice(0, length).filter((i): i is Extract<DrawItem, { kind: 'image' }> => i.kind === 'image');

test('idFor resolves a generic from its home cell and passes rooms through', () => {
  const indexAt = (x: number, y: number) => x * 10 + y;
  assert.equal(idFor(BOARD_CENTER, 3, 4, indexAt), CENTER);
  assert.equal(idFor(BOARD_GENERIC, 3, 4, indexAt), genericId(34));
  assert.equal(idFor(42, 3, 4, indexAt), 42);
});

test('a sliding generic keeps the face of its home cell, not of where it is drawn', () => {
  const { cache, idOf } = readyCache();
  const planner = createSlidePlanner({ cache });
  const b = board();
  const origin = { x: 8, y: 8 };
  const indexAt = (x: number, y: number) => 100 + x * 10 + y;
  // Row 9 (map row 1) half a cell to the right.
  planner.plan({
    width: 1600, height: 900, dpr: 1, cam: { x: 0.5, y: 0.5, zoom: ZOOM }, board: b, origin,
    motions: [{ kind: 'row', index: 9, dir: 1, offset: 0.5 }], genericIndexAt: indexAt,
  });
  const cellW = ZOOM;
  const faces = images(planner.list.items, planner.list.length)
    .filter((i) => i.stat !== 'none')
    .map((i) => ({ id: idOf(i.source), x: i.dst.x }));
  // A generic home at map (mx, 1) draws half a cell right of mx, wearing mx's face.
  for (let mx = -2; mx <= 2; mx++) {
    if (b.cells[9 * b.width + mx + 8] !== BOARD_GENERIC) continue;
    const homeX = (mx - 0.5) * cellW + 800;
    const drawn = faces.find((f) => f.id === genericId(indexAt(mx, 1)) && Math.abs(f.x - (homeX + cellW / 2)) < 1e-6);
    assert.ok(drawn, `generic home at (${mx}, 1) is drawn shifted with its own face`);
  }
});

test('badges ride on room cells only, and the center chrome is planned after every tile', () => {
  const { cache, idOf } = readyCache();
  const planner = createSlidePlanner({ cache });
  const result = planner.plan({
    width: 1600, height: 900, dpr: 1, cam: { x: 0.5, y: 0.5, zoom: ZOOM }, board: board(), origin: { x: 8, y: 8 },
    favorites: { isFavorite: () => false }, distillMode: false,
  });
  const all = images(planner.list.items, planner.list.length);
  const tiles = all.filter((i) => i.stat !== 'none');
  assert.equal(tiles.length, result.cells);
  const badges = all.filter((i) => idOf(i.source) === FAV_OFF || idOf(i.source) === FAV_ON);
  const rooms = tiles.filter((i) => typeof idOf(i.source) === 'number');
  assert.equal(badges.length, rooms.length);

  const lastTile = all.lastIndexOf(tiles[tiles.length - 1]);
  const chrome = all.slice(lastTile + 1).filter((i) => !badges.includes(i));
  assert.ok(chrome.length > 0, 'the center controls follow the field');
});
