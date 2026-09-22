/**
 * Writing pyramid levels for the shared tiles - `npm run generate:mips --
 * --images <dir> --shared-dir <dir>` calls this after the corpus itself.
 *
 * Same ladder, same per-file `<width>/<file>` layout `mips.ts` writes for a
 * room (`writeMips`), just rooted at the shared directory instead: once for
 * the center render found there, once per file in its `generic/`
 * subdirectory, and once per file in its `generic_distill/` subdirectory -
 * distill mode's crossfade for each generic tile draws at whatever level the
 * base tile draws at (`render.ts`'s `drawGenericFade`), not just up close,
 * so it needs the same ladder the generic tiles get. `scan.ts`'s
 * `discoverLevels` is what turns this back into `manifest.shared.levels`/
 * `manifest.shared.distillLevels` at scan time - see its own comment.
 *
 * Only these three are generated here. The favorite badge has a pyramid
 * too (`manifest.shared.favoriteLevels`, `scan.ts`'s
 * `discoverFavoriteLevels`) but not from this tool - the scaled
 * `fav_on.png`/`fav_off.png` are hand-tuned for visibility at small sizes
 * rather than mechanically resized, and committed directly into the same
 * `<width>/` directories this writes for the center render. The rest of the
 * fixed app art (the distill toggle and everything else) is a tiny icon drawn
 * at a fixed size regardless of zoom (same file, always `cache.get(id, 0)`) -
 * a pyramid for it would be dead weight nothing ever asks for.
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
