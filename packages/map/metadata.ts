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
 * ### `title` is optional, and falls back to the filename everywhere it is shown
 *
 * A room may carry a human-written `title`, shown in place of its filename
 * wherever a reader is told which room they're looking at, and used in place
 * of the filename to alphabetize the catalog's idle order. Absent for most
 * rooms until the corpus is retitled, which is why every consumer falls back
 * to the filename rather than assuming one is there.
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
  title: string | null;
  keywords: Keyword[];
  story: string | null;
  alt: string | null;
  /** Tags a reader may choose to block; empty when the room carries none. */
  sensitiveContentTags: string[];
}

/**
 * What a reader calls this room: its title, or "Room {id}" for a room the
 * corpus hasn't retitled. The numeric fallback is meaningful on its own -
 * every other consumer (the map's aria-live cursor, the search listbox, the
 * catalog's default order) already names an untitled room this way - so
 * this is the one place that fallback is written, rather than every caller
 * re-deriving `Room ${id}` next to its own `entry?.title` check.
 */
export function roomTitle(entry: RoomMeta | null, id: number): string {
  return entry?.title || `Room ${id}`;
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

  const title = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : null;
  const story = typeof entry.story === 'string' && entry.story.trim() ? entry.story.trim() : null;
  const alt = typeof entry.alt === 'string' && entry.alt.trim() ? entry.alt.trim() : null;

  const sensitiveContentTags: string[] = [];
  if (Array.isArray(entry.sensitive_content_tags))
    for (const t of entry.sensitive_content_tags) {
      if (typeof t === 'string' && t.trim()) sensitiveContentTags.push(t.trim());
    }

  // An entry carrying only an `alt` is still an entry: it describes the room,
  // which is the question "has metadata" is actually asking. Nothing at all -
  // an empty object, a string, a number - is what null is for. A room with
  // only sensitive-content tags and nothing else to describe is not one of
  // these entries either - there's nothing here worth reporting as coverage.
  return keywords.length || story || alt || title ? { title, keywords, story, alt, sensitiveContentTags } : null;
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

/**
 * Does this room carry any tag in `blocked`?
 *
 * A room with no entry, or no tags, is never blocked - there is nothing to
 * match against.
 */
export function isBlocked(meta: RoomMeta | null, blocked: ReadonlySet<string>): boolean {
  if (!meta || !blocked.size) return false;
  return meta.sensitiveContentTags.some((t) => blocked.has(t));
}

/**
 * Drop every id whose room carries a blocked tag, keeping the rest in order.
 *
 * This is the one place blocking actually removes a room from what the map or
 * catalog can show: it runs on an already-ranked/ordered id list, so a
 * blocked room simply never reaches a cell or a row rather than needing every
 * consumer of `order` to check `metadata` itself.
 *
 * @param ids room ids, in whatever order the caller ranked them
 * @param metadata indexed by room id, as `joinMetadata` produces it
 * @param blocked tags a reader has chosen to block
 */
export function filterBlockedIds(
  ids: number[],
  metadata: (RoomMeta | null)[] | null,
  blocked: ReadonlySet<string>
): number[] {
  if (!metadata || !blocked.size) return ids;
  return ids.filter((id) => !isBlocked(metadata[id], blocked));
}

/** How many rooms `blocked` actually removes - what the debug HUD reports. */
export function countBlocked(metadata: (RoomMeta | null)[] | null, blocked: ReadonlySet<string>): number {
  if (!metadata || !blocked.size) return 0;
  let n = 0;
  for (const m of metadata) if (isBlocked(m, blocked)) n++;
  return n;
}

/**
 * Every sensitive-content tag actually present in the corpus, sorted for a
 * stable checklist. The block-tags panel offers exactly these - not a fixed
 * vocabulary - so a corpus with none of these tags renders no panel at all
 * rather than a list of checkboxes with nothing behind them.
 */
export function availableSensitiveTags(metadata: (RoomMeta | null)[] | null): string[] {
  if (!metadata) return [];
  const tags = new Set<string>();
  for (const m of metadata) if (m) for (const t of m.sensitiveContentTags) tags.add(t);
  return [...tags].sort();
}
