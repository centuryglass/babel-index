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
 * @param {object} opts
 * @param {number} [opts.size]
 * @param {number} [opts.seed] varies book spines only
 * @param {'schematic'|'lineart'|'depth'} [opts.style]
 */
export function renderTile({ size = 1024, seed = 1941, style = 'schematic' } = {}) {
  const L = layout({ width: size, height: size });
  const rnd = prng(seed);
  const defs = [];
  const body = [rect({ x: 0, y: 0, w: L.width, h: L.height }, { fill: background(style) })];

  body.push(rect(L.ceiling, paint(style, 'ceiling')));
  body.push(rect(L.floor, paint(style, 'floor')));
  body.push(rect(L.cornice, paint(style, 'stone')));

  // Case frame, then the recessed opening behind the shelves.
  body.push(rect(L.caseFrame, paint(style, 'pier')));
  body.push(rect(L.opening, paint(style, 'caseBack')));

  for (const shelf of L.shelves) {
    for (const slot of shelf.slots) {
      const h = slot.h * rnd.range(0.76, 0.97);
      const inset = slot.w * rnd.range(0.06, 0.18);
      const b = {
        x: round(slot.x + inset / 2),
        y: round(slot.y + slot.h - h),
        w: round(slot.w - inset),
        h: round(h),
      };
      const attrs = paint(style, 'book', {
        fill: SPINE_TONES[rnd.int(0, SPINE_TONES.length - 1)],
        strokeWidth: 0.5,
      });
      body.push(
        rnd.chance(0.02)
          ? rect(b, {
              ...attrs,
              transform: `rotate(${round(rnd.range(-9, 9))} ${round(b.x + b.w / 2)} ${round(b.y + b.h)})`,
            })
          : rect(b, attrs)
      );
    }
    body.push(rect(shelf.board, paint(style, 'board')));
  }

  // Side walls last: they overlap the case at the tile edges, as in the render.
  for (const r of L.sideReturns) body.push(trapezoid(r, paint(style, 'stoneDark')));

  if (style === 'schematic') {
    defs.push(
      el('radialGradient', { id: 'lampGlow' }, [
        el('stop', { offset: '0%', 'stop-color': '#ffe9b8', 'stop-opacity': 0.5 }),
        el('stop', { offset: '100%', 'stop-color': '#ffe9b8', 'stop-opacity': 0 }),
      ].join(''))
    );
    body.push(el('circle', { cx: L.lamp.cx, cy: L.lamp.cy, r: L.lamp.r * 6, fill: 'url(#lampGlow)' }));
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
 * @param {{size?: number, baseImageHref?: string}} opts
 */
export function renderOverlay({ size = 1024, baseImageHref = null } = {}) {
  const L = layout({ width: size, height: size });
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
    // Every 4th slot, so 32 per shelf stays legible at a glance.
    for (const slot of shelf.slots)
      children.push(rect(slot, { fill: 'none', stroke: '#ffffff', 'stroke-width': slot.index % 4 === 0 ? 0.8 : 0.3, 'stroke-opacity': 0.55 }));
  }

  const legend = [
    ['#ff6b6b', 'side return (frame - never inpainted)'],
    ['#06d6a0', 'case frame / shelf boards'],
    ['#118ab2', 'opening'],
    ['#ffffff', `${STORY.booksPerShelf} book slots per shelf`],
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
export function geometryManifest({ size = 1024, seed = 1941 } = {}) {
  const L = layout({ width: size, height: size });
  const n = (v) => Math.round((v / size) * 100000) / 100000;
  const nr = (r) => [n(r.x), n(r.y), n(r.w), n(r.h)];

  return {
    $schema: 'babel-index/tile-geometry@2',
    generatedBy: 'tools/base-image/generate.mjs',
    seed,
    projection: 'single-shelved-wall, shallow one-point perspective',
    provisional: 'Proportions measured by eye off the Blender base render. Re-derive from the .blend before binding UI to them.',
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
      sideReturn: n(L.sideReturn),
      ceiling: nr(L.ceiling),
      cornice: nr(L.cornice),
      floor: nr(L.floor),
      caseFrame: nr(L.caseFrame),
      opening: nr(L.opening),
      lamp: [n(L.lamp.cx), n(L.lamp.cy), n(L.lamp.r)],
      floorLine: n(L.floorLine),
    },
    shelves: L.shelves.map((s) => ({
      index: s.index,
      rect: nr(s),
      board: nr(s.board),
      slots: s.slots.map(nr),
    })),
    /** Anchors for the interactive centre room (concept.md steps 5-6). */
    uiAnchors: {
      searchField: nr({ x: L.opening.x, y: L.shelves[2].y, w: L.opening.w, h: L.shelves[2].clearH }),
      submitButton: [n(L.lamp.cx), n(L.lamp.cy), n(L.lamp.r)],
      historySpines: { shelf: 1, slots: 'all' },
      scoreSortSpines: { shelf: 3, slots: 'all' },
      shuffleSpine: { shelf: 4, slot: 31 },
    },
  };
}
