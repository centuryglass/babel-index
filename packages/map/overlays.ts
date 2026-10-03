/**
 * The corner overlays as data: art pinned to a tile corner, described in
 * `<shared-dir>/overlays.json` (`OVERLAYS_FILE`), not in code.
 *
 * An overlay's descriptor names its art (one file per face), the tile corner
 * the art's matching corner is pinned to, and its scale basis. Everything
 * else is behavior and stays in code: which tiles carry an overlay and when,
 * which face shows, and what a tap does (`favoriteBadge.ts`,
 * `distillToggle.ts`, the planners in `framePlan.ts`). Placement is one rule
 * for every overlay, `packages/web/src/lib/overlay.ts`'s `overlayScreenRect`.
 *
 * `scan.ts` parses the file at startup, rejecting a malformed one, and serves
 * the result with each overlay's discovered pyramid levels as
 * `manifest.overlays`.
 */
import type { LevelInfo } from './manifest.ts';

/** The descriptor file's name inside `--shared-dir`. */
export const OVERLAYS_FILE = 'overlays.json';

/** The tile corner an overlay's art is pinned to, art corner on tile corner. */
export type OverlayAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const ANCHORS: readonly OverlayAnchor[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * How an overlay's art scales with the tile under it:
 * - `tile`: one file per face, authored against the full-size tile and drawn
 *   from level 0 at every zoom.
 * - `pyramid`: each face also has per-level copies under `<width>/`, the
 *   layout a room's pyramid uses, and draws only at the exact level the tile
 *   draws at. The copies are hand-tuned, so a substitute rung would only be
 *   blurrier, and a level with no copy draws nothing.
 */
export type OverlayScale = 'tile' | 'pyramid';

const SCALES: readonly OverlayScale[] = ['tile', 'pyramid'];

/** One overlay as `overlays.json` declares it. */
export interface OverlayDescriptor {
  anchor: OverlayAnchor;
  scale: OverlayScale;
  /** Face name to art filename, a plain name directly inside `--shared-dir`. */
  faces: Record<string, string>;
}

/**
 * One overlay as the manifest serves it. `levels` is the pyramid rungs
 * every face has on disk; always `[level 0]` for a `tile` overlay.
 */
export interface Overlay extends OverlayDescriptor {
  levels: LevelInfo[];
}

/** Every overlay by id, as `manifest.overlays` carries it. */
export type Overlays = Record<string, Overlay>;

/** Overlay ids and face names: lowercase words joined by hyphens. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A filename with no directory part, which the upload tool and `rooms.ts` both assume. */
const PLAIN_FILE = /^[^/\\]+$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate `overlays.json`'s parsed contents. Throws an `Error` naming the
 * first problem, so a bad file stops the server at startup rather than
 * drawing nothing.
 */
export function parseOverlays(raw: unknown): Record<string, OverlayDescriptor> {
  if (!isObject(raw)) throw new Error(`${OVERLAYS_FILE}: expected an object of overlays by id`);
  const out: Record<string, OverlayDescriptor> = {};
  for (const [id, entry] of Object.entries(raw)) {
    const where = `${OVERLAYS_FILE}: overlay "${id}"`;
    if (!NAME.test(id)) throw new Error(`${where}: id must be lowercase words joined by hyphens`);
    if (!isObject(entry)) throw new Error(`${where}: expected an object`);
    const { anchor, scale, faces } = entry;
    if (!ANCHORS.includes(anchor as OverlayAnchor))
      throw new Error(`${where}: anchor must be one of ${ANCHORS.join(', ')}`);
    if (!SCALES.includes(scale as OverlayScale)) throw new Error(`${where}: scale must be one of ${SCALES.join(', ')}`);
    if (!isObject(faces) || !Object.keys(faces).length) throw new Error(`${where}: faces must name at least one face`);
    const faceFiles: Record<string, string> = {};
    for (const [face, file] of Object.entries(faces)) {
      if (!NAME.test(face)) throw new Error(`${where}: face "${face}" must be lowercase words joined by hyphens`);
      if (typeof file !== 'string' || !PLAIN_FILE.test(file) || file === '.' || file === '..')
        throw new Error(`${where}: face "${face}" must be a plain filename`);
      faceFiles[face] = file;
    }
    out[id] = { anchor: anchor as OverlayAnchor, scale: scale as OverlayScale, faces: faceFiles };
  }
  return out;
}

/**
 * The tile-cache id for one face of one overlay. A string, so it never
 * collides with a room's numeric id; `rooms.ts` resolves it to the face's url.
 */
export function overlayFaceId(overlay: string, face: string): string {
  return `overlay:${overlay}:${face}`;
}
