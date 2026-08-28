/**
 * The corpus manifest's shape: what `scan.mjs` (or `remote.mjs`, rewriting a
 * remote scan's urls) produces, `/api/manifest` serves verbatim plus a
 * `config` field, and every consumer in `packages/web` and `packages/map`
 * reads.
 *
 * Type-only, imported through JSDoc (`@type {import('./manifest.ts').Manifest}`)
 * rather than `.js`/`.mjs`/`.jsx` importing it at runtime - this is the first
 * `.ts` file in the repo (see AGENTS.md), and it stays a pure type contract so
 * it never needs to go through esbuild's client bundle or Node's loader. `tsc
 * --noEmit` (npm run typecheck) is what actually checks it against every
 * `@type`/`@param` that names it.
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

/** The shared tiles: the blank center (if any) and the generic alternates. */
export interface SharedAssets {
  center: SharedAsset | null;
  generic: SharedAsset[];
}

/**
 * A sheet-packed level's grid geometry: `roomsPerSheet` rooms live in each
 * `<dir>/sheet-NNNN.<ext>`, addressed by a formula from room order
 * (`packages/pipeline/sheets.ts`'s `sheetPosition()`), not a per-room lookup
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
 * The keyword/story sidecar's coverage, if `METADATA_FILE` was found. `matched`
 * far below `entries` means the sidecar describes files this corpus does not
 * have - see `packages/map/metadata.js`.
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

/** A corpus manifest, as `scanDirectory()`/`fetchRemoteManifest()` produce it. */
export interface Manifest {
  mode: 'offline' | 'remote';
  /** The scanned local directory; absent from a remote manifest (see remote.mjs). */
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

/** The manifest as served by `/api/manifest`: the scan plus the client config. */
export interface ManifestResponse extends Manifest {
  config: Record<string, unknown>;
}
