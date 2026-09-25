/**
 * Writes pyramid levels for the shared tiles. `npm run generate:mips --
 * --images <dir> --shared-dir <dir>` calls this after the corpus itself.
 *
 * Each file gets the same per-file `<width>/<file>` ladder `mips.ts`'s
 * `writeMips` writes for a room, rooted at the shared directory:
 *   - the center render found there;
 *   - every image in its `generic/` subdirectory;
 *   - every image in its `generic_distill/` subdirectory.
 *
 * `scan.ts`'s `discoverLevels` reads these back into the manifest; see
 * `docs/agents/map.md`, "Shared art has its own pyramids". The favorite
 * badge's pyramid is hand-tuned and committed, not generated here.
 */
import { join, extname } from 'node:path';
import { readdir } from 'node:fs/promises';
import { writeMips, type WriteMipsResult } from './mips.ts';
import { GENERIC_DIR, GENERIC_DISTILL_DIR, resolveCenterFile } from '../server/scan.ts';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Image filenames directly inside a directory, sorted; empty if the directory is missing. */
async function listImages(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).sort();
  } catch {
    return [];
  }
}

export interface SharedMipsResult {
  /** null when no center file was found - nothing to pyramid. */
  center: ({ file: string } & WriteMipsResult) | null;
  generic: ({ file: string } & WriteMipsResult)[];
  genericDistill: ({ file: string } & WriteMipsResult)[];
}

/**
 * @param opts.sharedDir the shared directory (`--shared-dir`)
 * @param opts.center names the center tile, same as `scan.ts`'s `--center`
 * @param opts.quality JPEG/WebP quality for the generated levels
 */
export async function writeSharedMips({
  sharedDir,
  center,
  quality = 82,
}: {
  sharedDir: string;
  center?: string;
  quality?: number;
}): Promise<SharedMipsResult> {
  const files = await listImages(sharedDir);
  const centerFile = resolveCenterFile(files, center);
  const centerResult = centerFile
    ? { file: centerFile, ...(await writeMips({ file: join(sharedDir, centerFile), outDir: sharedDir, inPlace: true, quality })) }
    : null;

  const genericDir = join(sharedDir, GENERIC_DIR);
  const genericFiles = await listImages(genericDir);
  const generic = await Promise.all(
    genericFiles.map(async (file) => ({
      file,
      ...(await writeMips({ file: join(genericDir, file), outDir: genericDir, inPlace: true, quality })),
    }))
  );

  const distillDir = join(sharedDir, GENERIC_DISTILL_DIR);
  const distillFiles = await listImages(distillDir);
  const genericDistill = await Promise.all(
    distillFiles.map(async (file) => ({
      file,
      ...(await writeMips({ file: join(distillDir, file), outDir: distillDir, inPlace: true, quality })),
    }))
  );

  return { center: centerResult, generic, genericDistill };
}
