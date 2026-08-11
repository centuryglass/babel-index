import { STORY } from './story.js';
import { layout } from './geometry.js';
import { prng } from './prng.js';
import { el, rect, svg } from './svg.js';
import { paint, background, SPINE_TONES } from './materials.js';

/**
 * Render one gallery tile.
 *
 * @param {object} opts
 * @param {number} [opts.size]   square edge in px
 * @param {number} [opts.seed]   PRNG seed; affects book variation only, never
 *                               the seam bands (which use a fixed seed so all
 *                               rooms share them)
 * @param {'schematic'|'lineart'|'depth'} [opts.style]
 * @returns {{svg: string, layout: object}}
 */
export function renderRoom({ size = 1024, seed = 1941, style = 'schematic' } = {}) {
  const L = layout({ width: size, height: size });
  const rnd = prng(seed);
  const defs = [];
  const body = [];

  // --- interior ------------------------------------------------------------
  body.push(rect({ x: 0, y: 0, w: L.width, h: L.height }, { fill: background(style) }));
  body.push(
    rect(
      { x: 0, y: L.seamY, w: L.width, h: L.caseTop - L.seamY },
      paint(style, 'ceiling')
    )
  );
  body.push(
    rect(
      { x: 0, y: L.floorLine, w: L.width, h: L.height - L.seamY - L.floorLine },
      paint(style, 'floor')
    )
  );

  for (const bay of L.bays) body.push(drawBay(bay, style, rnd));

  // The air shaft cuts the full height of the tile.
  body.push(rect(L.shaft, paint(style, 'void')));
  body.push(drawRail(L, style));

  if (style === 'schematic') {
    defs.push(
      el(
        'radialGradient',
        { id: 'lampGlow' },
        [
          el('stop', { offset: '0%', 'stop-color': '#ffe9b8', 'stop-opacity': 0.55 }),
          el('stop', { offset: '100%', 'stop-color': '#ffe9b8', 'stop-opacity': 0 }),
        ].join('')
      )
    );
  }
  for (const lamp of L.lamps) {
    if (style === 'schematic') {
      body.push(el('circle', { cx: lamp.cx, cy: lamp.cy, r: lamp.r * 5, fill: 'url(#lampGlow)' }));
    }
    body.push(el('circle', { cx: lamp.cx, cy: lamp.cy, r: lamp.r, ...paint(style, 'lampGlobe') }));
  }

  // --- straddle bands ------------------------------------------------------
  // Authored once, drawn twice with halves swapped. See geometry.js.
  const slab = drawSlab(L, style);
  const corridor = drawCorridor(L, style);

  defs.push(el('g', { id: 'slabBand' }, slab));
  defs.push(el('g', { id: 'corridorBand' }, corridor));
  defs.push(
    el('clipPath', { id: 'clipSlabTop' }, rect(L.placements.slabTop.dst)),
    el('clipPath', { id: 'clipSlabBottom' }, rect(L.placements.slabBottom.dst)),
    el('clipPath', { id: 'clipCorridorLeft' }, rect(L.placements.corridorLeft.dst)),
    el('clipPath', { id: 'clipCorridorRight' }, rect(L.placements.corridorRight.dst))
  );

  // Slab: local y in [seamY, 2*seamY] -> tile top; local y in [0, seamY] -> tile bottom.
  body.push(
    el('g', { 'clip-path': 'url(#clipSlabTop)' }, el('use', { href: '#slabBand', y: -L.seamY })),
    el(
      'g',
      { 'clip-path': 'url(#clipSlabBottom)' },
      el('use', { href: '#slabBand', y: L.height - L.seamY })
    )
  );
  // Corridor: local x in [seamX, 2*seamX] -> tile left; local x in [0, seamX] -> tile right.
  body.push(
    el(
      'g',
      { 'clip-path': 'url(#clipCorridorLeft)' },
      el('use', { href: '#corridorBand', x: -L.seamX })
    ),
    el(
      'g',
      { 'clip-path': 'url(#clipCorridorRight)' },
      el('use', { href: '#corridorBand', x: L.width - L.seamX })
    )
  );

  // --- corners -------------------------------------------------------------
  // Where the two bands would overlap, a flat fill: the stair well penetrating
  // the floor slab. Constant colour is what makes the corner case tile.
  for (const c of L.corners) body.push(rect(c, paint(style, 'corner')));

  return { svg: svg({ width: L.width, height: L.height, defs: defs.join(''), children: body }), layout: L };
}

function drawBay(bay, style, rnd) {
  const parts = [rect({ x: bay.x, y: bay.y, w: bay.w, h: bay.h }, paint(style, 'caseBack'))];

  for (const shelf of bay.shelves) {
    for (const slot of shelf.slots) {
      // Books fill every slot: the story is explicit that the shelves are full.
      const lean = rnd.chance(0.02);
      const h = slot.h * rnd.range(0.74, 0.97);
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
      parts.push(
        lean
          ? rect(b, {
              ...attrs,
              transform: `rotate(${round(rnd.range(-9, 9))} ${round(b.x + b.w / 2)} ${round(
                b.y + b.h
              )})`,
            })
          : rect(b, attrs)
      );
    }
    parts.push(rect(shelf.board, paint(style, 'board')));
  }

  parts.push(
    rect({ x: bay.x, y: bay.y, w: bay.pierW, h: bay.h }, paint(style, 'pier')),
    rect(
      { x: round(bay.x + bay.w - bay.pierW), y: bay.y, w: bay.pierW, h: bay.h },
      paint(style, 'pier')
    )
  );
  return el('g', { 'data-bay': bay.index }, parts);
}

function drawRail({ shaft }, style) {
  const r = shaft.rail;
  const postW = round(r.w * 0.035);
  const parts = [rect({ x: r.x, y: r.y, w: r.w, h: round(r.h * 0.16) }, paint(style, 'rail'))];
  for (let i = 0; i < 5; i++) {
    parts.push(
      rect(
        {
          x: round(r.x + (r.w - postW) * (i / 4)),
          y: r.y,
          w: postW,
          h: r.h,
        },
        paint(style, 'rail')
      )
    );
  }
  return el('g', { 'data-part': 'shaft-rail' }, parts);
}

/**
 * The floor/ceiling slab, in its own local space of width W and height 2*seamY.
 * Drawn only across `liveX`; outside that the corner fill takes over.
 */
function drawSlab(L, style) {
  const s = L.slab;
  const parts = [
    rect({ x: s.liveX.x, y: 0, w: s.liveX.w, h: s.height }, paint(style, 'stoneDark')),
    // A seam line where the two halves meet reads as the joint between the
    // floor above and the ceiling below.
    rect({ x: s.liveX.x, y: round(L.seamY - 1), w: s.liveX.w, h: 2 }, paint(style, 'stoneLit')),
    rect(s.shaftOpening, paint(style, 'void')),
  ];
  return el('g', { 'data-band': 'slab' }, parts);
}

/**
 * The hallway, in its own local space of width 2*seamX and height H. Drawn only
 * across `liveY`; above and below, the corner fill takes over.
 */
function drawCorridor(L, style) {
  const c = L.corridor;
  const parts = [
    rect({ x: 0, y: c.liveY.y, w: c.width, h: c.liveY.h }, paint(style, 'stone')),
    rect({ x: 0, y: c.floorLine, w: c.width, h: round(c.liveY.y + c.liveY.h - c.floorLine) },
      paint(style, 'floor')),
    rect({ x: 0, y: c.liveY.y, w: c.width, h: round(c.caseTop - c.liveY.y) },
      paint(style, 'ceiling')),
    rect(c.aperture, paint(style, 'void')),
    rect(c.farGallery, paint(style, 'farGlow')),
  ];

  for (const closet of c.closets) parts.push(rect(closet, paint(style, 'closet')));
  parts.push(rect(c.mirror, paint(style, 'mirror')));
  parts.push(drawSpiralStair(c, style));

  return el('g', { 'data-band': 'corridor' }, parts);
}

/**
 * "a spiral stairway, which sinks abysmally and soars upwards to remote
 * distances" - approximated as treads whose apparent width follows the helix.
 */
function drawSpiralStair(c, style) {
  const s = c.stair;
  const step = s.h / s.treads;
  const parts = [
    rect({ x: round(s.cx - s.w * 0.06), y: s.y, w: round(s.w * 0.12), h: s.h },
      paint(style, 'stairPost')),
  ];
  for (let i = 0; i < s.treads; i++) {
    const phase = (i / 4) * Math.PI;
    const w = (s.w / 2) * (0.3 + 0.7 * Math.abs(Math.cos(phase)));
    const dir = Math.sign(Math.cos(phase)) || 1;
    parts.push(
      rect(
        {
          x: round(dir > 0 ? s.cx : s.cx - w),
          y: round(s.y + i * step),
          w: round(w),
          h: round(step * 0.42),
        },
        paint(style, 'stair', { strokeWidth: 0.8 })
      )
    );
  }
  return el('g', { 'data-part': 'spiral-stair' }, parts);
}

/**
 * Render one straddle band on its own, in its local coordinate space. This is
 * the reference the seam verifier compares the tile's edges against: if the
 * tile's right band plus the tile's left band reassemble into exactly this
 * image, the tiling is seamless for any content the band happens to contain.
 *
 * @param {'corridor'|'slab'} band
 */
export function renderBand({ band, size = 1024, style = 'schematic' } = {}) {
  const L = layout({ width: size, height: size });
  const children =
    band === 'corridor'
      ? [
          rect({ x: 0, y: 0, w: L.corridor.width, h: L.corridor.height }, { fill: background(style) }),
          drawCorridor(L, style),
        ]
      : [
          rect({ x: 0, y: 0, w: L.slab.width, h: L.slab.height }, { fill: background(style) }),
          drawSlab(L, style),
        ];
  const geo = band === 'corridor' ? L.corridor : L.slab;
  return {
    svg: svg({ width: geo.width, height: geo.height, children }),
    layout: L,
    band: geo,
  };
}

/**
 * The seam mask: white where a variant room must reproduce the base room
 * exactly, black where it is free. Feed this to inpainting as the "keep" mask.
 */
export function renderSeamMask({ size = 1024 } = {}) {
  const L = layout({ width: size, height: size });
  const children = [
    rect({ x: 0, y: 0, w: L.width, h: L.height }, { fill: '#000000' }),
    ...L.seamRegions.map((r) => rect(r, { fill: '#ffffff' })),
  ];
  return { svg: svg({ width: L.width, height: L.height, children }), layout: L };
}

/** Machine-readable geometry for the web app and the generation pipeline. */
export function geometryManifest({ size = 1024, seed = 1941 } = {}) {
  const L = layout({ width: size, height: size });
  const n = (v) => Math.round((v / size) * 100000) / 100000;
  const nr = (r) => [n(r.x), n(r.y), n(r.w), n(r.h)];

  return {
    $schema: 'babel-index/room-geometry@1',
    generatedBy: 'tools/base-image/generate.mjs',
    seed,
    projection: 'unrolled-hexagon-elevation',
    pixel: { width: L.width, height: L.height },
    story: STORY,
    seam: {
      note: 'Normalised. Variant rooms must reproduce these regions exactly.',
      thickness: { x: n(L.seamX), y: n(L.seamY) },
      regions: Object.fromEntries(L.seamRegions.map((r) => [r.name, nr(r)])),
      corners: L.corners.map(nr),
      straddle: Object.fromEntries(
        Object.entries(L.placements).map(([k, v]) => [k, { src: nr(v.src), dst: nr(v.dst) }])
      ),
    },
    features: {
      shaft: nr(L.shaft),
      shaftRail: nr(L.shaft.rail),
      lamps: L.lamps.map((l) => [n(l.cx), n(l.cy), n(l.r)]),
      floorLine: n(L.floorLine),
      caseTop: n(L.caseTop),
      hallway: {
        localWidth: n(L.corridor.width),
        aperture: nr(L.corridor.aperture),
        closets: L.corridor.closets.map(nr),
        mirror: nr(L.corridor.mirror),
        stair: nr({ x: L.corridor.stair.x, y: L.corridor.stair.y, w: L.corridor.stair.w, h: L.corridor.stair.h }),
      },
    },
    /**
     * Every book slot, addressable as bay/shelf/index. The centre room binds
     * interactive controls to these: search-term spines, sort toggles, etc.
     */
    bays: L.bays.map((bay) => ({
      index: bay.index,
      rect: nr(bay),
      shelves: bay.shelves.map((shelf) => ({
        index: shelf.index,
        rect: nr(shelf),
        slots: shelf.slots.map(nr),
      })),
    })),
    /** Anchors reserved for the interactive centre room (concept.md steps 5-6). */
    uiAnchors: {
      searchField: nr({
        x: L.shaft.x,
        y: L.floorLine - L.height * 0.16,
        w: L.shaft.w,
        h: L.height * 0.05,
      }),
      submitButton: nr({
        x: L.shaft.x + L.shaft.w * 0.62,
        y: L.floorLine - L.height * 0.1,
        w: L.shaft.w * 0.38,
        h: L.height * 0.04,
      }),
      generateButton: nr({
        x: L.shaft.x,
        y: L.floorLine - L.height * 0.1,
        w: L.shaft.w * 0.38,
        h: L.height * 0.04,
      }),
      shuffleLamp: [n(L.lamps[1].cx), n(L.lamps[1].cy), n(L.lamps[1].r)],
      historySpines: { bay: 1, shelf: 2, slots: 'all' },
      scoreSortSpines: { bay: 2, shelf: 4, slots: 'all' },
    },
  };
}

const round = (v) => Math.round(v * 1000) / 1000;
