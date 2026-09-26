/**
 * Room metadata: the stylistic keywords and the short story text that the
 * generator writes alongside each image. The file format is docs/corpus.md,
 * "`metadata.json`".
 *
 * One implementation joined on both sides: the server (`scan.ts`,
 * `roomContent.ts`) and the browser (`useCorpus.ts`). No DOM and no runtime
 * imports, like the rest of this package.
 *
 * The join is per filename, so adding, removing or renaming images leaves
 * every surviving entry on its room. `embeddings.bin` is keyed by row order
 * instead (docs/agents/search.md, "embeddings.bin is keyed by row order").
 * Joining tolerates a miss and reports how many matched. A room with no entry
 * has no keywords, which suits the center room and the generic alternates.
 *
 * Field rules:
 *
 * - `keywords`: every keyword is a `{text, type}` record. The count is not
 *   enforced, since nothing in the map depends on it.
 * - `title` and `alt` are expected but not required. Every room in the live
 *   corpus carries both, but a corpus built by hand or mid-curation may lack
 *   either, so absence normalises to null and every consumer falls back.
 * - `title` is the room's name wherever a reader is told which room they're
 *   looking at (`roomTitle`), and the catalog's alphabetical sort key
 *   (`alphabeticalOrder`). Without one, both fall back to the id or filename.
 * - `alt` describes the picture for a reader who cannot see it. It is written
 *   offline beside the story, never at runtime, so the map carries no model
 *   dependency. Without one, `describeRoom`'s `picture` is null and the image
 *   gets an empty `alt`.
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
 * corpus has not retitled. This is the resolver for everywhere a name is
 * shown (catalog rows, the room overlay, the SSR pages); the cursor's
 * announcement and `describeRoom`'s rank message lead with the bare id
 * whether or not a title exists - the id is how the map refers to rooms.
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
  // which is what "has metadata" is asking. Tags alone are not - a room with
  // only sensitive-content tags has nothing here worth reporting as coverage.
  // Null is for nothing at all: an empty object, a string, a number.
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
    // `constructor` or `toString`. Style, not load-bearing: every
    // Object.prototype member normalises to null anyway, and no test pins it
    // - one could not fail.
    if (Object.hasOwn(table, room.file)) byId[room.id] = normaliseEntry(table[room.file]);
  }
  return byId;
}

/**
 * How many rooms a sidecar actually covers, and how many entries it holds.
 *
 * The pair is the point: `matched` far below `entries` means the sidecar is
 * describing files this corpus does not have, which from the map reads like
 * having no metadata at all unless someone says so.
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
 * This is the one place blocking removes a room from what the map or catalog
 * can show: it runs on an already-ranked/ordered id list, so a blocked room
 * never reaches a cell or a row, and no consumer of `order` has to check
 * `metadata` itself.
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

/** How many rooms `blocked` removes - what the debug HUD reports. */
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
