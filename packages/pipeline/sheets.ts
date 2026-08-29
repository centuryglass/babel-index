/**
 * Packing coarse pyramid levels into fixed-grid tilesheets.
 *
 * Levels 2-4 (`SHEETS.fromLevel` in packages/web/src/lib/pyramid.ts) are the
 * ones a zoomed-out scroll session requests the most of at once - packing
 * many rooms into one grid image cuts the request count Cloudflare's WAF and
 * R2's Class B billing see, without changing what gets served or moving any
 * compositing onto the origin server (see infra/README.md). Levels 0/1 stay
 * one file per room; see SHEETS's own docblock for why.
 *
 * The addressing arithmetic (`sheetPlan`, `sheetPosition`, `sheetDirName`,
 * `sheetFileName`) lives in `layout.ts`, not here, so `packages/server/scan.ts`
 * can discover and validate what this file writes without depending on
 * `sharp` - same split as `mipPlan`/`mips.ts`. This module only adds the
 * actual compositing.
 *
 * Incremental rebuilds: a sheet has no single source file to stamp with an
 * EXIF hash the way a per-file mip level does (mips.ts), so each sheet
 * directory instead carries a small `hashes.json` sidecar mapping sheet index
 * -> a combined hash of its member tiles' own content hashes, in order. A
 * rebuild only recomposites a sheet whose combined hash changed - bounded to
 * O(sheet size) per touched room rather than O(corpus size), though still
 * O(sheet size) rather than O(1). See tools/upload/lib.ts's diffing note for
 * the re-upload cost this implies once a sheet is synced to R2.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { SHEETS } from '../web/src/lib/pyramid.ts';
import { contentHash } from './mips.ts';
import { sheetPlan, sheetFileName, type Size, type SheetConfig } from './layout.ts';

export { sheetPlan, sheetPosition, sheetDirName, sheetFileName } from './layout.ts';
export type { SheetConfig, SheetPlan, SheetPosition } from './layout.ts';

const SHEETS_SUFFIX = '-sheets';
const HASHES_FILE = 'hashes.json';

/**
 * Composite one level's already-written per-file tiles into fixed-grid
 * sheets under `<levelDir>-sheets/`.
 *
 * `files` must be in the same order as the room ids the manifest assigns
 * (`packages/pipeline/mips.ts`'s `sourceImages()` order) - sheet addressing
 * is positional, so a reordering here silently mislabels every sheet after
 * the change.
 */
export async function writeSheets({
  levelDir,
  files,
  tileSize,
  quality = 82,
  plan,
}: {
  levelDir: string;
  files: string[];
  tileSize: Size;
  quality?: number;
  plan?: SheetConfig;
}): Promise<{ sheetCount: number; written: number; cached: number }> {
  const layout = sheetPlan(files.length, plan ?? SHEETS);
  const outDir = levelDir + SHEETS_SUFFIX;
  await mkdir(outDir, { recursive: true });

  const hashesPath = join(outDir, HASHES_FILE);
  let previousHashes: Record<string, string> = {};
  try {
    previousHashes = JSON.parse(await readFile(hashesPath, 'utf8'));
  } catch {
    // no sidecar yet, or unreadable - rebuild every sheet
  }

  const tileHashes = await Promise.all(files.map((f) => contentHash(join(levelDir, f))));

  let written = 0;
  let cached = 0;
  const nextHashes: Record<string, string> = {};

  for (let sheetIndex = 0; sheetIndex < layout.sheetCount; sheetIndex++) {
    const start = sheetIndex * layout.roomsPerSheet;
    const members = files.slice(start, start + layout.roomsPerSheet);
    const memberHashes = tileHashes.slice(start, start + layout.roomsPerSheet);
    const combined = createHash('sha256').update(memberHashes.join('')).digest('hex');
    nextHashes[sheetIndex] = combined;

    if (previousHashes[String(sheetIndex)] === combined) {
      cached++;
      continue;
    }

    const composite = members.map((file, i) => ({
      input: join(levelDir, file),
      left: (i % layout.cols) * tileSize.w,
      top: Math.floor(i / layout.cols) * tileSize.h,
    }));

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
