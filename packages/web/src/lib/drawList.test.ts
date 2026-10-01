import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawList, assertNever, BLANK_FILL, FADE_FILL, type DrawItem } from './drawList.ts';
import type { Drawable } from './tiles.ts';

const img = (name: string) => ({ name }) as unknown as Drawable;

test('items keep paint order across kinds', () => {
  const list = createDrawList();
  list.reset(1, true);
  list.fill(0, 0, 10, 10, BLANK_FILL);
  list.image(img('a'), null, 1, 2, 3, 4);
  list.fill(5, 5, 1, 1, FADE_FILL, 0.5);
  assert.equal(list.length, 3);
  assert.deepEqual(list.items.slice(0, list.length).map((i) => i.kind), ['fill', 'image', 'fill']);
});

test('reset reuses the same item objects instead of allocating new ones', () => {
  const list = createDrawList();
  list.reset(1, true);
  list.image(img('a'), null, 0, 0, 1, 1);
  list.fill(0, 0, 1, 1, BLANK_FILL);
  const first = list.items.slice(0, list.length);

  list.reset(2, false);
  list.image(img('b'), { sx: 1, sy: 2, sw: 3, sh: 4 }, 5, 6, 7, 8, 0.25);
  list.fill(9, 9, 9, 9, FADE_FILL);
  assert.equal(list.length, 2);
  assert.equal(list.items[0], first[0]);
  assert.equal(list.items[1], first[1]);
  assert.equal(list.dpr, 2);
  assert.equal(list.smoothing, false);

  const item = list.items[0] as Extract<DrawItem, { kind: 'image' }>;
  assert.equal(item.whole, false);
  assert.deepEqual(item.src, { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(item.dst, { x: 5, y: 6, w: 7, h: 8 });
  assert.equal(item.alpha, 0.25);
});

test('an image with no source rect draws the whole source', () => {
  const list = createDrawList();
  list.reset(1, true);
  list.image(img('a'), null, 0, 0, 1, 1);
  const item = list.items[0] as Extract<DrawItem, { kind: 'image' }>;
  assert.equal(item.whole, true);
  assert.equal(item.fallback, null);
  assert.equal(item.stat, 'none');
});

test('colors carry matching css and float forms', () => {
  assert.equal(BLANK_FILL.css, '#15120f');
  assert.deepEqual(BLANK_FILL.rgb, [0x15 / 255, 0x12 / 255, 0x0f / 255]);
  assert.equal(FADE_FILL.css, '#000000');
});

test('assertNever throws on an item kind no painter handles', () => {
  assert.throws(() => assertNever({ kind: 'mystery' } as never), /unknown draw item/);
});
