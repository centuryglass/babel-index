/**
 * The corpus manifest's shape: what `scan.ts`'s `scanDirectory()` (or
 * `remote.ts`, rewriting a remote scan's urls) produces, what `/api/manifest`
 * serves with `config` and `favorites` added, and what every consumer in
 * `packages/web` and `packages/map` reads.
 *
 * A pure type contract, the shape AGENTS.md's "A pure type contract" bullet
 * names this file as: exported interfaces only, imported through JSDoc
 * (`@type {import('./manifest.ts').Manifest}`) and never by `.js`/`.mjs`/
 * `.jsx` at runtime, so it never needs esbuild's client bundle or Node's
 * loader. `tsc --noEmit` (`npm run typecheck`) is what checks it against
 * every `@type`/`@param` that names it.
 */

export interface ImageSize {
  w: number;
  h: number;
}

/** One room: a corpus image, its url, and its size if it could be read. */
export interface Room extends Partial<ImageSize> {
  id: number;
  file: string;
  url: string;
  bytes: number;
}

/** One shared tile (the center render, or one generic): its url and size. */
export interface SharedAsset extends Partial<ImageSize> {
  file: string;
  url: string;
}

/**
 * The shared tiles: the blank center (if any), the generic alternates, and
 * distill mode's paired alternates for them - `genericDistill[i]` is
 * `generic[i]`'s replacement art when distill mode fades it in, matched by
 * filename stem in `scan.ts`'s `scanShared`. Null at an index whose generic
 * tile has no matching distill alternate on disk; the fade falls back to a
 * flat black overlay for that one rather than failing the whole corpus.
 *
 * `levels` is which per-file pyramid rungs the center and every generic tile
 * actually share on disk - the intersection of what `discoverLevels` finds
 * under the shared directory's root (the center) and its `generic/`
 * subdirectory, so a level only appears here when both trees have it. Always
 * at least `[{level: 0, dir: null}]`. `rooms.ts` is the one place this is
 * read; `genericDistill` and the fixed app art (favorite badges, the distill
 * toggle) are never in it and stay flat at level 0 (see rooms.ts's header).
 */
export interface SharedAssets {
  center: SharedAsset | null;
  generic: SharedAsset[];
  genericDistill: (SharedAsset | null)[];
  levels: LevelInfo[];
}

/**
 * A sheet-packed level's grid geometry: `roomsPerSheet` rooms live in each
 * `<dir>/sheet-NNNN.<ext>`, addressed by a formula from room order
 * (`packages/pipeline/layout.ts`'s `sheetPosition`), not a per-room lookup
 * table - `rooms[].url`/`file` are unchanged and unused for these levels.
 */
export interface SheetLayout {
  tileW: number;
  tileH: number;
  cols: number;
  rows: number;
  roomsPerSheet: number;
  sheetCount: number;
  dir: string;
  ext: string;
}

/**
 * One rung of the resolution pyramid, as actually found on disk. Either
 * `dir` names a per-file directory (one image per room), or `sheet` names a
 * grid of shared sheet images - never both for the same level.
 */
export interface LevelInfo extends Partial<ImageSize> {
  level: number;
  /** Subdirectory holding this level's per-file images; null for the flat level 0 or a sheet-packed level. */
  dir: string | null;
  /** Present only for a sheet-packed level (see SheetLayout). */
  sheet?: SheetLayout;
}

/** The image-embedding blob's metadata, if `tools/embed` has produced one. */
export interface EmbeddingsInfo {
  url: string;
  dim: number;
  count: number;
  model: string | null;
}

/**
 * The keyword/story sidecar's coverage, if `scan.ts` found its
 * `METADATA_FILE`: the matched/entries pair `metadataCoverage()` produces,
 * whose drift diagnostic is explained there (see `packages/map/metadata.ts`).
 */
export interface MetadataInfo {
  url: string;
  matched: number;
  entries: number;
}

/**
 * The keyword -> external-link map, if `TAG_LINKS_FILE` was found in the
 * corpus directory. Unlike `MetadataInfo` there is no per-room coverage to
 * report - it's a flat vocabulary lookup, not something joined to a room.
 */
export interface TagLinksInfo {
  url: string;
  count: number;
}

/** A corpus manifest, as `scanDirectory()`/`scanRemote()` produce it. */
export interface Manifest {
  mode: 'offline' | 'remote';
  /** The scanned local directory; absent from a remote manifest (`scanRemote` drops it). */
  directory?: string;
  /** The remote manifest.json url this was fetched from, in remote mode only. */
  source?: string;
  imagesBase: string;
  sharedBase: string;
  shared: SharedAssets;
  rooms: Room[];
  count: number;
  embeddings: EmbeddingsInfo | null;
  metadata: MetadataInfo | null;
  tagLinks: TagLinksInfo | null;
  levels: LevelInfo[];
}

/** That this deployment records global favorite counts at all. */
export interface FavoritesInfo {
  enabled: boolean;
}

/**
 * The manifest as served by `/api/manifest`: the scan plus the client config
 * and the favorite-store status, both added by `app.ts` on the way out - the
 * corpus has nothing to say about either. A null `favorites` means no store
 * was configured and the routes are not mounted, which the client reads as
 * "render no favorite control" - a different statement from a count of zero
 * (AGENTS.md, "No store, no feature").
 */
export interface ManifestResponse extends Manifest {
  favorites: FavoritesInfo | null;
  config: Record<string, unknown>;
}
