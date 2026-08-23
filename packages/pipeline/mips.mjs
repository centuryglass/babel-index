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
 *
 * ### Re-runs are incremental
 *
 * Every scaled level is written with the source file's content hash embedded
 * in its JPEG EXIF (`ImageDescription`). A rerun hashes the source again and
 * skips any level whose file already carries that hash - so touching a few
 * images in a large corpus costs a few resizes, not the whole pyramid.
 * Level 0 is untouched by this: in place it is never rewritten anyway, and to
 * a separate `--out` it is copied byte for byte, which is already cheap.
 */
import { mkdir, copyFile, readdir, stat, readFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { LEVELS } from '../web/src/pyramid.js';
import { mipPlan } from './layout.mjs';

// Re-exported because this is where callers have always looked for it. It lives
// in layout.mjs so scan.mjs can read the layout without importing sharp.
export { mipPlan } from './layout.mjs';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Prefixes the hash inside the EXIF ImageDescription so it reads unambiguously
// against whatever else might land in that tag, and so a plain string search of
// the raw EXIF bytes finds it without a TIFF parser.
const HASH_PREFIX = 'babel-index:sha256:';
const HASH_PATTERN = new RegExp(`${HASH_PREFIX}([0-9a-f]{64})`);

/** A hash of the source file's bytes, embedded in every level scaled from it. */
export async function contentHash(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/**
 * The content hash embedded in a previously-written level, or null if the file
 * is missing, unreadable, or was never stamped by this tool - any of which
 * means it must be (re)written rather than trusted.
 */
async function embeddedHash(file) {
  try {
    const { exif } = await sharp(file).metadata();
    if (!exif) return null;
    return exif.toString('latin1').match(HASH_PATTERN)?.[1] ?? null;
  } catch {
    return null;
  }
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
 * @returns {Promise<{plan: object[], written: number, skipped: number, cached: number}>}
 */
export async function writeMips({ file, outDir, inPlace = false, quality = 82, levels = LEVELS }) {
  const meta = await sharp(file).metadata();
  const plan = mipPlan({ w: meta.width, h: meta.height }, levels);
  const name = basename(file);
  const hash = await contentHash(file);

  let written = 0;
  let skipped = 0;
  let cached = 0;
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
      written++;
      continue;
    }

    if ((await embeddedHash(target)) === hash) {
      cached++; // already current - the source hasn't changed since this was written
      continue;
    }

    await sharp(file)
      .resize(step.w, step.h, { kernel: 'lanczos3' })
      .jpeg({ quality, mozjpeg: true })
      .withExif({ IFD0: { ImageDescription: HASH_PREFIX + hash } })
      .toFile(target);
    written++;
  }

  return { plan, written, skipped, cached, source: { w: meta.width, h: meta.height } };
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
