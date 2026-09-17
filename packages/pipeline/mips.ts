/**
 * Writing the resolution pyramid to disk.
 *
 * The client picks a level per frame (`packages/web/src/lib/pyramid.ts`); this
 * is the job that makes those levels exist. It runs once per corpus, offline:
 * resizing 10,000 rooms is a CPU-bound job, and a server that resizes on
 * request has put that job on the request path.
 *
 * The level sizes come from `LEVELS`, imported rather than restated, so the
 * sizes written here cannot drift from the sizes the client asks for. The
 * on-disk layout - the directory convention, why a directory is named for its
 * width, why level 0 stays flat - is `layout.ts`'s to state.
 *
 * ### Re-runs are incremental
 *
 * Every scaled level is written with its source's content hash embedded in the
 * JPEG EXIF (`ImageDescription`). A rerun hashes the source again and skips any
 * level whose file already carries that hash, so touching a few images in a
 * large corpus costs a few resizes. Level 0 is never gated by this: in place it
 * is not rewritten, and to a separate `--out` it is copied byte for byte.
 *
 * `updateMetadataHashes` records each source's hash in the corpus's
 * `metadata.json` as well.
 */
import { mkdir, copyFile, readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { LEVELS } from '../web/src/lib/pyramid.ts';
import { mipPlan, type Size, type LevelStep, type MipStep } from './layout.ts';

// Re-exported for callers that plan and write through this module. The
// definition is `layout.ts`'s, for the dependency-budget reason stated there.
export { mipPlan } from './layout.ts';
export type { Size, LevelStep, MipStep } from './layout.ts';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Mirrors packages/server/scan.ts's METADATA_FILE. Not imported from there:
// that module pulls in the server's directory-scan machinery, and this is a
// name, not behaviour.
const METADATA_FILE = 'metadata.json';

// Prefixes the hash inside the EXIF ImageDescription so it reads unambiguously
// against whatever else might land in that tag, and so a plain string search of
// the raw EXIF bytes finds it without a TIFF parser.
const HASH_PREFIX = 'babel-index:sha256:';
const HASH_PATTERN = new RegExp(`${HASH_PREFIX}([0-9a-f]{64})`);

/** One `metadata.json` sidecar entry. Unknown fields must round-trip - see `updateMetadataHashes`. */
type SidecarEntry = Record<string, unknown>;
type Sidecar = Record<string, SidecarEntry>;

export interface WriteMipsResult {
  plan: MipStep[];
  /** Levels this run resized or copied. */
  written: number;
  /** Level 0 in place: already where it belongs, so never counted as written. */
  skipped: number;
  /** Levels whose embedded hash matched the source, so nothing was resized. */
  cached: number;
  /** The source's content hash, for the caller to record. */
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
 * Level 0 is written only when `outDir` is not the image's own directory: in
 * place, the flat source already is level 0, and to a separate `--out` it is
 * copied so a staged corpus holds every level for upload.
 *
 * `lanczos3` is sharp's default kernel, spelled out because a box filter
 * aliases the art's fine book spines into moire.
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
 * sidecar - the keyword/story data, keyed by filename like every other field
 * there (`packages/map/metadata.ts`).
 *
 * This copy is not what gates a rewrite - the EXIF stamp is. It is there so a
 * hosted corpus can be compared with a local one: diffing two
 * `metadata.json` files names which source images changed, without fetching the
 * images to compare them. `tools/upload` does not read this field; see its
 * `diffAgainstManifest`.
 *
 * Existing `keywords`/`story`/`alt` are preserved untouched; only `hash` is
 * added or refreshed. `normaliseEntry` ignores fields it does not know, so an
 * entry that is otherwise empty stays "no metadata" to the map while still
 * carrying a hash.
 *
 * A missing or unreadable sidecar is started fresh rather than failing the run,
 * so a corpus with no keyword/story data yet still gets one with hashes.
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
    // no sidecar yet, or unreadable: starts fresh
  }

  for (const [file, hash] of hashes) {
    const existing = sidecar[file];
    sidecar[file] =
      existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing, hash } : { hash };
  }

  await writeFile(path, JSON.stringify(sidecar, null, 2) + '\n');
}

/**
 * Every image directly inside a directory, ignoring the `<width>/` and
 * `<width>-sheets/` subdirectories this tool writes - a rerun that found them
 * would resize its own output, one level per run. Sorted, because `scan.ts`
 * assigns room ids by position in that order.
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
 * room with a different one is stretched or letterboxed, and neither is a
 * decision to make silently.
 *
 * Shape only, not size. Same-aspect sources of different dimensions pass, and
 * the caller plans levels and sheet grids from the first of them.
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
