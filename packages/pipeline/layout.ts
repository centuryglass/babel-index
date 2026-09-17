/**
 * Where the pyramid's levels live on disk, and the arithmetic that places a
 * room within them. No filesystem and no imaging: this has two consumers with
 * very different dependency budgets - the pipeline, which writes the levels and
 * needs `sharp`, and the demo server, which discovers them and must not. The
 * only import is the ladder itself.
 *
 * The convention, stated once:
 *
 *   <dir>/000.jpg          level 0 - the source art, left flat where it is
 *   <dir>/512/000.jpg      level 1
 *   <dir>/256/000.jpg      level 2      ... directory named for the WIDTH
 *   <dir>/128-sheets/sheet-0000.jpg   packed from `SHEETS.fromLevel` up
 *
 * Width names the directory because width is the axis the client's ladder is
 * expressed in and a corpus shares one aspect, so it identifies the level
 * unambiguously. Level 0 stays flat so a corpus that has never been through the
 * pipeline still reads as a valid level 0, and running in place costs no
 * duplicated bytes.
 */
import { LEVELS, SHEETS } from '../web/src/lib/pyramid.ts';

export interface Size {
  w: number;
  h: number;
}

export interface LevelStep {
  level: number;
  divisor: number;
}

export interface MipStep extends Size {
  level: number;
  dir: string | null;
}

export interface SheetConfig {
  roomsPerSheet: number;
  cols: number;
  rows: number;
}

export interface SheetPlan extends SheetConfig {
  sheetCount: number;
}

export interface SheetPosition {
  sheetIndex: number;
  col: number;
  row: number;
}

// --- levels ------------------------------------------------------------------

/**
 * What levels a source image of these dimensions should produce, finest first.
 *
 * Sizes come from the source, not from `BASE_TILE`: a corpus rendered at any
 * size gets the levels it can hold. Each level is the source divided by the
 * ladder's divisor on both axes together, which keeps the aspect exact.
 *
 * A source too small for the whole ladder yields fewer levels, never duplicate
 * ones: two divisors that round to the same width name the same directory, and
 * the second write lands the wrong size in it silently.
 */
export function mipPlan({ w, h }: Size, levels: LevelStep[] = LEVELS): MipStep[] {
  const plan: MipStep[] = [];
  const seen = new Set<number>();
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

// --- sheets ------------------------------------------------------------------
//
// Where a room sits once its level is sheet-packed: the addressing
// `sheets.ts` composites with and the server validates against, read the same
// way from both sides.

/** The sheet directory that sits beside a level's per-file `<width>/` directory. */
export function sheetDirName(width: number | string): string {
  return `${width}-sheets`;
}

/** The file name for one sheet, zero-padded so a directory listing sorts in order. */
export function sheetFileName(sheetIndex: number, ext = 'jpg'): string {
  return `sheet-${String(sheetIndex).padStart(4, '0')}.${ext}`;
}

/**
 * How many sheets a corpus of this size needs, and the grid each one holds.
 * Throws on a `cols` x `rows` that does not hold `roomsPerSheet`.
 */
export function sheetPlan(roomCount: number, config: SheetConfig = SHEETS): SheetPlan {
  if (config.cols * config.rows !== config.roomsPerSheet)
    throw new Error(`sheet grid ${config.cols}x${config.rows} does not hold roomsPerSheet=${config.roomsPerSheet}`);
  const sheetCount = roomCount === 0 ? 0 : Math.ceil(roomCount / config.roomsPerSheet);
  return { ...config, sheetCount };
}

/** Where room `roomIndex` (0-based, in the same order as room ids) lives within its sheet. */
export function sheetPosition(roomIndex: number, plan: SheetConfig = SHEETS): SheetPosition {
  const { roomsPerSheet, cols } = plan;
  const sheetIndex = Math.floor(roomIndex / roomsPerSheet);
  const posInSheet = roomIndex % roomsPerSheet;
  return { sheetIndex, col: posInSheet % cols, row: Math.floor(posInSheet / cols) };
}
