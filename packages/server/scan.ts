import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { mipPlan, sheetPlan, sheetDirName, sheetFileName } from '../pipeline/layout.ts';
import { SHEETS } from '../web/src/lib/pyramid.ts';
import { metadataCoverage } from '../map/metadata.ts';
import type { ImageSize, Manifest, Room, SharedAsset, SharedAssets, LevelInfo } from '../map/manifest.ts';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * Where a local scan's urls are rooted - the one place "what does a
 * room/shared/blob url look like" is decided. `remote.ts` rewrites both the
 * manifest's `imagesBase`/`sharedBase` fields and every url built from these
 * constants when serving a collection from R2/Cloudflare instead of disk;
 * `createUrlFor` (packages/web/src/lib/rooms.ts) reads `imagesBase` off the
 * manifest rather than restating the string.
 *
 * Relative, not `/images`/`/shared`: a leading slash opts a url out of
 * `<base href>` resolution entirely, and a subpath deployment needs every
 * browser-resolved url to go through the base (docs/agents/deploy.md,
 * "Deployment and the base path"). Express's own routes are unaffected either
 * way - `app.use('/images', ...)` matches on the path Express receives, which
 * the VPS's prefix-stripping proxy has already reduced to this same shape.
 */
export const IMAGES_BASE = 'images';
export const SHARED_BASE = 'shared';

/** The keyword/story sidecar, written by the generator. See packages/map/metadata.ts. */
export const METADATA_FILE = 'metadata.json';

/**
 * Keyword -> external-link map (e.g. a Wikipedia page for "Cubism"), hand-
 * edited rather than generated. Optional, like the sidecar above - a collection
 * with no file here just shows chips with no "more about this" link.
 */
export const TAG_LINKS_FILE = 'tagLinks.json';

/**
 * The subdirectory of a collection that holds its shared tiles: the center
 * render at its root, plus `GENERIC_DIR` and `GENERIC_DISTILL_DIR`. It sits
 * under `--images`, so its urls are rooted at `IMAGES_BASE` and an upload
 * puts it under the collection's prefix. Fixed app art (the favorite badge,
 * the toggles, the loading animation) stays in `--shared-dir`, served at
 * `SHARED_BASE`.
 */
export const SHARED_TILES_DIR = 'shared';

/**
 * The subdirectory of `SHARED_TILES_DIR` that holds the generic tiles. It is
 * a folder rather than a `generic*` glob so a stray image beside the center
 * render (a mask, a canny map) is never mistaken for a generic tile.
 */
export const GENERIC_DIR = 'generic';

/**
 * The subdirectory holding distill mode's paired alternates for the
 * `GENERIC_DIR` tiles - `docs/file_map.md`'s `assets/tile-collection-sample` entry says
 * what they are for. Matched to generic tiles by filename stem (extension may
 * differ, e.g. `generic1.webp` <-> `generic1.jpg`), never by directory sort
 * order: the two folders need not use the same image format, nor agree on
 * how their files sort.
 */
export const GENERIC_DISTILL_DIR = 'generic_distill';

/**
 * The favorite badge's two faces - fixed app art, not scanned collection content,
 * but `discoverFavoriteLevels` checks for these two exact names to find the
 * badge's pyramid. Mirrors the literal filenames `rooms.ts` resolves the
 * badge's level-0 urls from; kept as a separate copy because the two modules
 * run in different packages and the fact is a name, not behaviour.
 */
const FAV_ON_FILE = 'fav_on.png';
const FAV_OFF_FILE = 'fav_off.png';

/**
 * Read pixel dimensions from a file header, without decoding the image.
 * Returns null for anything unrecognised - the client falls back to the
 * natural size once the image loads, so this is an optimisation, not a
 * requirement.
 */
export async function imageSize(path: string): Promise<ImageSize | null> {
  const buf = await readFile(path);

  // PNG: IHDR is always the first chunk.
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47)
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };

  // JPEG: walk the segment chain to a start-of-frame marker.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // SOF0..SOF15, excluding the DHT/JPG/DAC markers that share the range.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }

  // WebP: VP8/VP8L/VP8X each store the size differently.
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    if (fmt === 'VP8X')
      return {
        w: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
        h: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
      };
  }

  return null;
}

/**
 * Which of the pyramid's levels have actually been generated for this collection.
 *
 * The generator writes `<dir>/<width>/<file>` for every level below the
 * source and leaves level 0 flat, so discovery is: work out what the ladder
 * *would* produce at this source size, then keep the rungs whose directory
 * is there. Level 0 is always present - it is the flat files
 * themselves - which is what keeps "point it at a directory of images" true
 * for a collection that has never been near the pipeline.
 *
 * A level at or above `SHEETS.fromLevel` is checked as sheet-packed first:
 * `<dir>/<width>-sheets/` holding every `sheet-NNNN.jpg` the collection's room
 * count requires (`sheetPlan`, from `packages/pipeline/layout.ts` - the same
 * formula the pipeline used to write them). A level is one or the other,
 * never both: an incomplete or missing sheets directory falls back to the
 * per-file `<width>/` check, which is what lets a collection mid-rollout (mips
 * written, sheets not yet packed) still serve that level per-file rather
 * than not at all.
 *
 * Whether every room has every level is not checked for a per-file level: a
 * room missing one 404s, and the client already remembers a 404 and falls
 * back to another level - per-file probing would be thousands of stat calls
 * to learn something the fallback handles anyway. A sheet-packed level has
 * no such fallback (a missing sheet is a hole for every room in it), so
 * sheets are checked for completeness.
 *
 * @param source level-0 dimensions
 * @param roomCount how many rooms the collection has, to know how many sheets a
 *   sheet-packed level should hold
 */
export async function discoverLevels(dir: string, source: ImageSize | null, roomCount = 0): Promise<LevelInfo[]> {
  // Without a source size there is no ladder to look for, only the flat files.
  if (!source?.w || !source?.h) return [{ level: 0, w: source?.w ?? null, h: source?.h ?? null, dir: null }];

  const plan = mipPlan(source);
  const found: LevelInfo[] = [];
  for (const step of plan) {
    if (step.level === 0) {
      found.push({ ...step, dir: null });
      continue;
    }

    if (step.level >= SHEETS.fromLevel) {
      const layout = sheetPlan(roomCount);
      const sheetDir = sheetDirName(step.dir);
      const complete = await readdir(join(dir, sheetDir))
        .then((names) => {
          const files = new Set(names);
          return layout.sheetCount > 0 && Array.from({ length: layout.sheetCount }, (_, i) => sheetFileName(i)).every((f) => files.has(f));
        })
        .catch(() => false);
      if (complete) {
        found.push({
          level: step.level,
          w: step.w,
          h: step.h,
          dir: null,
          sheet: {
            tileW: step.w,
            tileH: step.h,
            cols: layout.cols,
            rows: layout.rows,
            roomsPerSheet: layout.roomsPerSheet,
            sheetCount: layout.sheetCount,
            dir: sheetDir,
            ext: 'jpg',
          },
        });
        continue;
      }
    }

    const path = join(dir, step.dir);
    const holds = await readdir(path)
      .then((names) => names.some((n) => IMAGE_EXT.has(extname(n).toLowerCase())))
      .catch(() => false);
    if (holds) found.push(step);
  }
  return found;
}

/**
 * Which of the favorite badge's pyramid levels are generated -
 * `fav_on.png`/`fav_off.png` scaled into per-level `<width>/` directories
 * under `--shared-dir`, the shape `discoverLevels` walks for the center tile,
 * off the same reference size. A level counts only when both faces
 * are present; the badge is never sheet-packed, so this only ever checks the
 * per-file shape `discoverLevels` does for a level below `SHEETS.fromLevel`.
 *
 * @param source the collection's reference tile size, same as `discoverLevels` gets
 */
async function discoverFavoriteLevels(sharedDir: string, source: ImageSize | null): Promise<LevelInfo[]> {
  if (!source?.w || !source?.h) return [{ level: 0, w: null, h: null, dir: null }];

  const plan = mipPlan(source);
  const found: LevelInfo[] = [];
  for (const step of plan) {
    if (step.level === 0) {
      found.push({ ...step, dir: null });
      continue;
    }
    const path = join(sharedDir, step.dir);
    const has = await readdir(path)
      .then((names) => {
        const files = new Set(names);
        return files.has(FAV_ON_FILE) && files.has(FAV_OFF_FILE);
      })
      .catch(() => false);
    if (has) found.push(step);
  }
  return found;
}

/** Image filenames in a directory, sorted. Rejects if the directory is missing. */
async function listImages(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).sort();
}

/** One shared tile: its file, an `images/shared/`-rooted url, and its size if readable. */
async function describeShared(tilesDir: string, sub: string, file: string): Promise<SharedAsset> {
  const size = await imageSize(join(tilesDir, sub, file)).catch(() => null);
  const url = `${IMAGES_BASE}/${SHARED_TILES_DIR}/${sub ? `${sub}/` : ''}${encodeURIComponent(file)}`;
  return { file, url, ...(size ?? {}) };
}

/**
 * Which file among `files` is the center render: `center`, else
 * `center_tile.*`, else `center.*`, else none. Exported so
 * `packages/pipeline/shared-mips.ts` can find the same file to pyramid
 * without restating the naming rule.
 */
export function resolveCenterFile(files: string[], center?: string): string | null {
  return (
    (center && files.find((f) => f === center || basename(f, extname(f)) === center)) ??
    files.find((f) => basename(f, extname(f)).toLowerCase() === 'center_tile') ??
    files.find((f) => basename(f, extname(f)).toLowerCase() === 'center') ??
    null
  );
}

/**
 * Discover the shared tiles in a collection's `SHARED_TILES_DIR`: the blank
 * center and the generic tiles.
 *
 * The center is served at cell (0, 0) and reserved for the search box and
 * controls, so it is always the plain center render - see `resolveCenterFile`.
 *
 * The generic tiles are every image in the `generic/` subdirectory, sorted.
 * There may be none (an empty or absent folder), which is the "only the
 * center tile" case the renderers fall back to.
 *
 * Distill mode's paired alternates come from `generic_distill/`, matched by
 * filename stem: `genericDistill[i]` is `generic[i]`'s match, or null where
 * the stem has none, so the arrays run parallel even if the folder is
 * missing entries or absent entirely.
 *
 * `levels` is filled in by the caller (`scanDirectory`), once it has settled
 * on the collection's reference size - see that function's own comment.
 */
async function scanShared(
  tilesDir: string,
  { center }: { center?: string } = {}
): Promise<Omit<SharedAssets, 'levels' | 'distillLevels' | 'favoriteLevels'>> {
  const files = await listImages(tilesDir).catch(() => []);
  const centerFile = resolveCenterFile(files, center);

  const centerAsset = centerFile ? await describeShared(tilesDir, '', centerFile) : null;

  const genericFiles = await listImages(join(tilesDir, GENERIC_DIR)).catch(() => []);
  const generic = await Promise.all(
    genericFiles.map((f) => describeShared(tilesDir, GENERIC_DIR, f))
  );

  const distillFiles = await listImages(join(tilesDir, GENERIC_DISTILL_DIR)).catch(() => []);
  const distillByStem = new Map<string, string>(
    distillFiles.map((f): [string, string] => [basename(f, extname(f)), f])
  );
  const genericDistill = await Promise.all(
    genericFiles.map(async (f) => {
      const match = distillByStem.get(basename(f, extname(f)));
      return match ? await describeShared(tilesDir, GENERIC_DISTILL_DIR, match) : null;
    })
  );

  return { center: centerAsset ?? null, generic, genericDistill };
}

/**
 * Scan a directory into a tile collection manifest.
 *
 * Ids are the positions in the sorted filename list - stable across
 * restarts, which is what the map's slot assignment keys on, and they
 * renumber when the collection changes (docs/agents/favorites.md, "Favorites").
 *
 * The shared tiles - the blank center and the generic tiles - live in the
 * collection's own `SHARED_TILES_DIR`. A collection without one has no center
 * and no generic tiles, which the renderers tolerate.
 *
 * @param opts.center names the center tile within `SHARED_TILES_DIR`
 * @param opts.sharedDir the fixed app art (`--shared-dir`), read only for the
 *   favorite badge's pyramid; omitted, the badge has level 0 only
 */
export async function scanDirectory(
  dir: string,
  { center, sharedDir }: { center?: string; sharedDir?: string } = {}
): Promise<Manifest> {
  const files = await listImages(dir);

  if (!files.length) throw new Error(`no images found in ${dir}`);

  const tilesDir = join(dir, SHARED_TILES_DIR);
  const sharedAssets = await scanShared(tilesDir, { center });

  const rooms: Room[] = await Promise.all(
    files.map(async (file, id) => {
      const path = join(dir, file);
      const [size, st] = await Promise.all([imageSize(path).catch(() => null), stat(path)]);
      return { id, file, url: `${IMAGES_BASE}/${encodeURIComponent(file)}`, bytes: st.size, ...(size ?? {}) };
    })
  );

  // The ladder is measured off the collection, not the shared tiles: a shared tile
  // is one file and may be any shape, while the rooms are what the map is
  // mostly made of. Fall back to a shared tile only when no room reported a size.
  const source =
    rooms.find((r) => r.w && r.h) ??
    [sharedAssets.center, ...sharedAssets.generic].find((b) => b?.w && b?.h) ??
    null;
  const levels = await discoverLevels(
    dir,
    source && source.w && source.h ? { w: source.w, h: source.h } : null,
    rooms.length
  );

  // The shared tiles' pyramid, off the same reference size: `packages/pipeline/
  // shared-mips.ts` writes it the same per-file way `mips.ts` writes a room's,
  // once rooted at `tilesDir` (the center) and once at `tilesDir/generic`
  // (every generic tile) - two separate trees, so a level only counts as
  // shared.levels if both actually have it. `generic_distill/` gets the same
  // treatment but its own field (`distillLevels`, see manifest.ts) rather than
  // being folded into this intersection - not every generic tile has a distill
  // alternate, so gating it on the base trees' rungs would veto levels the
  // distill tree actually has. The favorite badge's pyramid
  // (`favoriteLevels`) is discovered the same way, off the same reference
  // size, but checked directly rather than intersected with any of these -
  // see `discoverFavoriteLevels`'s doc. The rest of the fixed app art (the
  // distill toggle, the "forget searches" overlay) never gets a pyramid at
  // all and is not part of this discovery.
  const sharedSize = source && source.w && source.h ? { w: source.w, h: source.h } : null;
  const [centerLevels, genericLevels, distillLevels, favoriteLevels] = await Promise.all([
    discoverLevels(tilesDir, sharedSize),
    discoverLevels(join(tilesDir, GENERIC_DIR), sharedSize),
    discoverLevels(join(tilesDir, GENERIC_DISTILL_DIR), sharedSize),
    sharedDir ? discoverFavoriteLevels(sharedDir, sharedSize) : [{ level: 0, w: null, h: null, dir: null }],
  ]);
  // Only intersect against a tree that actually has something to pyramid -
  // a collection with generic tiles but no separate center (or vice versa) must
  // not have its real levels vetoed by the other tree's untouched level 0.
  const genericLevelNumbers = new Set(genericLevels.map((l) => l.level));
  const sharedLevels =
    sharedAssets.center && sharedAssets.generic.length
      ? centerLevels.filter((l) => genericLevelNumbers.has(l.level))
      : sharedAssets.generic.length
        ? genericLevels
        : centerLevels;

  // If tools/embed has left a blob alongside the images, surface its metadata
  // so the client can fetch it and rank in the browser. A stale blob - one
  // whose count no longer matches the collection - is ignored rather than
  // trusted: its rows are keyed on room ids that have since moved, so it
  // would rank the wrong rooms. Missing or unreadable, search falls back to
  // the stub.
  let embeddings: Manifest['embeddings'] = null;
  try {
    const meta = JSON.parse(await readFile(join(dir, 'embeddings.json'), 'utf8'));
    if (meta.count === rooms.length && meta.dim > 0 && typeof meta.scale === 'number' && meta.scale > 0)
      embeddings = {
        url: `${IMAGES_BASE}/embeddings.bin`,
        dim: meta.dim,
        count: meta.count,
        model: meta.model ?? null,
        scale: meta.scale,
      };
  } catch {
    // no blob, unreadable, or malformed - leave embeddings null
  }

  // The keyword/story sidecar, joined per filename: a miss is just a room
  // without keywords, so a collection that has grown or been renamed does not
  // invalidate it wholesale. Only {url, matched, entries} rides in the
  // manifest - the client blocks on that fetch before its first frame, and
  // the sidecar itself can be megabytes. The coverage pair is what keeps
  // drift visible from here: matched 0 against non-zero entries means the
  // keys have moved, and on the map that looks the same as no sidecar.
  let metadata: Manifest['metadata'] = null;
  try {
    const sidecar = JSON.parse(await readFile(join(dir, METADATA_FILE), 'utf8'));
    const { matched, entries } = metadataCoverage(rooms, sidecar);
    metadata = { url: `${IMAGES_BASE}/${METADATA_FILE}`, matched, entries };
  } catch {
    // no sidecar, unreadable, or malformed - leave metadata null
  }

  // The keyword -> external-link map. A flat object, not joined to anything -
  // count is just how many keywords it names.
  let tagLinks: Manifest['tagLinks'] = null;
  try {
    const map = JSON.parse(await readFile(join(dir, TAG_LINKS_FILE), 'utf8'));
    if (map && typeof map === 'object' && !Array.isArray(map))
      tagLinks = { url: `${IMAGES_BASE}/${TAG_LINKS_FILE}`, count: Object.keys(map).length };
  } catch {
    // no file, unreadable, or malformed - leave tagLinks null
  }

  return {
    mode: 'offline',
    directory: dir,
    /**
     * Where every url in this manifest is rooted; `createUrlFor` reads these
     * instead of hardcoding paths, so `remote.ts` can repoint a remotely
     * served collection at R2/Cloudflare without the client needing a second url
     * builder - see `IMAGES_BASE`.
     */
    imagesBase: IMAGES_BASE,
    sharedBase: SHARED_BASE,
    /**
     * The shared tiles: the blank `center` (or null if none was found) and the
     * `generic` array the generic tiles are drawn from. Served from
     * `images/shared/`, inside the collection.
     */
    shared: { ...sharedAssets, levels: sharedLevels, distillLevels, favoriteLevels },
    rooms,
    count: rooms.length,
    /** The image-embedding blob, if one has been generated; else null. */
    embeddings,
    /**
     * The keyword/story sidecar, if there is one; else null. Fetched
     * separately by the client.
     */
    metadata,
    /**
     * The keyword -> external link map, if `TAG_LINKS_FILE` was found; else
     * null. Fetched separately by the client, like `metadata`.
     */
    tagLinks,
    /**
     * The pyramid as it exists on disk, finest first. Clients build a level's
     * url as `images/<dir>/<file>`, or `images/<file>` where `dir` is null,
     * or - for a sheet-packed level (`level.sheet` present) - address a room
     * by formula into `images/<sheet.dir>/sheet-NNNN.<sheet.ext>` instead.
     */
    levels,
  };
}
