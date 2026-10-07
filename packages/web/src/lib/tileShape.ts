/**
 * A collection's tile shape: the level-0 tile size the manifest states
 * (`manifest.tile`), and everything the map derives from it.
 *
 * The tile is collection data, so nothing in the client states a tile size or
 * aspect of its own. `main.tsx` builds one `TileShape` from the manifest and
 * passes its parts down: the aspect rides on every camera, the pyramid goes
 * to the tile cache and the planners, and the hard zoom limits bound the
 * camera (the server resolves the configured range against the same limits).
 */
import { cellAspectOf, zoomLimitsFor, type ZoomLimits } from './camera.ts';
import { createPyramid, type Pyramid, type Size } from './pyramid.ts';

export interface TileShape {
  /** Level-0 pixel size of every tile in the collection. */
  base: Size;
  /** Cell height over cell width; `camera.ts`'s `pxPerCell` applies it. */
  aspect: number;
  pyramid: Pyramid;
  /** The hard zoom range; config may narrow it, never widen it. */
  zoomLimits: ZoomLimits;
}

/** Every derived part of a collection's tile shape, from its level-0 size. */
export function tileShapeFor(base: Size): TileShape {
  return {
    base,
    aspect: cellAspectOf(base),
    pyramid: createPyramid({ base }),
    zoomLimits: zoomLimitsFor(base),
  };
}
