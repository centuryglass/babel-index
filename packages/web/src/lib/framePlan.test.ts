import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMapPlanner, planCell, planGenericFade, planFavoriteBadge, planFavoriteSwitch, planLoadingFrame, planOverlay,
  smoothingFor, SMOOTHING_MAX_DOWNSCALE,
} from './framePlan.ts';
import { createDrawList, BLANK_FILL, FADE_FILL, CURSOR_STROKE, type DrawItem, type DrawList } from './drawList.ts';
import {
  FAV_ON, FAV_CENTER_SWITCH_BASE, FAV_MINE_ON, DISTILL_ON, DISTILL_TOGGLE, FAVORITE_BADGE,
  type Drawable, type RoomId, type TileCache, type TileHit,
} from './tiles.ts';
import { FAVORITE_TOGGLE_PATH } from './favoriteBadge.ts';
import type { LoadingFrame } from './loadingAnimation.ts';
import { createLayout, shuffledOrder } from '../../../map/ordering.ts';
import { TEST_OVERLAYS } from './overlay-fixtures.ts';
import type { OverlayAnchor } from '../../../map/overlays.ts';
import { TEST_TILE } from './tile-fixtures.ts';

const CELL_ASPECT = TEST_TILE.aspect;
const BASE_TILE = TEST_TILE.base;
const PYRAMID = TEST_TILE.pyramid;
const ZOOM_LIMITS = TEST_TILE.zoomLimits;

/** A `TileCache` whose `get` is `lookup`, recording every request; the rest is inert. */
function stubCache(lookup: (id: RoomId, want: number) => TileHit | null) {
  const asked: [RoomId, number][] = [];
  const cache: TileCache = {
    pyramid: PYRAMID,
    beginFrame: () => {},
    request: () => null,
    get: (id, want) => {
      asked.push([id, want]);
      return lookup(id, want);
    },
    isReady: () => false,
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
  return { cache, asked };
}

const image = (width = 96, height = 96) => ({ width, height }) as unknown as Drawable;

const fresh = (): DrawList => {
  const list = createDrawList();
  list.reset(1, true);
  return list;
};

const itemsOf = (list: DrawList): DrawItem[] => list.items.slice(0, list.length);

type ImageItem = Extract<DrawItem, { kind: 'image' }>;
type FillItem = Extract<DrawItem, { kind: 'fill' }>;

// --- one cell's tile ----------------------------------------------------------

test('a cell with nothing resident plans the blank fill', () => {
  const { cache } = stubCache(() => null);
  const list = fresh();
  assert.equal(planCell(list, cache, 7, null, 0, 2, 10, 20, 30, 40), 'blank');
  const [fill] = itemsOf(list) as FillItem[];
  assert.equal(fill.kind, 'fill');
  assert.equal(fill.color, BLANK_FILL);
  assert.deepEqual(fill.dst, { x: 10, y: 20, w: 30, h: 40 });
});

test('a coarser hit is planned as substituted, with the blank fill as its painter fallback', () => {
  const { cache } = stubCache(() => ({ img: image(), rect: null, level: 4 }));
  const list = fresh();
  assert.equal(planCell(list, cache, 7, null, 0, 2, 0, 0, 30, 40), 'substituted');
  const [tile] = itemsOf(list) as ImageItem[];
  assert.equal(tile.stat, 'substituted');
  assert.equal(tile.fallback, BLANK_FILL);
});

test('a fully faded generic cell never asks for its base tile', () => {
  const { cache, asked } = stubCache(() => ({ img: image(), rect: null, level: 0 }));
  const list = fresh();
  assert.equal(planCell(list, cache, 'generic-base', 'generic-distill', 1, 0, 0, 0, 30, 40), 'faded');
  assert.deepEqual(asked.map(([id]) => id), ['generic-distill']);
  const [fade] = itemsOf(list) as ImageItem[];
  assert.equal(fade.alpha, 1);
});

test('a partial fade draws the base, then the alternate over it at the fade\'s alpha', () => {
  const { cache } = stubCache(() => ({ img: image(), rect: null, level: 0 }));
  const list = fresh();
  planCell(list, cache, 'generic-base', 'generic-distill', 0.4, 0, 0, 0, 30, 40);
  const [base, fade] = itemsOf(list) as ImageItem[];
  assert.equal(base.alpha, 1);
  assert.equal(fade.alpha, 0.4);
  assert.equal(fade.fallback, FADE_FILL);
});

test('a fade with no alternate resident fills black at the fade\'s alpha', () => {
  const { cache } = stubCache(() => null);
  const list = fresh();
  planGenericFade(list, cache, 'generic-distill', 0.6, 0, 0, 30, 40);
  const [fill] = itemsOf(list) as FillItem[];
  assert.equal(fill.color, FADE_FILL);
  assert.equal(fill.alpha, 0.6);
});

// --- overlays -----------------------------------------------------------------

test('the favorite badge never substitutes a different level', () => {
  // The badge's size tracks the tile whichever rung backs it, so a substitute
  // would only be softer, never smaller. Level 3 is resident while level 2 is
  // asked for.
  const { cache } = stubCache((_id, want) => (want === 3 ? { img: image(), rect: null, level: 3 } : null));
  const list = fresh();
  planFavoriteBadge(list, cache, TEST_OVERLAYS, true, { x: 100, y: 75 }, 0, 0, 2);
  assert.equal(list.length, 0, 'a non-exact-level hit must not be planned');
});

test('a hovered badge plans its glow over the whole cell, after the art', () => {
  assert.ok(FAVORITE_TOGGLE_PATH, 'the badge silhouette ships with the geometry');
  const { cache } = stubCache((id, want) => (id === FAV_ON ? { img: image(), rect: null, level: want } : null));
  const list = fresh();
  planFavoriteBadge(list, cache, TEST_OVERLAYS, true, { x: 200, y: 150 }, 10, 20, 0, true);
  const [badge, glow] = itemsOf(list);
  assert.equal(badge.kind, 'image');
  assert.equal(glow.kind, 'glow');
  if (glow.kind !== 'glow' || badge.kind !== 'image') return;
  assert.deepEqual(glow.cell, { x: 10, y: 20, w: 200, h: 150 });
  assert.deepEqual(glow.fallback, badge.dst, 'the flat fallback covers the badge itself');
});

test('a hovered badge with no art plans no glow', () => {
  const { cache } = stubCache(() => null);
  const list = fresh();
  planFavoriteBadge(list, cache, TEST_OVERLAYS, true, { x: 200, y: 150 }, 0, 0, 0, true);
  assert.equal(list.length, 0);
});

test('the favorites-sort switch sizes each piece off its own decoded pixels, not the base plate\'s', () => {
  // The "on" faces are close to the base plate in size but not
  // pixel-identical in the real art, so each is anchored to the same corner
  // and sized from itself.
  const sizeFor: Record<string, [number, number]> = {
    [FAV_CENTER_SWITCH_BASE]: [281, 275],
    [FAV_MINE_ON]: [255, 270],
  };
  const { cache } = stubCache((id) => {
    const size = sizeFor[String(id)];
    return size ? { img: image(...size), rect: null, level: 0 } : null;
  });
  const list = fresh();
  planFavoriteSwitch(list, cache, TEST_OVERLAYS, 'mine', { x: 1024, y: 768 }, 0, 0, 0);
  const [base, mine] = itemsOf(list) as ImageItem[];
  assert.ok(base && mine, 'both the base plate and the "mine" face must be planned');
  assert.equal(base.dst.x, mine.dst.x);
  assert.equal(base.dst.y, mine.dst.y);
  assert.equal(base.dst.w, 281);
  assert.equal(mine.dst.w, 255);
});

test('an overlay lands at the corner its descriptor names, and a missing descriptor or face plans nothing', () => {
  const { cache } = stubCache((_id, want) => ({ img: image(10, 20), rect: null, level: want }));
  const cell = { x: BASE_TILE.w, y: BASE_TILE.h };
  const at = (anchor: OverlayAnchor) => {
    const list = fresh();
    const overlays = { ...TEST_OVERLAYS, 'distill-toggle': { ...TEST_OVERLAYS['distill-toggle'], anchor } };
    planOverlay(list, cache, overlays, DISTILL_TOGGLE, 'on', cell, 100, 200, 0);
    return (itemsOf(list) as ImageItem[])[0].dst;
  };
  assert.deepEqual(at('bottom-right'), { x: 100 + cell.x - 10, y: 200 + cell.y - 20, w: 10, h: 20 });
  assert.deepEqual(at('top-left'), { x: 100, y: 200, w: 10, h: 20 });

  const list = fresh();
  assert.equal(planOverlay(list, cache, {}, DISTILL_TOGGLE, 'on', cell, 0, 0, 0), null);
  assert.equal(planOverlay(list, cache, TEST_OVERLAYS, DISTILL_TOGGLE, 'sideways', cell, 0, 0, 0), null);
  assert.equal(list.length, 0);
});

test('a tile-scale overlay asks for level 0 whatever the tile\'s level; a pyramid one asks for the tile\'s', () => {
  const asked: [unknown, number][] = [];
  const { cache } = stubCache((id, want) => {
    asked.push([id, want]);
    return null;
  });
  planOverlay(fresh(), cache, TEST_OVERLAYS, DISTILL_TOGGLE, 'on', { x: 100, y: 75 }, 0, 0, 3);
  planOverlay(fresh(), cache, TEST_OVERLAYS, FAVORITE_BADGE, 'on', { x: 100, y: 75 }, 0, 0, 3);
  assert.deepEqual(asked, [[DISTILL_ON, 0], [FAV_ON, 3]]);
});

test('a loading frame lands at its cell-fraction rect, from its sheet sub-rect', () => {
  const frame: LoadingFrame = {
    image: image(512, 512) as ImageBitmap,
    src: { x: 64, y: 0, w: 64, h: 32 },
    rect: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 },
  };
  const list = fresh();
  planLoadingFrame(list, frame, { x: 200, y: 100 }, 10, 20);
  const [item] = itemsOf(list) as ImageItem[];
  assert.equal(item.whole, false);
  assert.deepEqual(item.src, { x: 64, y: 0, w: 64, h: 32 });
  assert.deepEqual(item.dst, { x: 60, y: 70, w: 100, h: 25 });
});

// --- a whole frame ------------------------------------------------------------

const ROOMS = 400;

function planner() {
  const { cache } = stubCache((_id, want) => ({ img: image(), rect: null, level: want }));
  const layout = createLayout({ roomCount: ROOMS, contentRatio: 0.2, seed: 1, aspect: CELL_ASPECT });
  return { planner: createMapPlanner({ cache, overlays: TEST_OVERLAYS }), layout, order: shuffledOrder(ROOMS, 1) };
}

test('a frame plans one tile per on-screen cell, with no context at all', () => {
  const p = planner();
  const result = p.planner.plan({
    width: 1600, height: 900, dpr: 1, cam: { x: 0, y: 0, zoom: 220, aspect: CELL_ASPECT, limits: ZOOM_LIMITS }, layout: p.layout, order: p.order,
  });
  const tiles = itemsOf(p.planner.list).filter((i) => i.kind === 'image' && i.stat !== 'none');
  assert.equal(tiles.length, result.cells);
  assert.equal(result.drawn, result.cells);
});

test('the keyboard cursor\'s ring is the last item planned', () => {
  const p = planner();
  p.planner.plan({
    width: 1600, height: 900, dpr: 1, cam: { x: 0, y: 0, zoom: 220, aspect: CELL_ASPECT, limits: ZOOM_LIMITS }, layout: p.layout, order: p.order,
    cursor: { x: 1, y: 0 },
  });
  const last = p.planner.list.items[p.planner.list.length - 1];
  assert.equal(last.kind, 'stroke');
  if (last.kind === 'stroke') assert.equal(last.color, CURSOR_STROKE);
});

test('smoothing stays on near 1:1 and turns off past SMOOTHING_MAX_DOWNSCALE', () => {
  const src = PYRAMID.sizeOf(0)!;
  assert.equal(smoothingFor(PYRAMID, 0, { x: src.w }, 1), true);
  assert.equal(smoothingFor(PYRAMID, 0, { x: src.w / (SMOOTHING_MAX_DOWNSCALE * 2) }, 1), false);
  // Demand is in device pixels: the same css cell on a dpr-2 screen downscales half as far.
  assert.equal(smoothingFor(PYRAMID, 0, { x: src.w / 2 }, 2), true);
});
