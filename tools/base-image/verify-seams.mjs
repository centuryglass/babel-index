#!/usr/bin/env node
/**
 * Prove that the generated tile is seamless, rather than eyeballing it.
 *
 * Three assertions, all on rasterized pixels:
 *
 *   1. Reassembly (horizontal). The tile's right seam strip followed by the
 *      tile's left seam strip must equal the hallway band exactly as authored.
 *      Where two tiles meet, that is literally the image produced, so equality
 *      means the join reconstructs a single continuous corridor.
 *   2. Reassembly (vertical). Same for the tile's bottom strip followed by its
 *      top strip against the floor/ceiling slab band.
 *   3. Corners. The four corner blocks must each be one constant colour, which
 *      is what lets the two bands overlap without contradicting each other.
 *
 * Exit code 0 on success, 1 on any failure.
 */
import { Resvg } from '@resvg/resvg-js';
import { renderRoom, renderBand } from './lib/render.js';

const size = Number(process.argv.find((a) => a.startsWith('--size='))?.slice(7) ?? 1024);

const raster = (markup) => {
  const img = new Resvg(markup).render();
  return { w: img.width, h: img.height, px: img.pixels };
};

const at = (img, x, y) => {
  const i = (y * img.w + x) * 4;
  return [img.px[i], img.px[i + 1], img.px[i + 2], img.px[i + 3]];
};

const room = renderRoom({ size, style: 'schematic' });
const L = room.layout;
const tile = raster(room.svg);
const hallway = raster(renderBand({ band: 'corridor', size }).svg);
const slab = raster(renderBand({ band: 'slab', size }).svg);

const failures = [];

// --- 1. horizontal reassembly ----------------------------------------------
// Band local x in [0, seamX) is drawn at tile x in [W-seamX, W);
// band local x in [seamX, 2*seamX) is drawn at tile x in [0, seamX).
compare('hallway band reassembles across a vertical join', {
  live: { y0: L.seamY, y1: L.height - L.seamY },
  map: (bx, by) => (bx < L.seamX ? [L.width - L.seamX + bx, by] : [bx - L.seamX, by]),
  band: hallway,
  bandW: L.corridor.width,
});

// --- 2. vertical reassembly -------------------------------------------------
// Band local y in [0, seamY) is drawn at tile y in [H-seamY, H);
// band local y in [seamY, 2*seamY) is drawn at tile y in [0, seamY).
compare('slab band reassembles across a horizontal join', {
  live: { x0: L.seamX, x1: L.width - L.seamX },
  map: (bx, by) => (by < L.seamY ? [bx, L.height - L.seamY + by] : [bx, by - L.seamY]),
  band: slab,
  bandW: L.slab.width,
  vertical: true,
});

// --- 3. corners -------------------------------------------------------------
for (const c of L.corners) {
  const ref = at(tile, c.x, c.y);
  let bad = 0;
  for (let y = c.y; y < c.y + c.h; y++) {
    for (let x = c.x; x < c.x + c.w; x++) {
      const p = at(tile, x, y);
      if (p.some((v, i) => v !== ref[i])) bad++;
    }
  }
  if (bad) failures.push(`corner at ${c.x},${c.y}: ${bad} pixels differ from the constant fill`);
}

// ---------------------------------------------------------------------------

function compare(label, { live, map, band, bandW, vertical }) {
  let bad = 0;
  let firstBad = null;
  const xs = vertical ? [live.x0, live.x1] : [0, bandW];
  const ys = vertical ? [0, band.h] : [live.y0, live.y1];
  for (let by = ys[0]; by < ys[1]; by++) {
    for (let bx = xs[0]; bx < xs[1]; bx++) {
      const [tx, ty] = map(bx, by);
      const a = at(band, bx, by);
      const b = at(tile, tx, ty);
      if (a.some((v, i) => v !== b[i])) {
        bad++;
        firstBad ??= `band(${bx},${by})=${a} vs tile(${tx},${ty})=${b}`;
      }
    }
  }
  const total = (xs[1] - xs[0]) * (ys[1] - ys[0]);
  if (bad) failures.push(`${label}: ${bad}/${total} pixels differ; first at ${firstBad}`);
  else console.log(`  ok  ${label} (${total} px)`);
}

console.log(`seam verification for ${size}x${size}`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log('  ok  corners are constant fill');
console.log('all seam invariants hold');
