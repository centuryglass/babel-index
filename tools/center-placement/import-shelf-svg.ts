#!/usr/bin/env node
/**
 * Turns the hand-traced Inkscape SVG of the center tile into the measured
 * geometry every consumer reads, `tools/center-placement/lib/measured.ts`.
 *
 *   npm run generate:shelf-geometry [-- --out <file>]   # reads tools/center-placement/shelf_geometry.svg
 *
 * The label on an element is the contract; its fill colour is decorative. An
 * element the trace does not carry is emitted as null, and the consumer leaves
 * that control out.
 *
 *   rect    "search_box"       where the live search field sits
 *   rect    "book0".."bookN"   book spines, grouped into shelves by y
 *   rect    "fav_mine_toggle"  hit region for the "my favorites" sort switch
 *   rect    "fav_count_toggle" hit region for the "most favorited" sort switch
 *   rect    "shuffle_button"   hit region for the reorder control
 *   path    "center_book"      the open book painted into a shelf gap
 *   path    "distill_off"      the "enable distillation" icon's outline
 *   path    "distill_on"       the "disable distillation" icon's outline
 *   ellipse "tile_fav_toggle"  the on-tile favorite badge's silhouette
 *
 * No shelf board, case upright or lamp is traced: shelf rows fall out of the
 * books' shared y, and a row's books need not be contiguous across x - the run
 * splitting a gap wider than a book implies is `center.ts`'s `RUNS`.
 *
 * `center_book`, `distill_off` and `distill_on` are `<path>`s, `tile_fav_toggle`
 * an `<ellipse>`, and all four are traced over the whole tile rather than over
 * the shape's own bounds: one coordinate space covers every value emitted. Each
 * becomes one canonical M/L/C/Z grammar plus a bbox for a caller that only
 * needs containment - see `normalizePath`, `ellipseToPath` and `measured.ts`'s
 * `CenterBook`.
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

/** Argument count per path command letter, uppercased. */
const PATH_ARG_COUNT: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, Z: 0, A: 7,
};

/**
 * Re-serialises a `<path>`'s `d` into one canonical grammar: absolute M/L/C/Z
 * only, every number a tile-normalised (x/vbW, y/vbH) coordinate. Returns that
 * string and its bounding box.
 *
 * Collapsing H/V/M-repeat/relative into that grammar is what lets a consumer
 * hand the string straight to an SVG `<path d>`, and what lets
 * `geometry.ts`'s `scalePathData` rescale it with a regex over `x,y` pairs
 * instead of a second copy of this walk. That regex is only sound because of
 * the collapse: one leftover single-number command mispairs every coordinate
 * after it.
 *
 * The bbox covers on-curve and control points alike; a cubic stays inside its
 * control-point hull, so that is never smaller than the true bound.
 *
 * S/Q/T are tokenized but not in `PATH_ARG_COUNT`, so the command-letter
 * check below throws rather than silently misreading a smooth-curve trace -
 * what Inkscape leaves when it simplifies a Bezier.
 *
 * `A` is handled, and approximated as a lineto to its own endpoint: the curve
 * is dropped. `distill_off`'s five arcs are its rounded corners, each one a
 * fillet under 3 units of the traced viewBox, a couple of pixels at tile
 * scale. Sampling rather than solving is the tradeoff `svgPath.ts`'s
 * `flattenPath` already makes for the same hit-test.
 *
 * S/Q/T are in the token grammar so the command-letter check below rejects
 * them explicitly - they are not supported, but a smooth-curve trace (what
 * Inkscape leaves behind when it simplifies a Bezier) must fail loudly rather
 * than have its letter dropped and its numbers misread as further repeats of
 * the command before it.
 */
function normalizePath(d: string, tx: number, ty: number, vbW: number, vbH: number) {
  const tokens = d.match(/[MmLlHhVvCcZzAaSsQqTt]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
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
  // True on the first pair after a command letter, false on a repeated pair
  // with no letter of its own. Only `M` cares: SVG defines a repeated pair
  // after an 'M'/'m' as an implicit lineto, and reading it as a second moveto
  // leaves every repeat a stray, disconnected subpath.
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
      // rx, ry, x-axis-rotation and the two flags (nums[0..4]) are dropped;
      // `normalizePath`'s doc covers the approximation.
      cx = relative ? cx + nums[5] : nums[5];
      cy = relative ? cy + nums[6] : nums[6];
      visit(cx, cy);
      out.push(`L${nx(cx)},${ny(cy)}`);
    } else if (letter === 'C') {
      // A cubic's three pairs (two control points, one endpoint) are all
      // relative to the point before the curve, never chained pair to pair -
      // chaining sends a control point off toward wherever the previous
      // control point landed. Only the third pair becomes the new current
      // point.
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
      // M and L's args are (x, y) pairs, and a repeat (no new letter) chains
      // off the point the previous pair landed on - hence px/py, where the
      // 'C' branch chains every pair off one origin.
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
 * Turns a traced `<ellipse>` (plus its own `transform`, if any) into the same
 * canonical absolute M/L/C/Z grammar `normalizePath` emits. `tile_fav_toggle`
 * therefore reaches `favoriteBadge.ts` the same way `center_book` does, and no
 * consumer has to know one of them started as an ellipse.
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
  // `d` is normalised here and the bbox is not: `nrect` divides the bbox at the
  // output site, as it does `normalizePath`'s. Returning a normalised bbox
  // would have it divided twice.
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

/**
 * Reads an attribute off a tag string, falling back to a `style="..."`
 * declaration of the same name.
 *
 * The direct lookup is anchored with `(?:^|\s)`, since `-` is a word boundary
 * and an unanchored `\bname=` would let a presentation attribute like
 * `stroke-width="..."` earlier in the tag match a lookup for `width`.
 */
function attr(tag: string, name: string): string | null {
  const direct = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(tag);
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

// Rows group by matching y. This tolerance absorbs trace noise; the gap between
// two real shelves is far wider than it, and an epsilon covering that gap is
// what would merge them.
const ROW_EPSILON = vbH * 0.01;
const shelves: ShelfRow[] = [];
for (const s of spines) {
  const row = shelves.find((r) => Math.abs(r.y - s.y) <= ROW_EPSILON);
  if (row) row.books.push(s);
  else shelves.push({ y: s.y, books: [s] });
}
shelves.sort((a, b) => a.y - b.y);
for (const row of shelves) row.books.sort((a, b) => a.x - b.x);

// Each axis is divided by its own traced edge, so the output carries no aspect
// of its own; `tile` in the emitted file records what that edge was.
const nx = (v: number) => round(v / vbW);
const ny = (v: number) => round(v / vbH);
const nrect = (r: { x: number; y: number; w: number; h: number }) => [nx(r.x), ny(r.y), nx(r.w), ny(r.h)];

// No case upright is traced, so the opening is the bounding box of every book
// on the wall: that box is the case frame.
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

// A bad trace is listed and sets a nonzero exit code; the file below is written
// either way, so `--out` still shows what the trace parsed into.
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
 * records the shape they were traced at: the one fact the normalisation
 * throws away, and the one that has to keep agreeing with BASE_TILE in
 * packages/web/src/lib/pyramid.ts. \`geometry.test.ts\` asserts that it does.
 */

/** A measured rect as [x, y, w, h]. */
export type RectTuple = [number, number, number, number];

/**
 * A traced silhouette in the canonical absolute M/L/C/Z grammar
 * \`normalizePath\` emits, tile-normalised like every other value here and
 * spanning the whole tile rather than the shape's own bounds. So \`d\` can be
 * handed straight to an SVG \`<path d>\` inside a \`viewBox="0 0 1 1"\`, or scaled
 * per axis by a tile's \`cellPx\`. \`bbox\` is the same tuple as every other
 * measured rect, for a caller that only needs containment.
 */
export interface CenterBook {
  d: string;
  bbox: RectTuple;
}

export interface MeasuredData {
  source: string;
  /** The traced viewBox, and the aspect taken from it. */
  tile: { w: number; h: number; aspect: number };
  /** The bounding box of every traced book, which is the case frame. */
  opening: RectTuple;
  /**
   * One per traced element, named for its label in \`shelf_geometry.svg\` -
   * what each is for is \`import-shelf-svg.ts\`'s label table. Null means the
   * trace carried no such element.
   */
  searchBox: RectTuple | null;
  mineToggle: RectTuple | null;
  countToggle: RectTuple | null;
  shuffleButton: RectTuple | null;
  centerBook: CenterBook | null;
  distillOff: CenterBook | null;
  distillOn: CenterBook | null;
  /**
   * \`tile_fav_toggle\` is an \`<ellipse>\` in the trace, converted to
   * \`centerBook\`'s grammar by \`ellipseToPath\`.
   */
  favoriteToggle: CenterBook | null;
  /** Shelves top to bottom, each one's books left to right. */
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
