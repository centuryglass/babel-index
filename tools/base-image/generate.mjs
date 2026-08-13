#!/usr/bin/env node
/**
 * Generate the placeholder tile and the geometry that describes it.
 *
 *   node tools/base-image/generate.mjs [--size 1024] [--seed 1941]
 *                                      [--base path/to/base-render.png]
 *                                      [--out assets/base-tile]
 *
 * With --base, the geometry overlay is composited over the real Blender render
 * so the provisional proportions in lib/geometry.js can be checked and
 * corrected against it. That is the main reason this tool still exists now that
 * a real base render and corpus are in hand.
 *
 * KNOWN STALE: --size is one number and everything here lays out at size x size,
 * so the output is square while the tile is 1024x768. Every rect is therefore
 * stretched 4:3 -> 1:1 against the trace it came from, and tile-geometry.json
 * records a square tile. Nothing in packages/ reads these files, but they are
 * wrong until this takes a height. See docs/implementation-plan.md section 7.
 *
 * SVG output has no dependencies. PNG output additionally needs
 * @resvg/resvg-js; without it the SVGs are still written.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { renderTile, renderOverlay, geometryManifest } from './lib/render.js';
import { seedFrom } from './lib/prng.js';

const argv = parseArgs(process.argv.slice(2));
const size = Number(argv.size ?? 1024);
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
  ['tile-placeholder', renderTile({ size, seed, style: 'schematic' }).svg],
  ['tile-lineart', renderTile({ size, seed, style: 'lineart' }).svg],
  ['tile-depth', renderTile({ size, seed, style: 'depth' }).svg],
  ['geometry-overlay', renderOverlay({ size, baseImageHref: baseHref }).svg],
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
  JSON.stringify(geometryManifest({ size, seed }), null, 2) + '\n'
);
written.push('tile-geometry.json');

if (rasterize) {
  const png = rasterize(renderTile({ size, seed, style: 'schematic' }).svg);
  await writeFile(join(outDir, 'tiled-3x3.png'), rasterize(sheet(png, size, 3), size * 3));
  written.push('tiled-3x3.png');
}

console.log(`tile: ${size}x${size}, seed ${seed}${baseHref ? ', overlay on ' + argv.base : ''}`);
console.log(`wrote ${written.length} files to ${outDir}`);
for (const f of written) console.log(`  ${f}`);
if (!baseHref)
  console.log('\n  tip: --base <blender-render.png> overlays the geometry on the real render');
if (!rasterize) console.warn('\n! @resvg/resvg-js not installed - PNG output skipped. Run: npm install');

// ---------------------------------------------------------------------------

function sheet(png, size, n) {
  const href = `data:image/png;base64,${png.toString('base64')}`;
  const cells = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      cells.push(`<image href="${href}" x="${c * size}" y="${r * size}" width="${size}" height="${size}"/>`);
  return (
    `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${size * n}" height="${size * n}" viewBox="0 0 ${size * n} ${size * n}">${cells.join('')}</svg>`
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
