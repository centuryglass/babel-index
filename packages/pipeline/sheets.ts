/**
 * Packing coarse pyramid levels into fixed-grid tilesheets.
 *
 * Every level at or above `SHEETS.fromLevel` is composited into grids of
 * `SHEETS.roomsPerSheet` rooms, one request per grid instead of one per room.
 * `SHEETS`'s docblock in packages/web/src/lib/pyramid.ts states why that pays
 * only at the coarse end of the ladder, and infra/README.md the rate limit and
 * billing shape it works around. Levels below it stay one file per room.
 *
 * The compositing happens at generation time, here: the origin server serves
 * finished files and never builds an image on request.
 *
 * `layout.ts` holds the addressing (`sheetPlan`, `sheetPosition`,
 * `sheetDirName`, `sheetFileName`) and is re-exported below; its header states
 * why the arithmetic is split from this file.
 *
 * ### Re-runs are incremental
 *
 * A sheet has no single source file to stamp with an EXIF hash the way
 * `mips.ts` stamps a per-file level, so each sheet directory carries a
 * `hashes.json` sidecar instead: sheet index -> a hash of the tile size, the
 * quality and its members' source content hashes, in order. Only a sheet whose
 * combined hash moved is rebuilt, and only its members are resized, so an
 * unchanged collection costs no image work and one touched room costs O(sheet
 * size) rather than O(collection size). See `diffAgainstManifest` in
 * tools/upload/lib.ts for the re-upload unit that follows once a sheet is
 * synced to R2.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { SHEETS } from '../web/src/lib/pyramid.ts';
import { contentHash } from './mips.ts';
import { sheetPlan, sheetDirName, sheetFileName, type Size, type SheetConfig } from './layout.ts';

export { sheetPlan, sheetPosition, sheetDirName, sheetFileName } from './layout.ts';
export type { SheetConfig, SheetPlan, SheetPosition } from './layout.ts';

const HASHES_FILE = 'hashes.json';

/**
 * Resize one level's rooms straight from their sources into fixed-grid sheets
 * under `<levelDir>-sheets/`. `levelDir` only names the sheets; no per-file
 * tile is written for a sheet-packed level.
 *
 * `files` must be in the order `mips.ts`'s `sourceImages` returns, which is the
 * order room ids are assigned in: sheet addressing is positional, so a
 * reordering here silently mislabels every sheet after the change.
 *
 * @param opts.sourceDir     directory holding `files`, the level-0 sources
 * @param opts.sourceHashes  `contentHash` of each file, aligned with `files`;
 *                           hashed here when omitted
 */
export async function writeSheets({
  sourceDir,
  levelDir,
  files,
  sourceHashes,
  tileSize,
  quality = 82,
  plan,
}: {
  sourceDir: string;
  levelDir: string;
  files: string[];
  sourceHashes?: string[];
  tileSize: Size;
  quality?: number;
  plan?: SheetConfig;
}): Promise<{ sheetCount: number; written: number; cached: number }> {
  const layout = sheetPlan(files.length, plan ?? SHEETS);
  const outDir = sheetDirName(levelDir);
  await mkdir(outDir, { recursive: true });

  const hashesPath = join(outDir, HASHES_FILE);
  let previousHashes: Record<string, string> = {};
  try {
    previousHashes = JSON.parse(await readFile(hashesPath, 'utf8'));
  } catch {
    // no sidecar yet, or unreadable - rebuild every sheet
  }

  const hashes = sourceHashes ?? (await Promise.all(files.map((f) => contentHash(join(sourceDir, f)))));
  // The encoding settings are part of the key, so a new tile size or quality
  // rebuilds every sheet even though no source changed.
  const settings = `${tileSize.w}x${tileSize.h}:q${quality}:`;

  let written = 0;
  let cached = 0;
  const nextHashes: Record<string, string> = {};

  for (let sheetIndex = 0; sheetIndex < layout.sheetCount; sheetIndex++) {
    const start = sheetIndex * layout.roomsPerSheet;
    const members = files.slice(start, start + layout.roomsPerSheet);
    const memberHashes = hashes.slice(start, start + layout.roomsPerSheet);
    const combined = createHash('sha256')
      .update(settings + memberHashes.join(''))
      .digest('hex');
    nextHashes[sheetIndex] = combined;

    if (previousHashes[String(sheetIndex)] === combined) {
      cached++;
      continue;
    }

    // Resized to raw pixels, so the sheet's JPEG encode is the only lossy step.
    // `lanczos3` matches `writeMips`, for the moire reason stated there.
    // Row-major, the same order `sheetPosition` reports, so a client asking for
    // room i lands on the cell this pasted it into.
    const composite = await Promise.all(
      members.map(async (file, i) => ({
        input: await sharp(join(sourceDir, file))
          .resize(tileSize.w, tileSize.h, { kernel: 'lanczos3' })
          .removeAlpha()
          .toColourspace('srgb')
          .raw()
          .toBuffer(),
        raw: { width: tileSize.w, height: tileSize.h, channels: 3 as const },
        left: (i % layout.cols) * tileSize.w,
        top: Math.floor(i / layout.cols) * tileSize.h,
      }))
    );

    // A part-filled final sheet keeps the whole grid, black where it has no
    // room: every sheet of a level is one size, as `sheetPosition` assumes.
    await sharp({
      create: {
        width: layout.cols * tileSize.w,
        height: layout.rows * tileSize.h,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite(composite)
      .jpeg({ quality, mozjpeg: true })
      .toFile(join(outDir, sheetFileName(sheetIndex)));
    written++;
  }

  await writeFile(hashesPath, JSON.stringify(nextHashes, null, 2) + '\n');
  return { sheetCount: layout.sheetCount, written, cached };
}
