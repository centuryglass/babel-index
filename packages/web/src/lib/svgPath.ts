/**
 * Pure helpers for the canonical absolute M/L/C/Z path grammar
 * `tools/center-placement/import-shelf-svg.ts` emits (see that file's
 * `normalizePath`/`ellipseToPath`) - flattening one into a polygon for a
 * hit-test, and testing a point against the result.
 *
 * Split out of `center.ts` once `favoriteBadge.ts` needed the same walk for
 * the on-tile favorite badge's traced silhouette (`tile_fav_toggle`): two
 * copies of a Bezier flattener is exactly the drift this file exists to
 * avoid. No DOM.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * Flatten an SVG path in the canonical absolute M/L/C/Z grammar into a
 * polygon of `{x, y}` points.
 *
 * Cubic segments are sampled rather than solved exactly: a hover/hit test has
 * no need for a mathematically exact curve, only one fine enough that the
 * boundary looks right at screen resolution, and a fixed sample count keeps
 * this pure and assertable without a browser (no `Path2D`/`isPointInFill`,
 * which need a live canvas). Only M/L/C/Z ever appear - the same restriction
 * the importer itself enforces on import, so a path that reaches this
 * function is already known to be one of these four commands.
 */
export function flattenPath(d: string, samples = 12): Point[] {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  const points: Point[] = [];
  let cx = 0;
  let cy = 0;
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'Z') continue;
    if (cmd === 'M' || cmd === 'L') {
      cx = Number(tokens[i++]);
      cy = Number(tokens[i++]);
      points.push({ x: cx, y: cy });
    } else if (cmd === 'C') {
      const x1 = Number(tokens[i++]);
      const y1 = Number(tokens[i++]);
      const x2 = Number(tokens[i++]);
      const y2 = Number(tokens[i++]);
      const ex = Number(tokens[i++]);
      const ey = Number(tokens[i++]);
      for (let s = 1; s <= samples; s++) {
        const t = s / samples;
        const mt = 1 - t;
        points.push({
          x: mt * mt * mt * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * ex,
          y: mt * mt * mt * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * ey,
        });
      }
      cx = ex;
      cy = ey;
    }
  }
  return points;
}

/** Even-odd ray-casting point-in-polygon test, pure and browser-free. */
export function pointInPolygon(px: number, py: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Command sequence for the same grammar, one step short of a polygon - what a canvas path draw needs instead of a hit-test. */
export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' };

/**
 * Parse the same canonical grammar into a structured command list, for a
 * caller that wants to replay the true curve (a canvas `bezierCurveTo`) rather
 * than a flattened polygon.
 */
export function parsePath(d: string): PathCommand[] {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  const commands: PathCommand[] = [];
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'Z') {
      commands.push({ type: 'Z' });
    } else if (cmd === 'M' || cmd === 'L') {
      commands.push({ type: cmd, x: Number(tokens[i++]), y: Number(tokens[i++]) });
    } else if (cmd === 'C') {
      commands.push({
        type: 'C',
        x1: Number(tokens[i++]), y1: Number(tokens[i++]),
        x2: Number(tokens[i++]), y2: Number(tokens[i++]),
        x: Number(tokens[i++]), y: Number(tokens[i++]),
      });
    }
  }
  return commands;
}
