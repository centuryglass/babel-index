#!/usr/bin/env node
/**
 * The pyramid generator.
 *
 *   npm run generate:mips -- --images assets/corpus-sample
 *   npm run generate:mips -- --images <dir> --out <dir> [--quality 82]
 *
 * Writes every level below 0 as <out>/<width>/<file>. With no --out it works in
 * place, leaving the source files where they are as level 0 - so running it on
 * a corpus directory adds the smaller levels and changes nothing that was
 * already there. Levels already current for their source (see mips.mjs's
 * content-hash caching) are left alone, so a rerun after touching a handful of
 * images only re-resizes those.
 *
 * The ladder comes from packages/web/src/lib/pyramid.ts, so what this writes and
 * what the client asks for cannot drift apart. Resizing is the whole of the
 * work, which is why it is a pipeline job run once rather than anything the
 * demo server does on request.
 */
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import sharp from 'sharp';
import { LEVELS, SHEETS } from '../web/src/lib/pyramid.ts';
import { mipPlan, writeMips, sourceImages, checkAspects, updateMetadataHashes } from './mips.mjs';
import { writeSheets } from './sheets.ts';

const argv = parseArgs(process.argv.slice(2));
const imagesDir = resolve(process.cwd(), argv.images ?? 'assets/corpus-sample');
const outDir = argv.out ? resolve(process.cwd(), argv.out) : imagesDir;
const inPlace = outDir === imagesDir;
const quality = Number(argv.quality ?? 82);

if (!existsSync(imagesDir)) {
  console.error(`no such directory: ${imagesDir}`);
  process.exit(1);
}

const files = await sourceImages(imagesDir);
if (!files.length) {
  console.error(`no images found in ${imagesDir}`);
  process.exit(1);
}

// Aspect first: a corpus that cannot agree on a shape cannot tile, and finding
// that out after resizing 10,000 rooms is finding it out too late.
const sizes = [];
for (const file of files) {
  const meta = await sharp(join(imagesDir, file)).metadata();
  sizes.push({ file, w: meta.width, h: meta.height });
}

const { aspect, outliers } = checkAspects(sizes);
if (outliers.length) {
  console.error(`\n  ${outliers.length} image(s) do not share the corpus aspect of ${aspect.toFixed(4)}:`);
  for (const o of outliers.slice(0, 10))
    console.error(`    ${o.file}  ${o.w}x${o.h}  (${(o.w / o.h).toFixed(4)})`);
  if (outliers.length > 10) console.error(`    ... and ${outliers.length - 10} more`);
  console.error('\n  The map draws one cell shape; a room with another is stretched or');
  console.error('  letterboxed. Fix the corpus, or re-render at one size.\n');
  process.exit(1);
}

const plan = mipPlan(sizes[0], LEVELS);
console.log(`\n  ${files.length} rooms in ${imagesDir}`);
console.log(`  source ${sizes[0].w}x${sizes[0].h}, aspect ${aspect.toFixed(4)}`);
if (plan.length < LEVELS.length)
  console.log(`  ${plan.length} of ${LEVELS.length} levels - the source is too small for the rest`);
for (const step of plan)
  console.log(
    `    level ${step.level}  ${step.w}x${step.h}` +
      (step.level === 0 && inPlace ? '  (already on disk)' : `  -> ${step.dir}/`)
  );
console.log(inPlace ? '\n  writing in place ...\n' : `\n  writing to ${outDir} ...\n`);

let written = 0;
let cached = 0;
let done = 0;
const hashes = new Map();
for (const file of files) {
  const result = await writeMips({ file: join(imagesDir, file), outDir, inPlace, quality });
  written += result.written;
  cached += result.cached;
  hashes.set(file, result.hash);
  done++;
  if (done % 25 === 0 || done === files.length)
    process.stdout.write(`  ${done}/${files.length} rooms, ${written} files written, ${cached} unchanged\r`);
}

console.log(`\n\n  done: ${written} files written, ${cached} unchanged, across ${plan.length} levels\n`);

// Pack the coarse levels into shared sheets so a scroll session at that zoom
// needs a handful of requests instead of one per room (see SHEETS's docblock
// in packages/web/src/lib/pyramid.ts for why this exists and which levels).
// writeMips above always writes every level per-file first - sheets are
// composited FROM those files, not from the source directly - so the
// per-file directory for a sheet-packed level is deleted once its sheets are
// current: it is pure scratch at that point, absorbed into the sheets and
// never read by anything downstream (discoverLevels checks sheets for these
// levels, not the per-file directory). A future rerun just re-resizes into
// it again before repacking - cheap, and the sheets themselves still skip
// recompositing via their own hash sidecar since the resize is deterministic.
const sheetSteps = plan.filter((step) => step.level >= SHEETS.fromLevel);
if (sheetSteps.length) {
  console.log(`  packing ${sheetSteps.length} level(s) into ${SHEETS.roomsPerSheet}-room sheets ...\n`);
  for (const step of sheetSteps) {
    const levelDir = join(outDir, step.dir);
    const result = await writeSheets({ levelDir, files, tileSize: { w: step.w, h: step.h }, quality });
    console.log(
      `    level ${step.level}  ${result.sheetCount} sheet(s), ${result.written} written, ${result.cached} unchanged`
    );
    await rm(levelDir, { recursive: true, force: true });
  }
  console.log('');
}

// Recorded alongside the keyword/story sidecar so that once the corpus is
// hosted, a local regeneration's metadata.json can be diffed against the last
// uploaded one to name exactly which source images changed.
await updateMetadataHashes(imagesDir, hashes);
console.log(`  metadata.json: ${hashes.size} content hash(es) recorded\n`);

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
