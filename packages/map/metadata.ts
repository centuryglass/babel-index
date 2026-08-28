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
 * ### `keywords` is a fixed shape
 *
 * Every keyword is a `{text, type}` record - the generator always writes it
 * that way. The count is not enforced - "exactly three" is a fact about how
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

/** One keyword, as the generator writes it. */
export interface Keyword {
  text: string;
  type: string | null;
}

/** One room's normalised sidecar entry. */
export interface RoomMeta {
  keywords: Keyword[];
  story: string | null;
  alt: string | null;
}

/**
 * Normalise one sidecar entry.
 *
 * @param raw parsed JSON, of whatever shape the sidecar file actually holds
 * @returns null when there is nothing usable, so "has metadata" stays a real question
 */
export function normaliseEntry(raw: unknown): RoomMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;

  const keywords: Keyword[] = [];
  if (Array.isArray(entry.keywords))
    for (const k of entry.keywords) {
      if (!k || typeof k !== 'object') continue;
      const text = typeof (k as Record<string, unknown>).text === 'string' ? ((k as Record<string, unknown>).text as string).trim() : '';
      if (!text) continue;
      const type = typeof (k as Record<string, unknown>).type === 'string' ? ((k as Record<string, unknown>).type as string) : null;
      keywords.push({ text, type });
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
 * @param rooms the manifest's rooms
 * @param sidecar parsed `metadata.json`
 * @returns indexed by room id; null where a room has none
 */
export function joinMetadata(rooms: import('./manifest.ts').Room[], sidecar: unknown): (RoomMeta | null)[] {
  const byId: (RoomMeta | null)[] = new Array(rooms.length).fill(null);
  if (!sidecar || typeof sidecar !== 'object') return byId;
  const table = sidecar as Record<string, unknown>;

  for (const room of rooms) {
    // hasOwn rather than a bare lookup, for a corpus containing a file called
    // `constructor` or `toString`. Defensive rather than load-bearing: every
    // Object.prototype member normalises to null anyway, so this is style, and
    // there is deliberately no test pinning it - one could not fail.
    if (Object.hasOwn(table, room.file)) byId[room.id] = normaliseEntry(table[room.file]);
  }
  return byId;
}

/**
 * How many rooms a sidecar actually covers, and how many entries it holds.
 *
 * The pair is the point: `matched` far below `entries` means the sidecar is
 * describing files this corpus does not have, which reads exactly like having
 * no metadata unless someone says so.
 */
export function metadataCoverage(
  rooms: import('./manifest.ts').Room[],
  sidecar: unknown
): { matched: number; entries: number } {
  const joined = joinMetadata(rooms, sidecar);
  return {
    matched: joined.filter(Boolean).length,
    entries: sidecar && typeof sidecar === 'object' ? Object.keys(sidecar).length : 0,
  };
}
