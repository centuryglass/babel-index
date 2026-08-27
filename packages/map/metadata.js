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
 * is what the center room and the generic alternates want anyway.
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
 * ### `alt`, and why it is optional in the strong sense
 *
 * A room may carry an `alt`: one sentence describing the PICTURE, for a reader
 * who cannot see it (accessibility-plan.md §3.5, phase E). It is written once,
 * offline, by the same generator that wrote the story and WITH the story as
 * context - never at runtime, and never by anything in this repository, which
 * is the whole reason the map has no model dependency.
 *
 * Optional in the strong sense: a room whose story is thin should carry no
 * `alt` at all rather than a padded one. `describeCell`'s honesty rule ("no
 * description recorded") is a better answer than a confident sentence about a
 * wall of books that could be any wall of books, so absence normalises to null
 * and every consumer falls back to what the room already has.
 *
 * No DOM and no imports, like everything else in this package: it is joined by
 * `scan.mjs` in Node and by the client in the browser, and one implementation
 * with two consumers is what keeps those two from drifting.
 */

/**
 * @typedef {object} RoomMeta
 * @property {{text: string, type: string|null}[]} keywords
 * @property {string|null} story
 * @property {string|null} alt
 */

/**
 * Normalise one sidecar entry.
 *
 * @param {unknown} raw
 * @returns {RoomMeta|null}
 *   null when there is nothing usable, so "has metadata" stays a real question
 */
export function normaliseEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = /** @type {Record<string, unknown>} */ (raw);

  const keywords = [];
  if (Array.isArray(entry.keywords))
    for (const k of entry.keywords) {
      const text = typeof k === 'string' ? k : typeof k?.text === 'string' ? k.text : '';
      const trimmed = text.trim();
      if (trimmed) keywords.push({ text: trimmed, type: typeof k?.type === 'string' ? k.type : null });
    }

  const story = typeof entry.story === 'string' && entry.story.trim() ? entry.story.trim() : null;
  const alt = typeof entry.alt === 'string' && entry.alt.trim() ? entry.alt.trim() : null;

  // An entry carrying only an `alt` is still an entry: it describes the room,
  // which is the question "has metadata" is actually asking. Nothing at all -
  // an empty object, a string, a number - is what null is for.
  return keywords.length || story || alt ? { keywords, story, alt } : null;
}

/**
 * Join a sidecar onto the corpus, by filename.
 *
 * @param {import('./manifest.ts').Room[]} rooms the manifest's rooms
 * @param {unknown} sidecar parsed `metadata.json`
 * @returns {(RoomMeta|null)[]} indexed by room id; null where a room has none
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
 * @param {import('./manifest.ts').Room[]} rooms
 * @param {unknown} sidecar
 * @returns {{matched: number, entries: number}}
 */
export function metadataCoverage(rooms, sidecar) {
  const joined = joinMetadata(rooms, sidecar);
  return {
    matched: joined.filter(Boolean).length,
    entries: sidecar && typeof sidecar === 'object' ? Object.keys(sidecar).length : 0,
  };
}
