import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { mipPlan } from '../pipeline/layout.mjs';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

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

/**
 * Scan a directory into a corpus manifest.
 *
 * Offline mode is just this: point at a folder of images. No database, no
 * bucket, no upload step. Ids are assigned by sorted filename so they are
 * stable across restarts, which matters because the map's slot assignment is
 * keyed on them.
 *
 * @param {string} dir
 * @param {{base?: string}} [opts] filename to use as the generic room
 */
export async function scanDirectory(dir, { base } = {}) {
  const entries = await readdir(dir);
  const files = entries.filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).sort();

  if (!files.length) throw new Error(`no images found in ${dir}`);

  // The generic room: whatever was asked for, else a file called base.*, else
  // the first one. It is excluded from the ranked corpus so it is not both the
  // wallpaper and a search result.
  const baseFile =
    (base && files.find((f) => f === base || basename(f, extname(f)) === base)) ??
    files.find((f) => basename(f, extname(f)).toLowerCase() === 'base') ??
    files[0];

  const corpus = files.filter((f) => f !== baseFile);

  const rooms = await Promise.all(
    corpus.map(async (file, id) => {
      const path = join(dir, file);
      const [size, st] = await Promise.all([imageSize(path).catch(() => null), stat(path)]);
      return { id, file, url: `/images/${encodeURIComponent(file)}`, bytes: st.size, ...(size ?? {}) };
    })
  );

  const baseSize = await imageSize(join(dir, baseFile)).catch(() => null);

  // The ladder is measured off the corpus, not the generic room: the generic is
  // one file and may be anything, while the rooms are what the map is mostly
  // made of. Fall back to the generic only when no room reported a size.
  const source = rooms.find((r) => r.w && r.h) ?? baseSize;
  const levels = await discoverLevels(dir, source);

  return {
    mode: 'offline',
    directory: dir,
    generic: {
      file: baseFile,
      url: `/images/${encodeURIComponent(baseFile)}`,
      ...(baseSize ?? {}),
    },
    rooms,
    count: rooms.length,
    /**
     * The pyramid as it exists on disk, finest first. Clients build a level's
     * url as `/images/<dir>/<file>`, or `/images/<file>` where `dir` is null.
     */
    levels,
  };
}
