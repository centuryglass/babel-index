/**
 * Writing the resolution pyramid to disk.
 *
 * The client picks a level per frame (see packages/web/src/pyramid.js); this is
 * the job that makes those levels exist. It runs once per corpus, offline, and
 * is deliberately not something the server does on demand - resizing 10,000
 * rooms is a pipeline concern, and a server that resizes on request has put a
 * CPU-bound job on the request path.
 *
 * The ladder is imported from pyramid.js rather than restated, so the sizes
 * written here cannot drift from the sizes the client asks for. That import is
 * the point: one ladder, two consumers.
 *
 * ### Layout on disk
 *
 *   <dir>/000.jpg          level 0 - the source art, left where it is
 *   <dir>/512/000.jpg      level 1
 *   <dir>/256/000.jpg      level 2      ... directory named for the width
 *
 * Level 0 stays flat rather than being copied into a <width>/ directory of its
 * own, so running this in place costs no duplicated bytes and a corpus that has
 * never been through the pipeline still reads as a valid level 0. Pass a
 * separate --out and every level is written, including 0, for the case where
 * the pyramid is being staged for upload.
 *
 * Widths name the directories because width is the axis the client's ladder is
 * expressed in; a non-square tile keeps its aspect at every level, so the width
 * identifies the level unambiguously.
 */
import { mkdir, copyFile, readdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import sharp from 'sharp';
import { LEVELS } from '../web/src/pyramid.js';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * What levels a source image of these dimensions should produce.
 *
 * Sizes come from the source rather than from BASE_TILE so the tool works on
 * whatever the render actually is, and the aspect is preserved exactly - each
 * level is the source divided by the ladder's divisor, both axes together.
 *
 * A source too small to support the whole ladder yields fewer levels rather
 * than duplicate ones: two divisors that round to the same width would write
 * the same directory twice, which is a silent corruption of the ladder.
 *
 * @param {{w: number, h: number}} source
 * @param {{level: number, divisor: number}[]} [levels]
 * @returns {{level: number, w: number, h: number, dir: string}[]} finest first
 */
export function mipPlan({ w, h }, levels = LEVELS) {
  const plan = [];
  const seen = new Set();
  for (const { level, divisor } of levels) {
    const size = {
      w: Math.max(1, Math.round(w / divisor)),
      h: Math.max(1, Math.round(h / divisor)),
    };
    if (seen.has(size.w)) continue; // source too small to tell these levels apart
    seen.add(size.w);
    plan.push({ level, ...size, dir: String(size.w) });
  }
  return plan;
}

/**
 * Resize one image into every level below 0.
 *
 * Level 0 is written only when `outDir` differs from the image's own directory;
 * in place it is already there. `lanczos3` is sharp's default kernel and the
 * right one here - these are photographs being minified, where a box filter
 * would alias the book spines into moire.
 *
 * @param {object} opts
 * @param {string} opts.file        absolute path to the source image
 * @param {string} opts.outDir      root the <width>/ directories go under
 * @param {boolean} [opts.inPlace]  outDir is the source's own directory
 * @param {number} [opts.quality]   JPEG/WebP quality for the generated levels
 * @param {{level: number, divisor: number}[]} [opts.levels]
 * @returns {Promise<{plan: object[], written: number, skipped: number}>}
 */
export async function writeMips({ file, outDir, inPlace = false, quality = 82, levels = LEVELS }) {
  const image = sharp(file);
  const meta = await image.metadata();
  const plan = mipPlan({ w: meta.width, h: meta.height }, levels);
  const name = basename(file);

  let written = 0;
  let skipped = 0;
  for (const step of plan) {
    const dir = join(outDir, step.dir);
    const target = join(dir, name);

    if (step.level === 0 && inPlace) {
      skipped++; // in place, the flat file already is level 0
      continue;
    }

    await mkdir(dir, { recursive: true });
    if (step.level === 0) {
      await copyFile(file, target); // no requantisation of the source art
    } else {
      await sharp(file)
        .resize(step.w, step.h, { kernel: 'lanczos3' })
        .jpeg({ quality, mozjpeg: true })
        .toFile(target);
    }
    written++;
  }

  return { plan, written, skipped, source: { w: meta.width, h: meta.height } };
}

/**
 * Every image directly inside a directory, ignoring the <width>/ subdirectories
 * this tool writes. Sorted, so ids stay stable the way scan.mjs assigns them.
 */
export async function sourceImages(dir) {
  const entries = await readdir(dir);
  const files = [];
  for (const entry of entries) {
    if (!IMAGE_EXT.has(extname(entry).toLowerCase())) continue;
    const st = await stat(join(dir, entry));
    if (st.isFile()) files.push(entry);
  }
  return files.sort();
}

/**
 * Check every source shares one aspect ratio.
 *
 * A corpus of mixed aspects cannot tile: the map draws one cell shape, so a
 * room with a different one is either stretched or letterboxed, and neither is
 * a decision worth making silently on someone's behalf.
 *
 * @param {{file: string, w: number, h: number}[]} sizes
 * @param {number} [tolerance] fractional difference allowed against the first
 * @returns {{aspect: number, outliers: object[]}}
 */
export function checkAspects(sizes, tolerance = 0.01) {
  if (!sizes.length) return { aspect: null, outliers: [] };
  const aspect = sizes[0].w / sizes[0].h;
  const outliers = sizes.filter((s) => Math.abs(s.w / s.h - aspect) / aspect > tolerance);
  return { aspect, outliers };
}
