/**
 * Writing pyramid levels for the shared tiles - `npm run generate:mips --
 * --images <dir> --shared-dir <dir>` calls this after the corpus itself.
 *
 * Same ladder, same per-file `<width>/<file>` layout `mips.ts` writes for a
 * room (`writeMips`), just rooted at the shared directory instead: once for
 * the center render found there, and once per file in its `generic/`
 * subdirectory. `scan.ts`'s `discoverLevels` is what turns this back into
 * `manifest.shared.levels` at scan time - see its own comment.
 *
 * Only these two get a pyramid. `generic_distill/`'s alternates are only
 * ever drawn up close (`render.ts`'s `drawGenericFade` always asks the cache
 * for level 0), and the favorite badges, the distill toggle and the rest of
 * the fixed app art are tiny icons drawn at a fixed size regardless of zoom
 * (same file, always `cache.get(id, 0)`) - a pyramid for either would be
 * dead weight nothing ever asks for.
 */
import { join, extname } from 'node:path';
import { readdir } from 'node:fs/promises';
import { writeMips, type WriteMipsResult } from './mips.ts';
import { GENERIC_DIR, resolveCenterFile } from '../server/scan.ts';

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

  return { center: centerResult, generic };
}
