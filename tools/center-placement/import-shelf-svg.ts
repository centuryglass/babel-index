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
 *   path labelled "center_book"  -> the open book painted into a shelf gap,
 *                                   a distinct hotspot from the lettered books
 *   path labelled "distill_off"  -> the "enable distillation" icon's outline,
 *                                   traced over the whole tile like center_book
 *   path labelled "distill_on"   -> the "disable distillation" icon's outline,
 *                                   same treatment as distill_off
 *   rect labelled "fav_mine_toggle"  -> hit region for the "my favorites" sort switch
 *   rect labelled "fav_count_toggle" -> hit region for the "most favorited" sort switch
 *   rect labelled "shuffle_button"   -> hit region for the reorder control
 *   ellipse labelled "tile_fav_toggle" -> the on-tile favorite badge's
 *                                         non-transparent silhouette, traced
 *                                         over the whole tile (not just the
 *                                         badge's own icon) so it lands in
 *                                         the same per-axis fraction space as
 *                                         every other traced element
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
 * `center_book` is traced as a `<path>`, not a `<rect>` - it is the silhouette
 * of an open book, not a spine, and the point of tracing it as a path rather
 * than another box is that the hover/hit region and the highlight drawn on
 * screen are the SHAPE, not a rectangle loose enough to lap onto the spines
 * either side of it. The importer re-serialises the traced `d` into one
 * canonical, tile-normalised grammar (see `normalizePath`) rather than
 * reducing it to a box; a bounding box is still reported alongside it for
 * anything that only needs a quick containment check.
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

/** Argument count per path command letter, uppercased; A(rc) is unsupported. */
const PATH_ARG_COUNT: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, Z: 0, A: 7,
};

/**
 * Re-serialise a `<path>`'s `d` into ONE canonical grammar - absolute M/L/C/Z
 * only, every number a tile-normalised (x/vbW, y/vbH) coordinate - and report
 * its bounding box (over on-curve AND control points, which for a cubic
 * Bezier never underestimates the true bound: the curve stays inside the hull
 * of its control points).
 *
 * Collapsing H/V/M-repeat/relative-vs-absolute into this one grammar is what
 * lets the consumer (`center.ts`) hand the string straight to an SVG
 * `<path d>` with no further interpretation, and what lets `geometry.ts`
 * rescale it for an arbitrary tile size with a single regex over `x,y` pairs
 * rather than a second copy of this walk. S/Q/T are refused rather than
 * silently mishandled - the hand traced silhouette this importer exists for
 * has never needed them (see the trace itself, not a claim this file makes).
 * `A` is accepted but APPROXIMATED as a lineto to its own endpoint, dropping
 * the curve - `distill_off`/`distill_on`'s Inkscape-rounded corners are a
 * couple of pixels of fillet on a tile-sized icon, invisible at the sampled
 * precision a hover highlight needs (the same tradeoff `flattenPath` makes
 * sampling a real cubic), and worth it against hand-deriving the elliptical
 * arc-to-Bezier conversion for a curve nobody will ever see the difference on.
 */
function normalizePath(d: string, tx: number, ty: number, vbW: number, vbH: number) {
  const tokens = d.match(/[MmLlHhVvCcZzAa]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const out: string[] = [];
  const nx = (v: number) => round((v + tx) / vbW);
  const ny = (v: number) => round((v + ty) / vbH);
  const visit = (x: number, y: number) => {
    minX = Math.min(minX, x + tx);
    minY = Math.min(minY, y + ty);
    maxX = Math.max(maxX, x + tx);
    maxY = Math.max(maxY, y + ty);
  };
  let cmd: string | null = null;
  // Whether the current outer-loop pass is reading the FIRST pair after a
  // command letter (true) or a REPEATED pair with no new letter in between
  // (false). Only matters for M: SVG defines a repeated pair after the first
  // in an 'M'/'m' as an implicit LINETO, not a second moveto - miss that and
  // every repeat comes out as a stray, disconnected subpath.
  let firstOfRun = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      i++;
      firstOfRun = true;
    }
    if (!cmd) throw new Error(`path has no leading command: ${d.slice(0, 40)}`);
    const letter = cmd.toUpperCase();
    if (!(letter in PATH_ARG_COUNT))
      throw new Error(`path command '${letter}' is not supported by the importer (only M/L/H/V/C/Z/A)`);
    const relative = cmd === cmd.toLowerCase();
    const argc = PATH_ARG_COUNT[letter];
    if (letter === 'Z') {
      // Consumes no arguments; `i` already points past the command letter.
      cx = startX;
      cy = startY;
      out.push('Z');
      firstOfRun = false;
      continue;
    }
    const nums = tokens.slice(i, i + argc).map(Number);
    if (nums.length < argc) break;
    i += argc;
    if (letter === 'H') {
      cx = relative ? cx + nums[0] : nums[0];
      visit(cx, cy);
      out.push(`L${nx(cx)},${ny(cy)}`);
    } else if (letter === 'V') {
      cy = relative ? cy + nums[0] : nums[0];
      visit(cx, cy);
      out.push(`L${nx(cx)},${ny(cy)}`);
    } else if (letter === 'A') {
      // rx, ry, x-axis-rotation and the two flags (nums[0..4]) are dropped -
      // see this function's doc comment on why the curve is approximated
      // rather than converted.
      cx = relative ? cx + nums[5] : nums[5];
      cy = relative ? cy + nums[6] : nums[6];
      visit(cx, cy);
      out.push(`L${nx(cx)},${ny(cy)}`);
    } else if (letter === 'C') {
      // A cubic's three pairs (two control points, one endpoint) are ALL
      // relative to the point BEFORE this curve - never chained pair to pair,
      // which is the mistake that sent a control point rocketing off toward
      // wherever the previous control point happened to land. Only the
      // endpoint (the third pair) becomes the new current point.
      const rx = cx;
      const ry = cy;
      const points: string[] = [];
      for (let p = 0; p < 6; p += 2) {
        const x = relative ? rx + nums[p] : nums[p];
        const y = relative ? ry + nums[p + 1] : nums[p + 1];
        visit(x, y);
        points.push(`${nx(x)},${ny(y)}`);
        if (p === 4) {
          cx = x;
          cy = y;
        }
      }
      out.push(`C${points.join(' ')}`);
    } else {
      // M and L's args are (x, y) pairs; a repeat (no new letter) is chained
      // off the point the PREVIOUS pair just landed on, which is what makes
      // this loop, unlike C's above, walk px/py forward pair by pair.
      let px = cx;
      let py = cy;
      const points: string[] = [];
      for (let p = 0; p < argc; p += 2) {
        const x = relative ? px + nums[p] : nums[p];
        const y = relative ? py + nums[p + 1] : nums[p + 1];
        visit(x, y);
        points.push(`${nx(x)},${ny(y)}`);
        px = x;
        py = y;
      }
      cx = px;
      cy = py;
      out.push(`${letter === 'M' && firstOfRun ? 'M' : 'L'}${points[0]}`);
      if (letter === 'M' && firstOfRun) {
        startX = cx;
        startY = cy;
      }
    }
    firstOfRun = false;
  }
  if (!Number.isFinite(minX)) throw new Error(`empty or unparsable path: ${d.slice(0, 60)}`);
  return {
    d: out.join(' '),
    bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
  };
}

/** A 2x3 affine matrix, as an SVG `matrix(a,b,c,d,e,f)` transform names it. */
interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

function parseMatrix(transform: string | null): Matrix | null {
  if (!transform) return null;
  const m = /matrix\(\s*([^)]+)\)/.exec(transform);
  if (!m) throw new Error(`unsupported element transform: ${transform}`);
  const [a, b, c, d, e, f] = m[1].trim().split(/[\s,]+/).map(Number);
  return { a, b, c, d, e, f };
}

const applyMatrix = (mat: Matrix, x: number, y: number): [number, number] => [
  mat.a * x + mat.c * y + mat.e,
  mat.b * x + mat.d * y + mat.f,
];

/** Circle/ellipse -> 4 cubic Beziers, the standard `kappa` control-point offset. */
const ELLIPSE_KAPPA = 0.5522847498;

/**
 * Turn a traced `<ellipse>` (with its own `transform`, if any) into the same
 * canonical absolute M/L/C/Z grammar `normalizePath` emits for a `<path>` -
 * so `tile_fav_toggle` reaches `center.ts`/`favoriteBadge.ts` exactly like
 * `center_book` does, and the two consumers do not need to know one shape
 * started life as an ellipse. Approximated as 4 cubic Beziers (the standard
 * `kappa` construction) rather than solved exactly - close enough that the
 * boundary looks right at screen resolution, same tradeoff `flattenPath` in
 * `center.ts` makes for a hover hit-test.
 */
function ellipseToPath(
  cx: number, cy: number, rx: number, ry: number,
  mat: Matrix | null, tx: number, ty: number, vbW: number, vbH: number
) {
  const k = ELLIPSE_KAPPA;
  const local: [number, number][] = [
    [cx + rx, cy], [cx + rx, cy + ry * k], [cx + rx * k, cy + ry], [cx, cy + ry],
    [cx - rx * k, cy + ry], [cx - rx, cy + ry * k], [cx - rx, cy], [cx - rx, cy - ry * k],
    [cx - rx * k, cy - ry], [cx, cy - ry], [cx + rx * k, cy - ry], [cx + rx, cy - ry * k],
  ];
  // Raw (pre-normalisation) points for the bbox - `nrect` at the template's
  // output site divides by vbW/vbH itself, same convention `normalizePath`'s
  // bbox uses, so the two shapes go through one normalisation path rather
  // than this function guessing which callers already divided.
  const raw = local.map(([x, y]) => {
    const [tx0, ty0] = mat ? applyMatrix(mat, x, y) : [x, y];
    return [tx0 + tx, ty0 + ty] as [number, number];
  });
  const norm = raw.map(([x, y]) => [round(x / vbW), round(y / vbH)] as [number, number]);
  const [p0, c01a, c01b, p1, c12a, c12b, p2, c23a, c23b, p3, c30a, c30b] = norm;
  const seg = (c1: [number, number], c2: [number, number], end: [number, number]) =>
    `C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${end[0]},${end[1]}`;
  const d = [
    `M${p0[0]},${p0[1]}`,
    seg(c01a, c01b, p1),
    seg(c12a, c12b, p2),
    seg(c23a, c23b, p3),
    seg(c30a, c30b, p0),
    'Z',
  ].join(' ');
  const xs = raw.map((p) => p[0]);
  const ys = raw.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    d,
    bbox: { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY },
  };
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

const centerBookPaths: { d: string; bbox: { x: number; y: number; w: number; h: number } }[] = [];
const distillOffPaths: { d: string; bbox: { x: number; y: number; w: number; h: number } }[] = [];
const distillOnPaths: { d: string; bbox: { x: number; y: number; w: number; h: number } }[] = [];
for (const m of svg.matchAll(/<path\b[\s\S]*?\/>/g)) {
  const tag = m[0];
  const label = attr(tag, 'inkscape:label');
  if (label !== 'center_book' && label !== 'distill_off' && label !== 'distill_on') continue;
  const rawD = attr(tag, 'd');
  if (!rawD) continue;
  const normalized = normalizePath(rawD, tx, ty, vbW, vbH);
  if (label === 'center_book') centerBookPaths.push(normalized);
  else if (label === 'distill_off') distillOffPaths.push(normalized);
  else distillOnPaths.push(normalized);
}

const favoriteTogglePaths: { d: string; bbox: { x: number; y: number; w: number; h: number } }[] = [];
for (const m of svg.matchAll(/<ellipse\b[\s\S]*?\/>/g)) {
  const tag = m[0];
  if (attr(tag, 'inkscape:label') !== 'tile_fav_toggle') continue;
  const cx = Number(attr(tag, 'cx'));
  const cy = Number(attr(tag, 'cy'));
  const rx = Number(attr(tag, 'rx'));
  const ry = Number(attr(tag, 'ry'));
  if ([cx, cy, rx, ry].some(Number.isNaN)) continue;
  const mat = parseMatrix(attr(tag, 'transform'));
  favoriteTogglePaths.push(ellipseToPath(cx, cy, rx, ry, mat, tx, ty, vbW, vbH));
}

const searchBoxRects = rects.filter((r) => r.label === 'search_box');
const mineToggleRects = rects.filter((r) => r.label === 'fav_mine_toggle');
const countToggleRects = rects.filter((r) => r.label === 'fav_count_toggle');
const shuffleRects = rects.filter((r) => r.label === 'shuffle_button');
const spines = rects
  .filter((r) => /^book\d+$/.test(r.label ?? ''))
  .sort((a, b) => a.y - b.y || a.x - b.x);
const NAMED_SINGLETON_LABELS = new Set([
  'search_box', 'fav_mine_toggle', 'fav_count_toggle', 'shuffle_button',
]);
const other = rects.filter(
  (r) => !NAMED_SINGLETON_LABELS.has(r.label ?? '') && !/^book\d+$/.test(r.label ?? '')
);

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
const mineToggle = mineToggleRects[0] ?? null;
const countToggle = countToggleRects[0] ?? null;
const shuffleButton = shuffleRects[0] ?? null;
const centerBook = centerBookPaths[0] ?? null;
const distillOff = distillOffPaths[0] ?? null;
const distillOn = distillOnPaths[0] ?? null;
const favoriteToggle = favoriteTogglePaths[0] ?? null;

console.log(
  `viewBox ${round(vbW)} x ${round(vbH)} (aspect ${round(vbH / vbW)}), ` +
    `layer translate ${round(tx)},${round(ty)}`
);
console.log('  -> BASE_TILE in packages/web/src/lib/pyramid.ts must match this aspect');
console.log(`rects ${rects.length}: ${spines.length} books, ${searchBoxRects.length} search_box, ${other.length} unlabelled`);
console.log(`search_box: ${searchBox ? nrect(searchBox).join(', ') : 'MISSING'}`);
console.log(`fav_mine_toggle: ${mineToggle ? nrect(mineToggle).join(', ') : 'none traced'}`);
console.log(`fav_count_toggle: ${countToggle ? nrect(countToggle).join(', ') : 'none traced'}`);
console.log(`shuffle_button: ${shuffleButton ? nrect(shuffleButton).join(', ') : 'none traced'}`);
console.log(`center_book: ${centerBook ? `bbox ${nrect(centerBook.bbox).join(', ')}, ${centerBook.d.split(' ').length} path commands` : 'none traced'}`);
console.log(`distill_off: ${distillOff ? `bbox ${nrect(distillOff.bbox).join(', ')}` : 'none traced'}`);
console.log(`distill_on: ${distillOn ? `bbox ${nrect(distillOn.bbox).join(', ')}` : 'none traced'}`);
console.log(`tile_fav_toggle: ${favoriteToggle ? `bbox ${nrect(favoriteToggle.bbox).join(', ')}` : 'none traced'}`);
console.log(`opening: ${nrect(openingRect).join(', ')}`);
console.log(`\n${shelves.length} shelves, ${spines.length} books total:`);
for (const [i, row] of shelves.entries())
  console.log(`  shelf ${i}: ${row.books.length} books   y ${round(row.y)}`);

const problems: string[] = [];
if (other.length) problems.push(`${other.length} rects had no recognised label (book<n> or search_box)`);
if (searchBoxRects.length > 1) problems.push(`${searchBoxRects.length} rects labelled search_box, expected one`);
if (!searchBox) problems.push('no rect labelled search_box');
if (mineToggleRects.length > 1) problems.push(`${mineToggleRects.length} rects labelled fav_mine_toggle, expected at most one`);
if (countToggleRects.length > 1) problems.push(`${countToggleRects.length} rects labelled fav_count_toggle, expected at most one`);
if (shuffleRects.length > 1) problems.push(`${shuffleRects.length} rects labelled shuffle_button, expected at most one`);
if (!spines.length) problems.push('no rects labelled book<n>');
if (centerBookPaths.length > 1) problems.push(`${centerBookPaths.length} paths labelled center_book, expected at most one`);
if (distillOffPaths.length > 1) problems.push(`${distillOffPaths.length} paths labelled distill_off, expected at most one`);
if (distillOnPaths.length > 1) problems.push(`${distillOnPaths.length} paths labelled distill_on, expected at most one`);
if (favoriteTogglePaths.length > 1) problems.push(`${favoriteTogglePaths.length} ellipses labelled tile_fav_toggle, expected at most one`);
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
 * BASE_TILE in packages/web/src/lib/pyramid.ts.
 *
 * Rects are [x, y, w, h].
 */

export type RectTuple = [number, number, number, number];

/**
 * The open book's exact outline. \`d\` is an SVG path in the canonical
 * absolute M/L/C/Z grammar \`normalizePath\` emits (see the importer), every
 * coordinate a tile-normalised (x/vbW, y/vbH) fraction - so it can be handed
 * straight to an SVG \`<path d>\` inside a \`viewBox="0 0 1 1"\`. \`bbox\` is the
 * same shape as every other measured rect, for a caller that only needs a
 * quick containment check.
 */
export interface CenterBook {
  d: string;
  bbox: RectTuple;
}

export interface MeasuredData {
  source: string;
  tile: { w: number; h: number; aspect: number };
  opening: RectTuple;
  searchBox: RectTuple | null;
  /** hit region for the "sort by my favorites" switch - null on a trace with none */
  mineToggle: RectTuple | null;
  /** hit region for the "sort by most favorited" switch - null on a trace with none */
  countToggle: RectTuple | null;
  /** hit region for the reorder control - null on a trace with none */
  shuffleButton: RectTuple | null;
  centerBook: CenterBook | null;
  /**
   * The "enable distillation" icon's outline, traced over the whole tile the
   * same way \`centerBook\` is - null on a trace with none, in which case the
   * distill toggle draws no hover highlight.
   */
  distillOff: CenterBook | null;
  /** The "disable distillation" icon's outline - see \`distillOff\`. */
  distillOn: CenterBook | null;
  /**
   * The on-tile favorite badge's non-transparent silhouette - an ellipse in
   * the trace, converted on import to the same M/L/C/Z grammar \`centerBook\`
   * uses. Traced over the WHOLE tile, not the badge's own icon, so it is in
   * the same per-axis fraction space as every other rect here; a consumer
   * scales it by a tile's \`cellPx\` exactly like \`centerBook\`. Null on a
   * trace with none, in which case a badge draws no hover highlight.
   */
  favoriteToggle: CenterBook | null;
  shelves: { books: RectTuple[] }[];
}

export const MEASURED: MeasuredData = {
  source: ${JSON.stringify(basename(src))},
  tile: { w: ${round(vbW)}, h: ${round(vbH)}, aspect: ${round(vbH / vbW)} },
  opening: [${nrect(openingRect).join(', ')}],
  searchBox: ${searchBox ? `[${nrect(searchBox).join(', ')}]` : 'null'},
  mineToggle: ${mineToggle ? `[${nrect(mineToggle).join(', ')}]` : 'null'},
  countToggle: ${countToggle ? `[${nrect(countToggle).join(', ')}]` : 'null'},
  shuffleButton: ${shuffleButton ? `[${nrect(shuffleButton).join(', ')}]` : 'null'},
  centerBook: ${centerBook ? `{ d: ${JSON.stringify(centerBook.d)}, bbox: [${nrect(centerBook.bbox).join(', ')}] }` : 'null'},
  distillOff: ${distillOff ? `{ d: ${JSON.stringify(distillOff.d)}, bbox: [${nrect(distillOff.bbox).join(', ')}] }` : 'null'},
  distillOn: ${distillOn ? `{ d: ${JSON.stringify(distillOn.d)}, bbox: [${nrect(distillOn.bbox).join(', ')}] }` : 'null'},
  favoriteToggle: ${favoriteToggle ? `{ d: ${JSON.stringify(favoriteToggle.d)}, bbox: [${nrect(favoriteToggle.bbox).join(', ')}] }` : 'null'},
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
