#!/usr/bin/env node
/**
 * Turn the hand-drawn Inkscape tracing of the Blender render into exact tile
 * geometry.
 *
 *   node tools/center-placement/import-shelf-svg.ts <shelf_geometry.svg> [--out <file>]
 *
 * Conventions in that file, per the author:
 *   rect labelled "search_box"   -> where the live search field sits
 *   rects labelled "book0".."bookN" -> book spines, addressed by that label
 *
 * That is the whole trace now - no board, upright or lamp is read from the
 * SVG any more. Only the label is authoritative; fill colour is decorative.
 * Spines are grouped into shelves purely by y - the trace gives every book on
 * one shelf the same y, so no board or upright needs to be traced to find the
 * bays. A shelf's books need not be evenly spaced or contiguous across x: a
 * gap wider than a book (art occupying part of the shelf, say) simply means
 * that shelf has more than one addressable run, and it is left to the
 * consumer (center.js) to treat those runs as separate clusters for
 * hit-testing.
 *
 * Everything is emitted normalised to the tile edge (0-1), so it is resolution
 * independent. Tracing by hand in Inkscape is five minutes of work and avoids
 * parsing the .blend, which would be a lot of machinery for the same numbers.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

interface TracedRect {
  label: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ShelfRow {
  y: number;
  books: TracedRect[];
}

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
if (!src) {
  console.error('usage: import-shelf-svg.ts <shelf_geometry.svg> [--out <file>]');
  process.exit(1);
}
const outPath = resolve(
  process.cwd(),
  args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'tools/center-placement/lib/measured.ts'
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

function attr(tag: string, name: string): string | null {
  const direct = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  if (direct) return direct[1].trim();
  const style = /\bstyle\s*=\s*"([^"]*)"/.exec(tag);
  if (style) {
    const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style[1]);
    if (m) return m[1].trim();
  }
  return null;
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;

const rects: TracedRect[] = [];
for (const m of svg.matchAll(/<rect\b[\s\S]*?\/>/g)) {
  const tag = m[0];
  const x = Number(attr(tag, 'x')) + tx;
  const y = Number(attr(tag, 'y')) + ty;
  const w = Number(attr(tag, 'width'));
  const h = Number(attr(tag, 'height'));
  if ([x, y, w, h].some(Number.isNaN)) continue;
  rects.push({ label: attr(tag, 'inkscape:label'), x, y, w, h });
}

const searchBoxRects = rects.filter((r) => r.label === 'search_box');
const spines = rects
  .filter((r) => /^book\d+$/.test(r.label ?? ''))
  .sort((a, b) => a.y - b.y || a.x - b.x);
const other = rects.filter((r) => r !== searchBoxRects[0] && !/^book\d+$/.test(r.label ?? ''));

// Every book on one shelf shares its y in the trace - no board or upright is
// needed to find the bays. A small tolerance absorbs sub-pixel trace noise
// without merging two genuinely different shelves, which in practice sit tens
// of units apart.
const ROW_EPSILON = vbH * 0.01;
const shelves: ShelfRow[] = [];
for (const s of spines) {
  const row = shelves.find((r) => Math.abs(r.y - s.y) <= ROW_EPSILON);
  if (row) row.books.push(s);
  else shelves.push({ y: s.y, books: [s] });
}
shelves.sort((a, b) => a.y - b.y);
for (const row of shelves) row.books.sort((a, b) => a.x - b.x);

const nx = (v: number) => round(v / vbW);
const ny = (v: number) => round(v / vbH);
const nrect = (r: { x: number; y: number; w: number; h: number }) => [nx(r.x), ny(r.y), nx(r.w), ny(r.h)];

// No case uprights are traced any more, so the opening is simply the bounding
// box of every book on the wall - the thing a reader comes to read.
const openingRect = {
  x: Math.min(...spines.map((s) => s.x)),
  y: Math.min(...spines.map((s) => s.y)),
  get w() {
    return Math.max(...spines.map((s) => s.x + s.w)) - this.x;
  },
  get h() {
    return Math.max(...spines.map((s) => s.y + s.h)) - this.y;
  },
};

const searchBox = searchBoxRects[0] ?? null;

console.log(
  `viewBox ${round(vbW)} x ${round(vbH)} (aspect ${round(vbH / vbW)}), ` +
    `layer translate ${round(tx)},${round(ty)}`
);
console.log('  -> BASE_TILE in packages/web/src/lib/pyramid.js must match this aspect');
console.log(`rects ${rects.length}: ${spines.length} books, ${searchBoxRects.length} search_box, ${other.length} unlabelled`);
console.log(`search_box: ${searchBox ? nrect(searchBox).join(', ') : 'MISSING'}`);
console.log(`opening: ${nrect(openingRect).join(', ')}`);
console.log(`\n${shelves.length} shelves, ${spines.length} books total:`);
for (const [i, row] of shelves.entries())
  console.log(`  shelf ${i}: ${row.books.length} books   y ${round(row.y)}`);

const problems: string[] = [];
if (other.length) problems.push(`${other.length} rects had no recognised label (book<n> or search_box)`);
if (searchBoxRects.length > 1) problems.push(`${searchBoxRects.length} rects labelled search_box, expected one`);
if (!searchBox) problems.push('no rect labelled search_box');
if (!spines.length) problems.push('no rects labelled book<n>');
if (problems.length) {
  console.error('\nPROBLEMS:');
  for (const p of problems) console.error(`  ! ${p}`);
  process.exitCode = 1;
}

const body = `/**
 * Tile geometry measured from the Blender render.
 *
 * GENERATED by tools/center-placement/import-shelf-svg.ts from ${basename(src)}.
 * Do not edit by hand - re-trace in Inkscape and re-run the importer.
 *
 * Values are normalised to the tile edge (0-1), x against the traced width and
 * y against the traced height, so they carry no aspect of their own. \`tile\`
 * records the shape they were traced at, because that is the one thing the
 * normalisation throws away and the one thing that has to keep agreeing with
 * BASE_TILE in packages/web/src/lib/pyramid.js.
 *
 * Rects are [x, y, w, h].
 */

export type RectTuple = [number, number, number, number];

export interface MeasuredData {
  source: string;
  tile: { w: number; h: number; aspect: number };
  opening: RectTuple;
  searchBox: RectTuple | null;
  shelves: { books: RectTuple[] }[];
}

export const MEASURED: MeasuredData = {
  source: ${JSON.stringify(basename(src))},
  tile: { w: ${round(vbW)}, h: ${round(vbH)}, aspect: ${round(vbH / vbW)} },
  opening: [${nrect(openingRect).join(', ')}],
  searchBox: ${searchBox ? `[${nrect(searchBox).join(', ')}]` : 'null'},
  shelves: [
${shelves
  .map(
    (row) => `    {
      books: [
${row.books.map((k) => `        [${nrect(k).join(', ')}],`).join('\n')}
      ],
    },`
  )
  .join('\n')}
  ],
};

export const SHELF_COUNT = ${shelves.length};
export const BOOK_COUNT = ${spines.length};
`;

await writeFile(outPath, body);
console.log(`\nwrote ${outPath}`);
