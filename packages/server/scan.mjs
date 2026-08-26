import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, basename, resolve } from 'node:path';
import { mipPlan } from '../pipeline/layout.mjs';
import { metadataCoverage } from '../map/metadata.js';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * Where a local scan's urls are rooted. `remote.mjs` rewrites both the
 * manifest's `imagesBase`/`sharedBase` fields and every url built from these
 * constants when serving a corpus from R2/Cloudflare instead of disk, so this
 * is the one place "what does a room/shared/blob url look like" is decided -
 * rooms.js's per-level url construction reads `imagesBase` off the manifest
 * rather than restating the string.
 */
export const IMAGES_BASE = '/images';
export const SHARED_BASE = '/shared';

/** The keyword/story sidecar, written by the generator. See packages/map/metadata.js. */
export const METADATA_FILE = 'metadata.json';

/**
 * The subdirectory of the shared directory that holds the generic tiles. It is
 * a folder rather than a `generic*` glob so the center tile can sit in the
 * repo's `assets/` root without every stray image beside it (masks, canny
 * maps) being mistaken for a generic tile.
 */
export const GENERIC_DIR = 'generic';

/**
 * Read pixel dimensions from a file header, without decoding the image.
 * Returns null for anything unrecognised - the client falls back to the
 * natural size once the image loads, so this is an optimisation, not a
 * requirement.
 */
export async function imageSize(path) {
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
 * Which of the pyramid's levels have actually been generated for this corpus.
 *
 * The generator writes `<dir>/<width>/<file>` for every level below the source
 * and leaves level 0 flat, so discovery is: work out what the ladder *would*
 * produce at this source size, then keep the rungs whose directory is really
 * there. Level 0 is always present - it is the flat files themselves - which is
 * what keeps "point it at a directory of images" true for a corpus that has
 * never been near the pipeline.
 *
 * Deliberately not checked: whether every room has every level. A room missing
 * one 404s, and the client already remembers a 404 and falls back to another
 * level, so per-file probing would be thousands of stat calls to learn
 * something the fallback handles anyway.
 *
 * @param {string} dir
 * @param {{w: number, h: number}|null} source  level-0 dimensions
 * @returns {Promise<{level: number, w: number, h: number, dir: string|null}[]>}
 */
export async function discoverLevels(dir, source) {
  // Without a source size there is no ladder to look for, only the flat files.
  if (!source?.w || !source?.h) return [{ level: 0, w: source?.w ?? null, h: source?.h ?? null, dir: null }];

  const plan = mipPlan(source);
  const found = [];
  for (const step of plan) {
    if (step.level === 0) {
      found.push({ ...step, dir: null });
      continue;
    }
    const path = join(dir, step.dir);
    const holds = await readdir(path)
      .then((names) => names.some((n) => IMAGE_EXT.has(extname(n).toLowerCase())))
      .catch(() => false);
    if (holds) found.push(step);
  }
  return found;
}

/** Image filenames in a directory, sorted. Rejects if the directory is missing. */
async function listImages(dir) {
  const entries = await readdir(dir);
  return entries.filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).sort();
}

/** One shared asset: its file, a `/shared/`-rooted url, and its size if readable. */
async function describeShared(sharedDir, sub, file) {
  const size = await imageSize(join(sharedDir, sub, file)).catch(() => null);
  return { file, url: `${SHARED_BASE}/${sub ? `${sub}/` : ''}${encodeURIComponent(file)}`, ...(size ?? {}) };
}

/**
 * Discover the shared tiles: the blank center and the generic tiles.
 *
 * The center is served at cell (0, 0) and reserved for the search box and
 * controls, so it is always the plain center render - `--center`, else
 * `center_tile.*`, else `center.*`. `allowFirst` keeps the old single-directory
 * behaviour working: when the shared assets live in the corpus directory
 * itself and nothing named center is present, the first image stands in as
 * the center.
 *
 * The generic tiles are every image in the `generic/` subdirectory, sorted.
 * There may be none (an empty or absent folder), which is the "only the
 * center tile" case the renderers fall back to.
 *
 * @param {string} sharedDir
 * @param {{center?: string, allowFirst?: boolean}} opts
 * @returns {Promise<{center: object|null, generic: object[]}>}
 */
async function scanShared(sharedDir, { center, allowFirst = false } = {}) {
  const files = await listImages(sharedDir).catch(() => []);
  const centerFile =
    (center && files.find((f) => f === center || basename(f, extname(f)) === center)) ??
    files.find((f) => basename(f, extname(f)).toLowerCase() === 'center_tile') ??
    files.find((f) => basename(f, extname(f)).toLowerCase() === 'center') ??
    (allowFirst ? files[0] : null);

  const centerAsset = centerFile ? await describeShared(sharedDir, '', centerFile) : null;

  const genericFiles = await listImages(join(sharedDir, GENERIC_DIR)).catch(() => []);
  const generic = await Promise.all(
    genericFiles.map((f) => describeShared(sharedDir, GENERIC_DIR, f))
  );

  return { center: centerAsset, generic };
}

/**
 * Scan a directory into a corpus manifest.
 *
 * Offline mode is just this: point at a folder of images. No database, no
 * bucket, no upload step. Ids are assigned by sorted filename so they are
 * stable across restarts, which matters because the map's slot assignment is
 * keyed on them.
 *
 * The shared tiles - the blank center and the generic tiles - live in
 * `sharedDir`, which defaults to the corpus directory (the old behaviour,
 * where a `center.*` in the images folder is the generic wallpaper) but is
 * usually pointed at the repo's `assets/` so the center render can be shared
 * across corpora and reached from outside `--images`.
 *
 * @param {string} dir
 * @param {{center?: string, sharedDir?: string}} [opts] center names the
 *   center tile; sharedDir is where the shared tiles live (default: the
 *   corpus directory)
 */
export async function scanDirectory(dir, { center, sharedDir = dir } = {}) {
  const files = await listImages(dir);

  if (!files.length) throw new Error(`no images found in ${dir}`);

  // When the shared tiles are the corpus directory itself, the center may be
  // one of these files and the first image can stand in for a missing center.
  const sameDir = resolve(sharedDir) === resolve(dir);
  const sharedAssets = await scanShared(sharedDir, { center, allowFirst: sameDir });

  // A center living in the corpus directory is not also a ranked room - being
  // both the generic wallpaper and a search result would put it everywhere and
  // in the ranking too. A center living elsewhere excludes nothing.
  const excluded = sameDir && sharedAssets.center ? sharedAssets.center.file : null;
  const corpus = files.filter((f) => f !== excluded);

  const rooms = await Promise.all(
    corpus.map(async (file, id) => {
      const path = join(dir, file);
      const [size, st] = await Promise.all([imageSize(path).catch(() => null), stat(path)]);
      return { id, file, url: `${IMAGES_BASE}/${encodeURIComponent(file)}`, bytes: st.size, ...(size ?? {}) };
    })
  );

  // The ladder is measured off the corpus, not the shared tiles: a shared tile
  // is one file and may be any shape, while the rooms are what the map is
  // mostly made of. Fall back to a shared tile only when no room reported a size.
  const source =
    rooms.find((r) => r.w && r.h) ??
    [sharedAssets.center, ...sharedAssets.generic].find((b) => b?.w && b?.h) ??
    null;
  const levels = await discoverLevels(dir, source && source.w ? { w: source.w, h: source.h } : null);

  // If tools/embed has left a blob alongside the images, surface its metadata so
  // the client can fetch it and rank in the browser. A stale blob - one whose
  // count no longer matches the corpus - is ignored rather than trusted: its
  // rows are keyed on room ids that have since moved, so it would rank the wrong
  // rooms. Missing or unreadable, search simply falls back to the stub.
  let embeddings = null;
  try {
    const meta = JSON.parse(await readFile(join(dir, 'embeddings.json'), 'utf8'));
    if (meta.count === rooms.length && meta.dim > 0)
      embeddings = { url: `${IMAGES_BASE}/embeddings.bin`, dim: meta.dim, count: meta.count, model: meta.model ?? null };
  } catch {
    // no blob, unreadable, or malformed - leave embeddings null
  }

  // The keyword/story sidecar. Unlike the blob above this is keyed on filename,
  // so a corpus that has grown or been renamed does not invalidate it wholesale
  // - it is joined per file and a miss is just a room without keywords. What is
  // worth surfacing is the pair (matched, entries): a sidecar describing files
  // this corpus does not have looks exactly like no sidecar at all from the map.
  let metadata = null;
  try {
    const sidecar = JSON.parse(await readFile(join(dir, METADATA_FILE), 'utf8'));
    const { matched, entries } = metadataCoverage(rooms, sidecar);
    metadata = { url: `${IMAGES_BASE}/${METADATA_FILE}`, matched, entries };
  } catch {
    // no sidecar, unreadable, or malformed - leave metadata null
  }

  return {
    mode: 'offline',
    directory: dir,
    /**
     * Where every url in this manifest is rooted - `rooms.js`'s `createUrlFor`
     * reads these instead of hardcoding the paths, so `remote.mjs` can point a
     * remotely-served corpus's urls (and every url already baked into this
     * manifest) at R2/Cloudflare directly without the client needing a second
     * "how do I build a url" implementation.
     */
    imagesBase: IMAGES_BASE,
    sharedBase: SHARED_BASE,
    /**
     * The shared tiles: the blank `center` (or null if none was found) and the
     * `generic` array the generic tiles are drawn from. Served from `/shared/`,
     * which the demo points at `--shared-dir`.
     */
    shared: sharedAssets,
    rooms,
    count: rooms.length,
    /** The image-embedding blob, if one has been generated; else null. */
    embeddings,
    /**
     * The keyword/story sidecar, if there is one; else null. The client fetches
     * it separately - at a full corpus it is megabytes, and this manifest is on
     * the path to the first frame.
     */
    metadata,
    /**
     * The pyramid as it exists on disk, finest first. Clients build a level's
     * url as `/images/<dir>/<file>`, or `/images/<file>` where `dir` is null.
     */
    levels,
  };
}
