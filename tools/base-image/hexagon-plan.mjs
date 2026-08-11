#!/usr/bin/env node
/**
 * Documentation figure: what one tile is.
 *
 *   node tools/base-image/hexagon-plan.mjs [--out=docs/figures]
 *
 * A tile is one shelved wall, not a room. Four of them are the shelved sides of
 * a gallery; the map is a grid of walls, which is a repeating unit that tiles
 * cleanly rather than a reconstruction of the architecture.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { el, svg } from './lib/svg.js';
import { STORY } from './lib/story.js';

const outDir = resolve(
  process.cwd(),
  process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'docs/figures'
);

const W = 780;
const H = 400;
const cx = 175;
const cy = 185;
const R = 115;

const vertex = (i) => {
  const a = (Math.PI / 3) * i + Math.PI / 6;
  return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
};

const SIDES = [
  { i: 0, kind: 'shelves' },
  { i: 1, kind: 'shelves' },
  { i: 2, kind: 'free' },
  { i: 3, kind: 'shelves' },
  { i: 4, kind: 'shelves' },
  { i: 5, kind: 'free' },
];

const C = { shelves: '#6b5c46', free: '#b8b0a4', ink: '#2b2620', accent: '#b8563f' };

const text = (x, y, s, extra = {}) =>
  el('text', {
    x, y,
    'font-family': 'ui-sans-serif, system-ui, sans-serif',
    'font-size': 13,
    fill: C.ink,
    ...extra,
  }, s);

const plan = [
  el('polygon', {
    points: Array.from({ length: 6 }, (_, i) => vertex(i).join(',')).join(' '),
    fill: '#f4efe6', stroke: '#c9c0b4', 'stroke-width': 1,
  }),
];

for (const side of SIDES) {
  const [x1, y1] = vertex(side.i);
  const [x2, y2] = vertex(side.i + 1);
  const highlight = side.i === 0;
  plan.push(
    el('line', {
      x1, y1, x2, y2,
      stroke: highlight ? C.accent : C[side.kind],
      'stroke-width': highlight ? 11 : 8,
      'stroke-linecap': 'round',
    })
  );
}

const [ax, ay] = vertex(0);
const [bx, by] = vertex(1);
plan.push(
  text(cx + ((ax + bx) / 2 - cx) * 1.5, cy + ((ay + by) / 2 - cy) * 1.5, 'one tile', {
    'text-anchor': 'middle', 'dominant-baseline': 'middle',
    fill: C.accent, 'font-weight': 600,
  })
);
plan.push(text(cx, 40, 'one gallery, in plan', { 'text-anchor': 'middle', 'font-weight': 600 }));
plan.push(text(cx, 366, '4 shelved sides, 2 free', { 'text-anchor': 'middle', fill: '#8a8177' }));

// The tile itself: a bookcase elevation.
const tx = 420;
const ty = 78;
const tw = 210;
const th = 210;
const shelfH = (th * 0.72) / STORY.shelvesPerSide;

const tile = [
  el('rect', { x: tx, y: ty, width: tw, height: th, fill: '#2a251e' }),
  el('rect', { x: tx, y: ty, width: tw * 0.09, height: th, fill: '#16130f' }),
  el('rect', { x: tx + tw * 0.91, y: ty, width: tw * 0.09, height: th, fill: '#16130f' }),
  el('circle', { cx: tx + tw / 2, cy: ty + th * 0.11, r: 7, fill: '#f4e3bb' }),
];
for (let s = 0; s < STORY.shelvesPerSide; s++) {
  const y = ty + th * 0.2 + s * shelfH;
  tile.push(el('rect', { x: tx + tw * 0.16, y, width: tw * 0.68, height: shelfH * 0.78, fill: '#6a563c' }));
  tile.push(el('rect', { x: tx + tw * 0.16, y: y + shelfH * 0.78, width: tw * 0.68, height: shelfH * 0.16, fill: '#8a7659' }));
}

await mkdir(outDir, { recursive: true });
await writeFile(
  join(outDir, 'hexagon-plan.svg'),
  svg({
    width: W, height: H,
    children: [
      el('rect', { x: 0, y: 0, width: W, height: H, fill: '#ffffff' }),
      ...plan,
      ...tile,
      el('rect', { x: tx, y: ty, width: tw, height: th, fill: 'none', stroke: C.accent, 'stroke-width': 2 }),
      text(tx + tw / 2, 40, 'one tile', { 'text-anchor': 'middle', 'font-weight': 600, fill: C.accent }),
      text(tx, ty + th + 26, `${STORY.shelvesPerSide} shelves x ${STORY.booksPerShelf} books = ${STORY.shelvesPerSide * STORY.booksPerShelf} books`),
      text(tx, ty + th + 44, `4 tiles = one gallery = ${STORY.booksPerGallery} books`),
      text(tx, ty + th + 62, 'the dark side returns are the frame:', { fill: '#8a8177' }),
      text(tx, ty + th + 80, 'never inpainted, so tiles always meet', { fill: '#8a8177' }),
    ],
  })
);
console.log(`wrote ${join(outDir, 'hexagon-plan.svg')}`);
