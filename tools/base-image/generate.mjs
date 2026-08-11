#!/usr/bin/env node
/**
 * Generate the placeholder base room and every asset derived from it.
 *
 *   node tools/base-image/generate.mjs [--size 1024] [--seed 1941] [--out assets/base-room]
 *
 * SVG output has no dependencies. PNG output additionally needs
 * @resvg/resvg-js; if it is missing the SVGs are still written and PNGs are
 * skipped with a warning.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { renderRoom, renderSeamMask, renderBand, geometryManifest } from './lib/render.js';
import { seedFrom } from './lib/prng.js';

const argv = parseArgs(process.argv.slice(2));
const size = Number(argv.size ?? 1024);
const seed = argv.seed === undefined ? 1941 : /^\d+$/.test(argv.seed) ? Number(argv.seed) : seedFrom(argv.seed);
const outDir = resolve(process.cwd(), argv.out ?? 'assets/base-room');

const rasterize = await loadRasterizer();

await mkdir(outDir, { recursive: true });

const targets = [
  ['base-room', renderRoom({ size, seed, style: 'schematic' }).svg],
  ['base-room-lineart', renderRoom({ size, seed, style: 'lineart' }).svg],
  ['base-room-depth', renderRoom({ size, seed, style: 'depth' }).svg],
  ['seam-mask', renderSeamMask({ size }).svg],
  ['band-hallway', renderBand({ band: 'corridor', size }).svg],
  ['band-slab', renderBand({ band: 'slab', size }).svg],
];

const written = [];
for (const [name, markup] of targets) {
  await writeFile(join(outDir, `${name}.svg`), markup);
  written.push(`${name}.svg`);
  if (rasterize) {
    await writeFile(join(outDir, `${name}.png`), rasterize(markup));
    written.push(`${name}.png`);
  }
}

await writeFile(
  join(outDir, 'room-geometry.json'),
  JSON.stringify(geometryManifest({ size, seed }), null, 2) + '\n'
);
written.push('room-geometry.json');

// A 3x3 proof sheet: nine copies of the same tile, so the joins are visible
// (or rather, are not).
if (rasterize) {
  const png = rasterize(renderRoom({ size, seed, style: 'schematic' }).svg);
  const href = `data:image/png;base64,${png.toString('base64')}`;
  const cells = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      cells.push(
        `<image href="${href}" x="${c * size}" y="${r * size}" width="${size}" height="${size}"/>`
      );
    }
  }
  const sheet =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 3}" height="${size * 3}" ` +
    `viewBox="0 0 ${size * 3} ${size * 3}">${cells.join('')}</svg>`;
  await writeFile(join(outDir, 'tiled-3x3.png'), rasterize(sheet, size * 3));
  written.push('tiled-3x3.png');
}

console.log(`base room: ${size}x${size}, seed ${seed}`);
console.log(`wrote ${written.length} files to ${outDir}`);
for (const f of written) console.log(`  ${f}`);
if (!rasterize) {
  console.warn('\n! @resvg/resvg-js not installed - PNG output skipped. Run: npm install');
}

// ---------------------------------------------------------------------------

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = args[++i];
  }
  return out;
}

async function loadRasterizer() {
  try {
    const { Resvg } = await import('@resvg/resvg-js');
    return (markup, width) =>
      Buffer.from(
        new Resvg(markup, width ? { fitTo: { mode: 'width', value: width } } : {})
          .render()
          .asPng()
      );
  } catch {
    return null;
  }
}
