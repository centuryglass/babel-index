#!/usr/bin/env node
/**
 * Turn the hand-drawn Inkscape tracing of the Blender render into exact tile
 * geometry.
 *
 *   node tools/base-image/import-shelf-svg.mjs <shelf_geometry.svg> [--out <file>]
 *
 * Conventions in that file, per the author:
 *   black rects  -> book spines
 *   red rects    -> the front face of the shelves (horizontal boards, plus the
 *                   two vertical uprights of the case)
 *   white circle -> the lamp
 *
 * Everything is emitted normalised to the tile edge (0-1), so it is resolution
 * independent. Tracing by hand in Inkscape is five minutes of work and avoids
 * parsing the .blend, which would be a lot of machinery for the same numbers.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
if (!src) {
  console.error('usage: import-shelf-svg.mjs <shelf_geometry.svg> [--out <file>]');
  process.exit(1);
}
const outPath = resolve(
  process.cwd(),
  args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'tools/base-image/lib/measured.js'
);

const svg = await readFile(resolve(process.cwd(), src), 'utf8');

const vb = /viewBox="([\d.\-\s]+)"/.exec(svg);
if (!vb) throw new Error('no viewBox');
const [, , vbW, vbH] = vb[1].trim().split(/\s+/).map(Number);

// Inkscape wraps content in a layer group with its own translate. Anything
// beyond a translate would silently skew the numbers, so refuse it instead.
let tx = 0;
let ty = 0;
for (const g of svg.matchAll(/<g\b[\s\S]*?>/g)) {
  const t = /transform\s*=\s*"([^"]*)"/.exec(g[0]);
  if (!t) continue;
  const translate = /^translate\(\s*([-\d.]+)\s*[, ]\s*([-\d.]+)\s*\)$/.exec(t[1].trim());
  if (!translate) throw new Error(`unsupported group transform: ${t[1]}`);
  tx += Number(translate[1]);
  ty += Number(translate[2]);
}

function attr(tag, name) {
  const direct = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  if (direct) return direct[1].trim();
  const style = /\bstyle\s*=\s*"([^"]*)"/.exec(tag);
  if (style) {
    const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style[1]);
    if (m) return m[1].trim();
  }
  return null;
}

function classify(fill) {
  if (!fill) return 'other';
  const c = fill.toLowerCase().replace(/\s/g, '');
  let r, g, b;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (d) => d + d) : hex[1];
    [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const rgb = /^rgb\((\d+),(\d+),(\d+)\)/.exec(c);
    if (rgb) [r, g, b] = rgb.slice(1).map(Number);
    else if (c === 'black') [r, g, b] = [0, 0, 0];
    else if (c === 'red') [r, g, b] = [255, 0, 0];
    else if (c === 'white') [r, g, b] = [255, 255, 255];
    else return 'other';
  }
  if (r < 60 && g < 60 && b < 60) return 'spine';
  if (r > 140 && g < 100 && b < 100) return 'shelfFace';
  if (r > 200 && g > 200 && b > 200) return 'lamp';
  return 'other';
}

const round = (v) => Math.round(v * 1e5) / 1e5;

const rects = [];
for (const m of svg.matchAll(/<rect\b[\s\S]*?\/>/g)) {
  const tag = m[0];
  const x = Number(attr(tag, 'x')) + tx;
  const y = Number(attr(tag, 'y')) + ty;
  const w = Number(attr(tag, 'width'));
  const h = Number(attr(tag, 'height'));
  if ([x, y, w, h].some(Number.isNaN)) continue;
  rects.push({ kind: classify(attr(tag, 'fill')), x, y, w, h });
}

let lamp = null;
const circleTag = /<circle\b[\s\S]*?\/>/.exec(svg);
if (circleTag) {
  lamp = {
    cx: Number(attr(circleTag[0], 'cx')) + tx,
    cy: Number(attr(circleTag[0], 'cy')) + ty,
    r: Number(attr(circleTag[0], 'r')),
  };
}

const spines = rects.filter((r) => r.kind === 'spine');
const red = rects.filter((r) => r.kind === 'shelfFace');
const other = rects.filter((r) => r.kind === 'other');

// Red rects are either horizontal boards (wide and thin) or the case uprights.
const boards = red.filter((r) => r.w > r.h).sort((a, b) => a.y - b.y);
const uprights = red.filter((r) => r.h >= r.w).sort((a, b) => a.x - b.x);

// N boards delimit N-1 shelf bays. A spine belongs to the bay its base sits in.
const bays = [];
for (let i = 0; i < boards.length - 1; i++) {
  const top = boards[i].y + boards[i].h;
  const bottom = boards[i + 1].y + boards[i + 1].h;
  bays.push({
    index: i,
    top,
    bottom,
    board: boards[i + 1],
    books: spines
      .filter((s) => s.y + s.h > top && s.y + s.h <= bottom + 1e-6)
      .sort((a, b) => a.x - b.x),
  });
}

const placed = bays.reduce((n, b) => n + b.books.length, 0);

const nx = (v) => round(v / vbW);
const ny = (v) => round(v / vbH);
const nrect = (r) => [nx(r.x), ny(r.y), nx(r.w), ny(r.h)];

const opening = {
  x: uprights.length ? uprights[0].x + uprights[0].w : Math.min(...spines.map((s) => s.x)),
  y: boards[0].y + boards[0].h,
  get w() {
    return uprights.length > 1 ? uprights[1].x - this.x : Math.max(...spines.map((s) => s.x + s.w)) - this.x;
  },
  get h() {
    return boards[boards.length - 1].y + boards[boards.length - 1].h - this.y;
  },
};
const openingRect = { x: opening.x, y: opening.y, w: opening.w, h: opening.h };

console.log(
  `viewBox ${round(vbW)} x ${round(vbH)} (aspect ${round(vbH / vbW)}), ` +
    `layer translate ${round(tx)},${round(ty)}`
);
console.log('  -> BASE_TILE in packages/web/src/pyramid.js must match this aspect');
console.log(`rects ${rects.length}: ${spines.length} spines, ${boards.length} boards, ${uprights.length} uprights, ${other.length} unclassified`);
console.log(`lamp: ${lamp ? `${nx(lamp.cx)}, ${ny(lamp.cy)}  r ${nx(lamp.r)}` : 'MISSING'}`);
console.log(`opening: ${nrect(openingRect).join(', ')}`);
console.log(`\n${bays.length} shelf bays, ${placed}/${spines.length} spines placed:`);
for (const b of bays)
  console.log(`  bay ${b.index}: ${b.books.length} books   y ${round(b.top)} .. ${round(b.bottom)}`);

const problems = [];
if (other.length) problems.push(`${other.length} rects could not be classified by colour`);
if (placed !== spines.length) problems.push(`${spines.length - placed} spines fell outside every bay`);
const counts = [...new Set(bays.map((b) => b.books.length))];
if (counts.length !== 1) problems.push(`bays hold differing book counts: ${bays.map((b) => b.books.length).join(', ')}`);
if (problems.length) {
  console.error('\nPROBLEMS:');
  for (const p of problems) console.error(`  ! ${p}`);
  process.exitCode = 1;
}

const body = `/**
 * Tile geometry measured from the Blender render.
 *
 * GENERATED by tools/base-image/import-shelf-svg.mjs from ${basename(src)}.
 * Do not edit by hand - re-trace in Inkscape and re-run the importer.
 *
 * Values are normalised to the tile edge (0-1), x against the traced width and
 * y against the traced height, so they carry no aspect of their own. \`tile\`
 * records the shape they were traced at, because that is the one thing the
 * normalisation throws away and the one thing that has to keep agreeing with
 * BASE_TILE in packages/web/src/pyramid.js.
 *
 * Rects are [x, y, w, h]. The lamp's radius is normalised against WIDTH alone,
 * because the lamp is a circle and stays one - see lib/geometry.js.
 */

export const MEASURED = {
  source: ${JSON.stringify(basename(src))},
  tile: { w: ${round(vbW)}, h: ${round(vbH)}, aspect: ${round(vbH / vbW)} },
  lamp: ${lamp ? `{ cx: ${nx(lamp.cx)}, cy: ${ny(lamp.cy)}, r: ${nx(lamp.r)} }` : 'null'},
  opening: [${nrect(openingRect).join(', ')}],
  uprights: [
${uprights.map((u) => `    [${nrect(u).join(', ')}],`).join('\n')}
  ],
  shelves: [
${bays
  .map(
    (b) => `    {
      board: [${nrect(b.board).join(', ')}],
      books: [
${b.books.map((k) => `        [${nrect(k).join(', ')}],`).join('\n')}
      ],
    },`
  )
  .join('\n')}
  ],
};

export const SHELF_COUNT = ${bays.length};
export const BOOKS_PER_SHELF = ${bays[0]?.books.length ?? 0};
`;

await writeFile(outPath, body);
console.log(`\nwrote ${outPath}`);
