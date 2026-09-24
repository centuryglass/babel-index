/**
 * The corpus manifest's shape: what `scan.ts`'s `scanDirectory()` (or
 * `remote.ts`, rewriting a remote scan's urls) produces, what `/api/manifest`
 * serves with `config` and `favorites` added, and what every consumer in
 * `packages/web` and `packages/map` reads.
 *
 * Types only: every consumer reaches it through `import type`, so it has no
 * runtime presence in the client bundle or under Node.
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
 * The shared tiles served from `--shared-dir`, and the pyramid rungs each set
 * has on disk. Read by `rooms.ts` (url resolution), `main.tsx` (warming),
 * and the favorite badge's drawing (`favoriteBadge.ts`, `render.ts`). The rest
 * of the fixed app art (the distill toggle, the "forget searches" overlay) is
 * in none of these and stays flat at level 0 (see `rooms.ts`'s header).
 */
export interface SharedAssets {
  /** The blank center render, or null when none is deployed. */
  center: SharedAsset | null;
  /** The generic alternates. */
  generic: SharedAsset[];
  /**
   * Distill mode's paired alternates: `genericDistill[i]` is `generic[i]`'s
   * replacement art when distill mode fades it in, matched by filename stem
   * in `scan.ts`'s `scanShared`. Null where a generic tile has no alternate
   * on disk; the fade then uses a flat black overlay for that tile.
   */
  genericDistill: (SharedAsset | null)[];
  /**
   * The per-file rungs the center and every generic tile share on disk: the
   * intersection of what `discoverLevels` finds under the shared directory's
   * root (the center) and its `generic/` subdirectory. Always at least
   * `[{level: 0, dir: null}]`.
   */
  levels: LevelInfo[];
  /**
   * The same discovery rooted at `generic_distill/`, not intersected with
   * `levels`. Not every generic tile has a distill alternate, so the base
   * tree's rungs must not veto a level the distill tree has.
   */
  distillLevels: LevelInfo[];
  /**
   * The favorite badge's pyramid: `fav_on.png`/`fav_off.png` scaled to the
   * tile's per-level widths (`scan.ts`'s `discoverFavoriteLevels`). A level
   * counts only when both badge faces are present. The scaled files share the
   * center tile's `<width>/` directories, but the discovery is independent of
   * `levels`.
   */
  favoriteLevels: LevelInfo[];
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
  /** The int8 half-range the blob's rows were quantised at (see `embeddingScores`
   * in `packages/map/ordering.ts`) - read from `embeddings.json`'s own `scale`
   * rather than assumed, so the client can never drift from what wrote the blob. */
  scale: number;
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
 * (docs/agents/favorites.md, "No store, no feature").
 */
export interface ManifestResponse extends Manifest {
  favorites: FavoritesInfo | null;
  config: Record<string, unknown>;
}
