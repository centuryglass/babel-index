/**
 * Pack the center-tile loading-animation frames into sprite sheets.
 *
 * The rearrangement preload (packages/web/src/hooks/useRearrangement.ts) can
 * take up to a couple of seconds; while it runs, a short frame cycle plays over
 * the illustrated page of the center room's artist-statement book so the map
 * does not feel frozen. The raw frames are authored one PNG per frame, each the
 * full size of the center tile with everything but the animated page left
 * transparent. Shipping ~16 full-tile PNGs per cycle would be wasteful, so this
 * tool crops every cycle to the one rectangle its content occupies and lays the
 * cropped frames into a single grid sheet.
 *
 * Input layout (default `assets/animation/`):
 *
 *   assets/animation/center_0/0.png .. 15.png    one cycle, numbered frames
 *   assets/animation/center_1/...                another cycle
 *
 * A cycle is any immediate subdirectory holding numbered PNG frames; the tool
 * discovers them, so adding a new cycle is dropping in a new folder and
 * re-running - no code change. Frames are ordered by their numeric filename,
 * not lexically, so `10.png` follows `9.png`.
 *
 * Output (written under the same root, served via `/shared/animation/`):
 *
 *   assets/animation/sheets/center_0.png         packed grid of cropped frames
 *   assets/animation/manifest.json               per-cycle crop rect + grid shape
 *
 * The crop rectangle is stored in cell fractions (see lib.ts) so the client can
 * place it on the stretched center cell without re-measuring. The union of
 * every frame's content bounds is used for the whole cycle, so a frame whose
 * drawing shifts stays registered against one origin rather than jittering.
 *
 * Run: `npm run generate:animation` (optionally `-- --dir <root>`).
 */
import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import sharp from 'sharp';
import {
  unionBounds,
  boundsSize,
  boundsToRect,
  packLayout,
  frameCellAt,
  type Bounds,
  type Size,
  type AnimationCycle,
  type AnimationManifest,
} from './lib.ts';

type Args = Record<string, string | undefined>;

function parseArgs(args: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const eq = args[i].indexOf('=');
    if (eq > -1) out[args[i].slice(2, eq)] = args[i].slice(eq + 1);
    else out[args[i].slice(2)] = args[++i];
  }
  return out;
}

const FRAME_PATTERN = /^(\d+)\.png$/i;

/** A cycle's frame files, numerically ordered, or [] if the dir holds none. */
async function frameFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((e) => FRAME_PATTERN.test(e))
    .sort((a, b) => Number(a.match(FRAME_PATTERN)![1]) - Number(b.match(FRAME_PATTERN)![1]));
}

/**
 * The tight content bounds of one frame: the smallest half-open box covering
 * every pixel whose alpha clears `threshold`. Null when the frame is fully
 * transparent. Scans the raw RGBA buffer rather than trusting sharp's `trim`,
 * so the same threshold governs every frame and a faint antialiased fringe does
 * not quietly widen one frame's box past the others'.
 */
async function contentBounds(file: string, threshold: number): Promise<{ bounds: Bounds | null; size: Size }> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  let found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * channels + (channels - 1)];
      if (alpha <= threshold) continue;
      found = true;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x >= x1) x1 = x + 1;
      if (y >= y1) y1 = y + 1;
    }
  }
  return { bounds: found ? { x0, y0, x1, y1 } : null, size: { w: width, h: height } };
}

/** Discover the cycle subdirectories under `root`, excluding the output dir. */
async function discoverCycles(root: string, outName: string): Promise<string[]> {
  const entries = await readdir(root);
  const cycles: string[] = [];
  for (const entry of entries) {
    if (entry === outName) continue;
    const full = join(root, entry);
    if (!(await stat(full)).isDirectory()) continue;
    if ((await frameFiles(full)).length) cycles.push(entry);
  }
  return cycles.sort();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = args.dir ?? 'assets/animation';
  const outName = args.out ?? 'sheets';
  const outDir = join(root, outName);
  const manifestPath = args.manifest ?? join(root, 'manifest.json');
  const frameDurationMs = Number(args['frame-duration'] ?? 100);
  const columns = args.columns ? Number(args.columns) : undefined;
  // Any non-zero alpha counts as content by default; the frames are authored
  // with a hard transparent background, so there is nothing to threshold away.
  const threshold = Number(args['alpha-threshold'] ?? 0);

  const cycleNames = await discoverCycles(root, outName);
  if (!cycleNames.length) {
    console.error(`No animation cycles found under ${root}`);
    process.exitCode = 1;
    return;
  }

  await mkdir(outDir, { recursive: true });
  const cycles: AnimationCycle[] = [];
  let tile: Size | null = null;

  for (const name of cycleNames) {
    const dir = join(root, name);
    const files = await frameFiles(dir);

    const perFrame = await Promise.all(files.map((f) => contentBounds(join(dir, f), threshold)));

    // Every frame in a cycle must share one tile size, and every cycle must
    // agree with the first - the crop fractions are meaningless otherwise, and
    // the client draws all cycles against the one center cell.
    for (let i = 0; i < files.length; i++) {
      const size = perFrame[i].size;
      tile ??= size;
      if (size.w !== tile.w || size.h !== tile.h) {
        throw new Error(
          `${name}/${files[i]} is ${size.w}x${size.h}, expected ${tile.w}x${tile.h} to match the tile`
        );
      }
    }

    const bounds = unionBounds(perFrame.map((p) => p.bounds));
    if (!bounds) {
      console.warn(`  ${name}: every frame is fully transparent, skipping`);
      continue;
    }

    const frame = boundsSize(bounds);
    const layout = packLayout(files.length, frame, columns);
    // Extract each frame's crop as its own buffer, then composite them onto one
    // transparent sheet at their grid cells.
    const composites = await Promise.all(
      files.map(async (f, i) => {
        const cell = frameCellAt(i, layout);
        const input = await sharp(join(dir, f))
          .ensureAlpha()
          .extract({ left: bounds.x0, top: bounds.y0, width: frame.w, height: frame.h })
          .png()
          .toBuffer();
        return { input, left: cell.left, top: cell.top };
      })
    );

    const sheetFile = `${name}.png`;
    await sharp({
      create: {
        width: layout.sheet.w,
        height: layout.sheet.h,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(composites)
      .png()
      .toFile(join(outDir, sheetFile));

    cycles.push({
      name,
      sheet: `${outName}/${sheetFile}`,
      frames: files.length,
      columns: layout.columns,
      rows: layout.rows,
      frameWidth: frame.w,
      frameHeight: frame.h,
      rect: boundsToRect(bounds, tile!),
    });
    console.log(
      `  ${name}: ${files.length} frames, crop ${frame.w}x${frame.h} at (${bounds.x0},${bounds.y0})` +
        ` -> ${sheetFile} ${layout.sheet.w}x${layout.sheet.h}`
    );
  }

  const manifest: AnimationManifest = { frameDurationMs, tile: tile!, cycles };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${cycles.length} cycle(s) to ${outDir} and ${basename(manifestPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
