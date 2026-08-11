#!/usr/bin/env node
/**
 * Documentation figure: the hexagon in plan, and how it unrolls into the tile.
 *
 *   node tools/base-image/hexagon-plan.mjs [--out docs/figures]
 *
 * This is not a game asset - it exists to make the projection decision in
 * geometry.js legible.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { el, svg } from './lib/svg.js';

const outDir = resolve(
  process.cwd(),
  process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'docs/figures'
);

const W = 760;
const H = 360;
const cx = 180;
const cy = 180;
const R = 120;

// Side i spans from vertex i to vertex i+1. Flat-top hexagon, side 0 at the
// left so the cut lands where the tile edge lands.
const vertex = (i) => {
  const a = (Math.PI / 3) * i + Math.PI / 6;
  return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
};

const SIDES = [
  { i: 0, kind: 'shelves', label: 'shelves' },
  { i: 1, kind: 'shelves', label: 'shelves' },
  { i: 2, kind: 'hallway', label: 'hallway' },
  { i: 3, kind: 'shelves', label: 'shelves' },
  { i: 4, kind: 'shelves', label: 'shelves' },
  { i: 5, kind: 'shaft', label: 'air shaft' },
];

const COLOR = {
  shelves: '#6b5c46',
  hallway: '#b8563f',
  shaft: '#3f6b8a',
  ink: '#2b2620',
  faint: '#9c9287',
};

const plan = [
  el('polygon', {
    points: Array.from({ length: 6 }, (_, i) => vertex(i).join(',')).join(' '),
    fill: '#f4efe6',
    stroke: COLOR.faint,
    'stroke-width': 1,
  }),
];

for (const side of SIDES) {
  const [x1, y1] = vertex(side.i);
  const [x2, y2] = vertex(side.i + 1);
  plan.push(
    el('line', {
      x1, y1, x2, y2,
      stroke: COLOR[side.kind],
      'stroke-width': 9,
      'stroke-linecap': 'round',
    })
  );
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  plan.push(
    el(
      'text',
      {
        x: cx + (mx - cx) * 1.42,
        y: cy + (my - cy) * 1.42,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
        'font-family': 'ui-sans-serif, system-ui, sans-serif',
        'font-size': 13,
        fill: COLOR[side.kind],
      },
      side.label
    )
  );
}

// The cut: the hallway side is split, so it lands half on each tile edge.
const [hx1, hy1] = vertex(2);
const [hx2, hy2] = vertex(3);
plan.push(
  el('line', {
    x1: (hx1 + hx2) / 2 - 30,
    y1: (hy1 + hy2) / 2 + 30,
    x2: (hx1 + hx2) / 2 + 30,
    y2: (hy1 + hy2) / 2 - 30,
    stroke: COLOR.ink,
    'stroke-width': 1.5,
    'stroke-dasharray': '5 4',
  })
);

// The unrolled strip.
const stripX = 380;
const stripY = 120;
const stripW = 340;
const stripH = 120;
const order = [
  { kind: 'hallway', frac: 0.5, label: '½' },
  { kind: 'shelves', frac: 1 },
  { kind: 'shelves', frac: 1 },
  { kind: 'shaft', frac: 1 },
  { kind: 'shelves', frac: 1 },
  { kind: 'shelves', frac: 1 },
  { kind: 'hallway', frac: 0.5, label: '½' },
];
const unit = stripW / order.reduce((a, s) => a + s.frac, 0);

const strip = [];
let x = stripX;
for (const seg of order) {
  const w = unit * seg.frac;
  strip.push(
    el('rect', {
      x, y: stripY, width: w, height: stripH,
      fill: COLOR[seg.kind],
      'fill-opacity': seg.kind === 'shelves' ? 0.75 : 0.85,
      stroke: '#ffffff',
      'stroke-width': 1,
    })
  );
  x += w;
}
strip.push(
  el('rect', {
    x: stripX, y: stripY, width: stripW, height: stripH,
    fill: 'none', stroke: COLOR.ink, 'stroke-width': 2,
  })
);

const text = (x, y, s, extra = {}) =>
  el(
    'text',
    {
      x, y,
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
      'font-size': 13,
      fill: COLOR.ink,
      ...extra,
    },
    s
  );

const figure = svg({
  width: W,
  height: H,
  children: [
    el('rect', { x: 0, y: 0, width: W, height: H, fill: '#ffffff' }),
    ...plan,
    text(cx, 40, 'one gallery, in plan', { 'text-anchor': 'middle', 'font-weight': 600 }),
    ...strip,
    text(stripX + stripW / 2, 100, 'unrolled into one tile', {
      'text-anchor': 'middle', 'font-weight': 600,
    }),
    text(stripX, stripY + stripH + 24, 'the hallway is cut in half:'),
    text(stripX, stripY + stripH + 42, 'half at each tile edge, so it'),
    text(stripX, stripY + stripH + 60, 'reassembles when tiles abut.'),
    el('line', {
      x1: stripX, y1: stripY - 10, x2: stripX, y2: stripY + stripH + 10,
      stroke: COLOR.ink, 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
    }),
    el('line', {
      x1: stripX + stripW, y1: stripY - 10, x2: stripX + stripW, y2: stripY + stripH + 10,
      stroke: COLOR.ink, 'stroke-width': 1.5, 'stroke-dasharray': '5 4',
    }),
  ],
});

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'hexagon-plan.svg'), figure);
console.log(`wrote ${join(outDir, 'hexagon-plan.svg')}`);
