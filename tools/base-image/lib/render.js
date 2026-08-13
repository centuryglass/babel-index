import { STORY } from './story.js';
import { layout } from './geometry.js';
import { prng } from './prng.js';
import { el, rect, svg } from './svg.js';
import { paint, background, SPINE_TONES } from './materials.js';

const round = (v) => Math.round(v * 1000) / 1000;

const trapezoid = (r, attrs) =>
  el('polygon', {
    points: [
      `${r.outer.x},${r.outer.top}`,
      `${r.inner.x},${r.inner.top}`,
      `${r.inner.x},${r.inner.bottom}`,
      `${r.outer.x},${r.outer.bottom}`,
    ].join(' '),
    ...attrs,
  });

/**
 * Render one tile: a single shelved wall in shallow perspective.
 *
 * Width and height are separate because the tile is not square. Omit the height
 * and `layout()` supplies the traced aspect - never a square.
 *
 * @param {object} opts
 * @param {number} [opts.width]
 * @param {number} [opts.height] defaults to the traced aspect
 * @param {number} [opts.seed] varies book spines only
 * @param {'schematic'|'lineart'|'depth'} [opts.style]
 */
export function renderTile({ width = 1024, height, seed = 1941, style = 'schematic' } = {}) {
  const L = layout({ width, height });
  const rnd = prng(seed);
  const defs = [];
  const body = [rect({ x: 0, y: 0, w: L.width, h: L.height }, { fill: background(style) })];

  body.push(rect(L.ceiling, paint(style, 'ceiling')));
  body.push(rect(L.floor, paint(style, 'floor')));
  body.push(rect(L.cornice, paint(style, 'stone')));

  // Case frame, then the recessed opening behind the shelves.
  body.push(rect(L.caseFrame, paint(style, 'pier')));
  body.push(rect(L.opening, paint(style, 'caseBack')));

  // Book rectangles are measured, not generated: these are the actual spine
  // positions from the Blender render. Only the spine colour is randomised.
  for (const shelf of L.shelves) {
    for (const book of shelf.books)
      body.push(
        rect(book, paint(style, 'book', {
          fill: SPINE_TONES[rnd.int(0, SPINE_TONES.length - 1)],
          strokeWidth: 0.5,
        }))
      );
    body.push(rect(shelf.board, paint(style, 'board')));
  }
  for (const upright of L.uprights) body.push(rect(upright, paint(style, 'pier')));

  // Side walls last: they overlap the case at the tile edges, as in the render.
  for (const r of L.sideReturns) body.push(trapezoid(r, paint(style, 'stoneDark')));

  if (style === 'schematic') {
    defs.push(
      el('radialGradient', { id: 'lampGlow' }, [
        el('stop', { offset: '0%', 'stop-color': '#ffe9b8', 'stop-opacity': 0.5 }),
        el('stop', { offset: '100%', 'stop-color': '#ffe9b8', 'stop-opacity': 0 }),
      ].join(''))
    );
    body.push(el('circle', { cx: L.lamp.cx, cy: L.lamp.cy, r: L.lamp.glow, fill: 'url(#lampGlow)' }));
  }
  body.push(el('circle', { cx: L.lamp.cx, cy: L.lamp.cy, r: L.lamp.r, ...paint(style, 'lampGlobe') }));

  return { svg: svg({ width: L.width, height: L.height, defs: defs.join(''), children: body }), layout: L };
}

/**
 * The geometry drawn as translucent outlines, for compositing over the real
 * base render to check that the slot rectangles land on the actual books.
 *
 * The proportions in geometry.js were measured by eye off the Blender render;
 * this is how they get corrected. Pass `--base <file>` to generate.mjs to bake
 * the render in behind the overlay.
 *
 * @param {{width?: number, height?: number, baseImageHref?: string}} opts
 */
export function renderOverlay({ width = 1024, height, baseImageHref = null } = {}) {
  const L = layout({ width, height });
  const children = [];

  if (baseImageHref)
    children.push(el('image', { href: baseImageHref, x: 0, y: 0, width: L.width, height: L.height }));
  else children.push(rect({ x: 0, y: 0, w: L.width, h: L.height }, { fill: '#1a1714' }));

  const line = (c, w = 1.5, dash = null) => ({
    fill: 'none',
    stroke: c,
    'stroke-width': w,
    ...(dash ? { 'stroke-dasharray': dash } : {}),
  });

  for (const r of L.sideReturns) children.push(trapezoid(r, line('#ff6b6b', 2)));
  children.push(rect(L.cornice, line('#ffd166')));
  children.push(rect(L.caseFrame, line('#06d6a0', 2)));
  children.push(rect(L.opening, line('#118ab2', 2)));
  children.push(el('circle', { cx: L.lamp.cx, cy: L.lamp.cy, r: L.lamp.r, ...line('#ffd166', 2) }));
  children.push(
    el('line', { x1: 0, y1: L.floorLine, x2: L.width, y2: L.floorLine, ...line('#ef476f', 1.5, '6 4') })
  );

  for (const shelf of L.shelves) {
    children.push(rect(shelf.board, line('#06d6a0', 1)));
    for (const book of shelf.books)
      children.push(rect(book, { fill: 'none', stroke: '#ffffff', 'stroke-width': 0.6, 'stroke-opacity': 0.7 }));
  }
  for (const upright of L.uprights) children.push(rect(upright, line('#06d6a0', 1)));

  const legend = [
    ['#ff6b6b', 'side return (frame - never inpainted)'],
    ['#06d6a0', 'case frame / shelf boards'],
    ['#118ab2', 'opening'],
    ['#ffffff', `${STORY.booksPerShelf} measured book spines per shelf`],
  ];
  legend.forEach(([c, label], i) => {
    const y = L.height - 84 + i * 20;
    children.push(rect({ x: 16, y: y - 9, w: 22, h: 11 }, { fill: c, 'fill-opacity': 0.85 }));
    children.push(
      el('text', {
        x: 46, y, 'font-family': 'ui-monospace, monospace', 'font-size': 12,
        fill: '#ffffff', 'paint-order': 'stroke', stroke: '#000000', 'stroke-width': 3,
      }, label)
    );
  });

  return { svg: svg({ width: L.width, height: L.height, children }), layout: L };
}

/**
 * Machine-readable geometry for the web app.
 *
 * Only the CENTRE room needs this to be exact. Variant rooms have their own
 * shelf counts and book positions - inpainting does not preserve them - so
 * per-slot hit-testing is only meaningful on a room whose art we control.
 */
export function geometryManifest({ width = 1024, height, seed = 1941 } = {}) {
  const L = layout({ width, height });

  // Normalised per axis: x and widths against the tile's width, y and heights
  // against its height. That is exactly how measured.js stores them, so the
  // manifest round-trips the trace at any shape. One divisor for both axes was
  // the old bug, and it hid because the layout was forced square - give it a
  // real 4:3 tile and every y and height comes out at 0.75x its true fraction.
  const round5 = (v) => Math.round(v * 100000) / 100000;
  const nx = (v) => round5(v / L.width);
  const ny = (v) => round5(v / L.height);
  const nr = (r) => [nx(r.x), ny(r.y), nx(r.w), ny(r.h)];

  return {
    $schema: 'babel-index/tile-geometry@2',
    generatedBy: 'tools/base-image/generate.mjs',
    seed,
    projection: 'single-shelved-wall, shallow one-point perspective',
    measured: 'Opening, uprights, shelf boards, all 160 book rects and the lamp are traced from the Blender render (see tools/base-image/lib/measured.js). Side returns, ceiling and cornice are still eyeballed and affect appearance only.',
    tile: {
      unit: 'one shelved wall of a gallery',
      shelves: STORY.shelvesPerSide,
      booksPerShelf: STORY.booksPerShelf,
      booksPerTile: STORY.shelvesPerSide * STORY.booksPerShelf,
      tilesPerGallery: STORY.shelvedSides,
    },
    pixel: { width: L.width, height: L.height },
    story: STORY,
    features: {
      sideReturn: nx(L.sideReturn),
      ceiling: nr(L.ceiling),
      cornice: nr(L.cornice),
      floor: nr(L.floor),
      caseFrame: nr(L.caseFrame),
      opening: nr(L.opening),
      // The radius is against WIDTH on both axes, because the lamp is a circle
      // and stays one - the same rule geometry.js applies when scaling it up.
      lamp: [nx(L.lamp.cx), ny(L.lamp.cy), nx(L.lamp.r)],
      uprights: L.uprights.map(nr),
      floorLine: ny(L.floorLine),
    },
    shelves: L.shelves.map((s) => ({
      index: s.index,
      rect: nr(s.rect),
      board: nr(s.board),
      books: s.books.map(nr),
    })),
    /** Anchors for the interactive centre room (concept.md steps 5-6). */
    uiAnchors: {
      searchField: nr(L.shelves[2].rect),
      submitButton: [nx(L.lamp.cx), ny(L.lamp.cy), nx(L.lamp.r)],
      historySpines: { shelf: 1, books: 'all' },
      scoreSortSpines: { shelf: 3, books: 'all' },
      shuffleSpine: { shelf: 4, book: 31 },
    },
  };
}
