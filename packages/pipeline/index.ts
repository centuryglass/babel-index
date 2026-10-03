#!/usr/bin/env node
/**
 * The pyramid generator - `npm run generate:mips`.
 *
 *   npm run generate:mips -- --images assets/tile-collection-sample
 *   npm run generate:mips -- --images <dir> --out <dir> [--quality 82]
 *   npm run generate:mips -- --images <dir> [--center center.jpg]
 *
 * Resizes every source image to each level of the ladder and writes the result
 * to the layout `layout.ts` states. With no --out it works in place: the
 * sources stay as level 0 and only the smaller levels are added, so running it
 * on a collection directory changes nothing that was already there. Reruns skip
 * work that is still current - see `mips.ts`.
 *
 * The coarse levels, from `SHEETS.fromLevel` on, are resized straight into
 * shared sheets (`sheets.ts`) and never written per-file.
 *
 * The collection's `shared/` subdirectory (`scan.ts`'s `SHARED_TILES_DIR`)
 * then gets the same per-file ladder for the center render and every
 * `generic/` and `generic_distill/` tile, in place in the source collection
 * even with --out - see `shared-mips.ts`.
 *
 * The ladder is `LEVELS` in packages/web/src/lib/pyramid.ts, the same list the
 * client picks levels from, so what this writes and what it asks for cannot
 * drift apart.
 */
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { LEVELS, SHEETS } from '../web/src/lib/pyramid.ts';
import { mipPlan, writeMips, sourceImages, checkSizes, type SourceSize } from './mips.ts';
import { writeSheets, sheetDirName } from './sheets.ts';
import { writeSharedMips } from './shared-mips.ts';
import { SHARED_TILES_DIR } from '../server/scan.ts';

const argv = parseArgs(process.argv.slice(2));
const imagesDir = resolve(process.cwd(), argv.images ?? 'assets/tile-collection-sample');
const outDir = argv.out ? resolve(process.cwd(), argv.out) : imagesDir;
const inPlace = outDir === imagesDir;
const quality = Number(argv.quality ?? 82);
const tilesDir = join(imagesDir, SHARED_TILES_DIR);

if (!existsSync(imagesDir)) {
  console.error(`no such directory: ${imagesDir}`);
  process.exit(1);
}

const files = await sourceImages(imagesDir);
if (!files.length) {
  console.error(`no images found in ${imagesDir}`);
  process.exit(1);
}

// The size check runs before any resizing: a collection that cannot tile is
// worth knowing about before 10,000 rooms have been resized for nothing.
const sizes: SourceSize[] = [];
for (const file of files) {
  const meta = await sharp(join(imagesDir, file)).metadata();
  sizes.push({ file, w: meta.width ?? 0, h: meta.height ?? 0 });
}

const { size, outliers } = checkSizes(sizes);
if (outliers.length) {
  console.error(`\n  ${outliers.length} image(s) do not match the collection size of ${size?.w}x${size?.h}:`);
  for (const o of outliers.slice(0, 10)) console.error(`    ${o.file}  ${o.w}x${o.h}`);
  if (outliers.length > 10) console.error(`    ... and ${outliers.length - 10} more`);
  console.error('\n  The map draws one cell shape; a room of another size is stretched or');
  console.error('  letterboxed. Fix the collection, or re-render at one size.\n');
  process.exit(1);
}

// Levels from `SHEETS.fromLevel` on are packed into shared sheets, resized
// straight from the sources by `writeSheets`; only the levels below it are
// written per-file.
const plan = mipPlan(sizes[0], LEVELS);
const perFileLevels = LEVELS.filter((step) => step.level < SHEETS.fromLevel);
const isPacked = (step: { level: number }) => step.level >= SHEETS.fromLevel;
console.log(`\n  ${files.length} rooms in ${imagesDir}`);
console.log(`  source ${sizes[0].w}x${sizes[0].h}`);
if (plan.length < LEVELS.length)
  console.log(`  ${plan.length} of ${LEVELS.length} levels - the source is too small for the rest`);
for (const step of plan)
  console.log(
    `    level ${step.level}  ${step.w}x${step.h}` +
      (step.level === 0 && inPlace
        ? '  (already on disk)'
        : `  -> ${isPacked(step) ? sheetDirName(step.w) : step.dir}/`)
  );
console.log(inPlace ? '\n  writing in place ...\n' : `\n  writing to ${outDir} ...\n`);

let written = 0;
let cached = 0;
let done = 0;
const sourceHashes: string[] = [];
for (const file of files) {
  const result = await writeMips({ file: join(imagesDir, file), outDir, inPlace, quality, levels: perFileLevels });
  sourceHashes.push(result.hash);
  written += result.written;
  cached += result.cached;
  done++;
  if (done % 25 === 0 || done === files.length)
    process.stdout.write(`  ${done}/${files.length} rooms, ${written} files written, ${cached} unchanged\r`);
}

console.log(`\n\n  done: ${written} files written, ${cached} unchanged\n`);

const sheetSteps = plan.filter(isPacked);
if (sheetSteps.length) {
  console.log(`  packing ${sheetSteps.length} level(s) into ${SHEETS.roomsPerSheet}-room sheets ...\n`);
  for (const step of sheetSteps) {
    const result = await writeSheets({
      sourceDir: imagesDir,
      levelDir: join(outDir, step.dir ?? ''),
      files,
      sourceHashes,
      tileSize: { w: step.w, h: step.h },
      quality,
    });
    console.log(
      `    level ${step.level}  ${result.sheetCount} sheet(s), ${result.written} written, ${result.cached} unchanged`
    );
  }
  console.log('');
}

// The shared tiles (the center render, every generic/ tile and every
// generic_distill/ tile) get the same per-file ladder, rooted at the
// collection's shared/ directory. See shared-mips.ts.
if (existsSync(tilesDir)) {
  console.log(`  shared tiles in ${tilesDir} ...\n`);
  const shared = await writeSharedMips({ tilesDir, center: argv.center, quality });
  console.log(
    shared.center
      ? `    center: ${shared.center.file}  ${shared.center.written} written, ${shared.center.cached} unchanged`
      : '    center: none found'
  );
  const genericWritten = shared.generic.reduce((n, g) => n + g.written, 0);
  const genericCached = shared.generic.reduce((n, g) => n + g.cached, 0);
  console.log(`    generic: ${shared.generic.length} tile(s), ${genericWritten} written, ${genericCached} unchanged`);
  const distillWritten = shared.genericDistill.reduce((n, g) => n + g.written, 0);
  const distillCached = shared.genericDistill.reduce((n, g) => n + g.cached, 0);
  console.log(
    `    generic_distill: ${shared.genericDistill.length} tile(s), ${distillWritten} written, ${distillCached} unchanged\n`
  );
}

function parseArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = args[++i];
  }
  return out;
}
