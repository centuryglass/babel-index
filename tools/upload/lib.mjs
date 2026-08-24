/**
 * Pure logic for the R2 upload tool: which files need uploading, and under
 * what keys. No filesystem, no network - so it can be tested without a
 * corpus on disk or a bucket to talk to. `upload-r2.mjs` does the I/O and
 * calls in here for the decisions.
 */

/**
 * Every (local path, remote key) pair a corpus upload touches, derived from a
 * `scanDirectory()` manifest the same way the demo server and `tools/embed`
 * read it - so a change to scan.mjs's shape shows up here rather than behind
 * a second, drifting copy of "what files make up a corpus".
 *
 * Keys mirror the local layout (`<prefix>/<file>`, `<prefix>/<level-dir>/<file>`)
 * so a future R2-backed demo server can resolve a room's url the same way
 * `rooms.js` does locally. Shared assets (the center tile and the generics)
 * live outside any one corpus's prefix, at `shared/...`, matching where the
 * demo server mounts them (`/shared/`) - multiple corpora can point at the
 * same shared tiles without re-uploading them.
 *
 * @param {object} manifest a `scanDirectory()` result
 * @param {{imagesDir: string, sharedDir: string, prefix: string}} opts
 * @param {(...parts: string[]) => string} join path.join, injected so this
 *   stays free of node:path and testable with plain strings
 * @returns {{local: string, key: string}[]}
 */
export function buildUploadList(manifest, { imagesDir, sharedDir, prefix }, join) {
  const uploads = [];

  for (const room of manifest.rooms) uploads.push({ local: join(imagesDir, room.file), key: `${prefix}/${room.file}` });

  for (const level of manifest.levels) {
    if (level.level === 0 || !level.dir) continue; // level 0 is the flat files above
    for (const room of manifest.rooms)
      uploads.push({ local: join(imagesDir, level.dir, room.file), key: `${prefix}/${level.dir}/${room.file}` });
  }

  if (manifest.metadata) uploads.push({ local: join(imagesDir, 'metadata.json'), key: `${prefix}/metadata.json` });

  if (manifest.embeddings) {
    uploads.push({ local: join(imagesDir, 'embeddings.bin'), key: `${prefix}/embeddings.bin` });
    uploads.push({ local: join(imagesDir, 'embeddings.json'), key: `${prefix}/embeddings.json` });
  }

  if (manifest.shared?.center)
    uploads.push({ local: join(sharedDir, manifest.shared.center.file), key: `shared/${manifest.shared.center.file}` });

  for (const generic of manifest.shared?.generic ?? [])
    uploads.push({ local: join(sharedDir, 'generic', generic.file), key: `shared/generic/${generic.file}` });

  return uploads;
}

/**
 * Split an upload list into what needs uploading and what's already current,
 * by comparing each file's freshly-computed content hash against the record
 * for that key in the previously-uploaded manifest. A key absent from the
 * remote manifest (new file, or first run) always uploads.
 *
 * Hashing the file's own bytes - not reusing metadata.json's per-source hash
 * - is deliberate: it also catches a pyramid level re-encoded at a different
 * quality setting, which shares its source hash with the old level but isn't
 * the same bytes.
 *
 * @param {{local: string, key: string}[]} uploads
 * @param {Map<string, string>} hashes local path -> content hash
 * @param {Record<string, string>} remoteManifest key -> content hash, from the
 *   last upload
 * @returns {{toUpload: {local: string, key: string, hash: string}[],
 *   unchanged: {local: string, key: string, hash: string}[]}}
 */
export function diffAgainstManifest(uploads, hashes, remoteManifest) {
  const toUpload = [];
  const unchanged = [];
  for (const { local, key } of uploads) {
    const hash = hashes.get(local);
    const entry = { local, key, hash };
    if (remoteManifest[key] === hash) unchanged.push(entry);
    else toUpload.push(entry);
  }
  return { toUpload, unchanged };
}

/** Guess a Content-Type from a key's extension, for the objects this tool writes. */
export function guessContentType(key) {
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.bin')) return 'application/octet-stream';
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}
