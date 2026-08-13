#!/usr/bin/env node
/**
 * Generate the placeholder tile and the geometry that describes it.
 *
 *   node tools/base-image/generate.mjs [--width 1024] [--height 768]
 *                                      [--seed 1941]
 *                                      [--base path/to/base-render.png]
 *                                      [--out assets/base-tile]
 *
 * With --base, the geometry overlay is composited over the real Blender render
 * so the provisional proportions in lib/geometry.js can be checked and
 * corrected against it. That is the main reason this tool still exists now that
 * a real base render and corpus are in hand.
 *
 * THE TILE IS NOT SQUARE, so this takes a width and a height. --height defaults
 * to the aspect the geometry was traced at, which is the only shape the measured
 * rects mean anything at: give this tool a square and every book lands somewhere
 * the render does not have one. `--size` is still accepted as an old name for
 * --width. Passing a height that fights the trace is allowed - that is how you
 * see what a reshaped tile would do - but it is a deliberate act.
 *
 * SVG output has no dependencies. PNG output additionally needs
 * @resvg/resvg-js; without it the SVGs are still written.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { renderTile, renderOverlay, geometryManifest } from './lib/render.js';
import { TILE_ASPECT } from './lib/geometry.js';
import { seedFrom } from './lib/prng.js';

const argv = parseArgs(process.argv.slice(2));
const width = Number(argv.width ?? argv.size ?? 1024);
const height = Number(argv.height ?? Math.round(width * TILE_ASPECT));
const seed =
  argv.seed === undefined ? 1941 : /^\d+$/.test(argv.seed) ? Number(argv.seed) : seedFrom(argv.seed);
const outDir = resolve(process.cwd(), argv.out ?? 'assets/base-tile');
const rasterize = await loadRasterizer();

let baseHref = null;
if (argv.base) {
  const path = resolve(process.cwd(), argv.base);
  const mime = extname(path).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  baseHref = `data:${mime};base64,${(await readFile(path)).toString('base64')}`;
}

await mkdir(outDir, { recursive: true });

const targets = [
  ['tile-placeholder', renderTile({ width, height, seed, style: 'schematic' }).svg],
  ['tile-lineart', renderTile({ width, height, seed, style: 'lineart' }).svg],
  ['tile-depth', renderTile({ width, height, seed, style: 'depth' }).svg],
  ['geometry-overlay', renderOverlay({ width, height, baseImageHref: baseHref }).svg],
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
  join(outDir, 'tile-geometry.json'),
  JSON.stringify(geometryManifest({ width, height, seed }), null, 2) + '\n'
);
written.push('tile-geometry.json');

if (rasterize) {
  const png = rasterize(renderTile({ width, height, seed, style: 'schematic' }).svg);
  await writeFile(join(outDir, 'tiled-3x3.png'), rasterize(sheet(png, width, height, 3), width * 3));
  written.push('tiled-3x3.png');
}

console.log(`tile: ${width}x${height}, seed ${seed}${baseHref ? ', overlay on ' + argv.base : ''}`);
console.log(`wrote ${written.length} files to ${outDir}`);
for (const f of written) console.log(`  ${f}`);
if (!baseHref)
  console.log('\n  tip: --base <blender-render.png> overlays the geometry on the real render');
if (!rasterize) console.warn('\n! @resvg/resvg-js not installed - PNG output skipped. Run: npm install');

// ---------------------------------------------------------------------------

/** n x n copies of the tile, to check that the frame really does abut itself. */
function sheet(png, w, h, n) {
  const href = `data:image/png;base64,${png.toString('base64')}`;
  const cells = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      cells.push(`<image href="${href}" x="${c * w}" y="${r * h}" width="${w}" height="${h}"/>`);
  return (
    `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${w * n}" height="${h * n}" viewBox="0 0 ${w * n} ${h * n}">${cells.join('')}</svg>`
  );
}

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
        new Resvg(markup, width ? { fitTo: { mode: 'width', value: width } } : {}).render().asPng()
      );
  } catch {
    return null;
  }
}
