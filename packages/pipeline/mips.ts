/**
 * Writing the resolution pyramid to disk.
 *
 * The client picks a level per frame (see packages/web/src/lib/pyramid.ts); this is
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
 *
 * The same hash also lands in `metadata.json` - the keyword/story sidecar
 * (packages/map/metadata.js), keyed by filename like everything else there -
 * via `updateMetadataHashes`. That copy is not for gating a rewrite; it is so
 * that once a corpus is hosted somewhere, a local regeneration's hashes can be
 * diffed against the last uploaded metadata.json to name exactly which source
 * images changed, without fetching the images themselves to check.
 */
import { mkdir, copyFile, readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { LEVELS } from '../web/src/lib/pyramid.ts';
import { mipPlan, type Size, type LevelStep, type MipStep } from './layout.ts';

// Re-exported because this is where callers have always looked for it. It lives
// in layout.ts so scan.ts can read the layout without importing sharp.
export { mipPlan } from './layout.ts';
export type { Size, LevelStep, MipStep } from './layout.ts';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Mirrors packages/server/scan.ts's METADATA_FILE constant. Not imported from
// there - that module pulls in the server's directory-scan machinery, and this
// is a name, not behaviour, so restating it is cheaper than the coupling.
const METADATA_FILE = 'metadata.json';

// Prefixes the hash inside the EXIF ImageDescription so it reads unambiguously
// against whatever else might land in that tag, and so a plain string search of
// the raw EXIF bytes finds it without a TIFF parser.
const HASH_PREFIX = 'babel-index:sha256:';
const HASH_PATTERN = new RegExp(`${HASH_PREFIX}([0-9a-f]{64})`);

/** One `metadata.json` sidecar entry - loose on purpose, see updateMetadataHashes. */
type SidecarEntry = Record<string, unknown>;
type Sidecar = Record<string, SidecarEntry>;

export interface WriteMipsResult {
  plan: MipStep[];
  written: number;
  skipped: number;
  cached: number;
  hash: string;
  source: Size;
}

/** A hash of the source file's bytes, embedded in every level scaled from it. */
export async function contentHash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/**
 * The content hash embedded in a previously-written level, or null if the file
 * is missing, unreadable, or was never stamped by this tool - any of which
 * means it must be (re)written rather than trusted.
 */
async function embeddedHash(file: string): Promise<string | null> {
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
 * @param opts.file        absolute path to the source image
 * @param opts.outDir      root the <width>/ directories go under
 * @param opts.inPlace     outDir is the source's own directory
 * @param opts.quality     JPEG/WebP quality for the generated levels
 */
export async function writeMips({
  file,
  outDir,
  inPlace = false,
  quality = 82,
  levels = LEVELS,
}: {
  file: string;
  outDir: string;
  inPlace?: boolean;
  quality?: number;
  levels?: LevelStep[];
}): Promise<WriteMipsResult> {
  const meta = await sharp(file).metadata();
  const plan = mipPlan({ w: meta.width, h: meta.height }, levels);
  const name = basename(file);
  const hash = await contentHash(file);

  let written = 0;
  let skipped = 0;
  let cached = 0;
  for (const step of plan) {
    const dir = join(outDir, step.dir ?? '');
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

  return { plan, written, skipped, cached, hash, source: { w: meta.width, h: meta.height } };
}

/**
 * Merge a content hash onto each file's entry in the corpus's `metadata.json`
 * sidecar, keyed by filename like every other field there (packages/map/
 * metadata.js). Existing `keywords`/`story`/`alt` are left exactly as they
 * are - this only adds or refreshes `hash`; `normaliseEntry` ignores fields it
 * doesn't know, so an entry that is otherwise empty stays "no metadata" to the
 * map while still carrying a hash for sync tooling to read.
 *
 * A missing or unreadable sidecar is started fresh rather than failing the
 * run - a corpus with no keyword/story data yet still gets one with hashes.
 *
 * @param dir the corpus directory `metadata.json` lives in
 * @param hashes filename -> content hash
 */
export async function updateMetadataHashes(dir: string, hashes: Map<string, string>): Promise<void> {
  const path = join(dir, METADATA_FILE);
  let sidecar: Sidecar = {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sidecar = parsed;
  } catch {
    // no sidecar yet, or unreadable - start fresh rather than fail the run
  }

  for (const [file, hash] of hashes) {
    const existing = sidecar[file];
    sidecar[file] =
      existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing, hash } : { hash };
  }

  await writeFile(path, JSON.stringify(sidecar, null, 2) + '\n');
}

/**
 * Every image directly inside a directory, ignoring the <width>/ subdirectories
 * this tool writes. Sorted, so ids stay stable the way scan.mjs assigns them.
 */
export async function sourceImages(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (!IMAGE_EXT.has(extname(entry).toLowerCase())) continue;
    const st = await stat(join(dir, entry));
    if (st.isFile()) files.push(entry);
  }
  return files.sort();
}

export interface SourceSize extends Size {
  file: string;
}

/**
 * Check every source shares one aspect ratio.
 *
 * A corpus of mixed aspects cannot tile: the map draws one cell shape, so a
 * room with a different one is either stretched or letterboxed, and neither is
 * a decision worth making silently on someone's behalf.
 *
 * @param tolerance fractional difference allowed against the first
 */
export function checkAspects(
  sizes: SourceSize[],
  tolerance = 0.01
): { aspect: number | null; outliers: SourceSize[] } {
  if (!sizes.length) return { aspect: null, outliers: [] };
  const aspect = sizes[0].w / sizes[0].h;
  const outliers = sizes.filter((s) => Math.abs(s.w / s.h - aspect) / aspect > tolerance);
  return { aspect, outliers };
}
