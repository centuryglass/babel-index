/**
 * Room metadata: the three stylistic keywords and the short story text that the
 * generator writes alongside each image.
 *
 * ### Why this is keyed on filename, and why that matters
 *
 * `embeddings.bin` is row-major by room id, which is only correct while nothing
 * about the directory changes - so `scan.mjs` has to reject a blob whose count
 * has drifted, because its rows are positional and a stale one would attach the
 * wrong vector to the wrong room. Quiet, and wrong.
 *
 * A filename-keyed sidecar has no such failure mode. Add, remove or rename
 * images and every surviving entry still lands on its own room. So the rule here
 * is deliberately weaker than the blob's: join per file, tolerate a miss, and
 * report how many matched. A room with no entry simply has no keywords - which
 * is what the centre room and the generic alternates want anyway.
 *
 * The one thing worth being loud about is a sidecar that matches *nothing*: that
 * is not "no metadata", it is metadata whose filenames have drifted, and it
 * looks identical from the map. `scan.mjs` reports both numbers so the two can
 * be told apart.
 *
 * ### Liberal about shape
 *
 * Keywords may be plain strings or `{text, type}` objects; both normalise to the
 * same record. The count is not enforced - "exactly three" is a fact about how
 * the corpus is generated, not a constraint the map needs, and rejecting a room
 * with two would lose real data to a rule nothing here depends on.
 *
 * No DOM and no imports, like everything else in this package: it is joined by
 * `scan.mjs` in Node and by the client in the browser, and one implementation
 * with two consumers is what keeps those two from drifting.
 */

/**
 * Normalise one sidecar entry.
 *
 * @param {unknown} raw
 * @returns {{keywords: {text: string, type: string|null}[], story: string|null}|null}
 *   null when there is nothing usable, so "has metadata" stays a real question
 */
export function normaliseEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const keywords = [];
  if (Array.isArray(raw.keywords))
    for (const k of raw.keywords) {
      const text = typeof k === 'string' ? k : typeof k?.text === 'string' ? k.text : '';
      const trimmed = text.trim();
      if (trimmed) keywords.push({ text: trimmed, type: typeof k?.type === 'string' ? k.type : null });
    }

  const story = typeof raw.story === 'string' && raw.story.trim() ? raw.story.trim() : null;

  return keywords.length || story ? { keywords, story } : null;
}

/**
 * Join a sidecar onto the corpus, by filename.
 *
 * @param {{id: number, file: string}[]} rooms the manifest's rooms
 * @param {object} sidecar parsed `metadata.json`
 * @returns {(object|null)[]} indexed by room id; null where a room has none
 */
export function joinMetadata(rooms, sidecar) {
  const byId = new Array(rooms.length).fill(null);
  if (!sidecar || typeof sidecar !== 'object') return byId;

  for (const room of rooms) {
    // hasOwn rather than a bare lookup, for a corpus containing a file called
    // `constructor` or `toString`. Defensive rather than load-bearing: every
    // Object.prototype member normalises to null anyway, so this is style, and
    // there is deliberately no test pinning it - one could not fail.
    if (Object.hasOwn(sidecar, room.file)) byId[room.id] = normaliseEntry(sidecar[room.file]);
  }
  return byId;
}

/**
 * How many rooms a sidecar actually covers, and how many entries it holds.
 *
 * The pair is the point: `matched` far below `entries` means the sidecar is
 * describing files this corpus does not have, which reads exactly like having
 * no metadata unless someone says so.
 *
 * @returns {{matched: number, entries: number}}
 */
export function metadataCoverage(rooms, sidecar) {
  const joined = joinMetadata(rooms, sidecar);
  return {
    matched: joined.filter(Boolean).length,
    entries: sidecar && typeof sidecar === 'object' ? Object.keys(sidecar).length : 0,
  };
}
