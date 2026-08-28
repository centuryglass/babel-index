/**
 * Where the pyramid's levels live on disk.
 *
 * Split out of mips.mjs because it has two consumers with very different
 * dependency budgets: the pipeline, which writes the levels and needs `sharp`,
 * and the demo server, which discovers them and must not. Everything here is
 * arithmetic over the ladder - no filesystem, no imaging, no imports beyond the
 * ladder itself.
 *
 * The convention, stated once:
 *
 *   <dir>/000.jpg          level 0 - the source art, left flat where it is
 *   <dir>/512/000.jpg      level 1
 *   <dir>/256/000.jpg      level 2      ... directory named for the WIDTH
 *
 * Width names the directory because width is the axis the client's ladder is
 * expressed in and a corpus shares one aspect, so it identifies the level
 * unambiguously. Level 0 stays flat so a corpus that has never been through the
 * pipeline still reads as a valid level 0, and running in place costs no
 * duplicated bytes.
 */
import { LEVELS } from '../web/src/lib/pyramid.js';

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

/**
 * What levels a source image of these dimensions should produce.
 *
 * Sizes come from the source rather than from BASE_TILE so this works on
 * whatever the render actually is, and the aspect is preserved exactly - each
 * level is the source divided by the ladder's divisor, both axes together.
 *
 * A source too small to support the whole ladder yields fewer levels rather
 * than duplicate ones: two divisors that round to the same width would name the
 * same directory twice, which is a silent corruption of the ladder.
 *
 * Returns the plan finest first.
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
