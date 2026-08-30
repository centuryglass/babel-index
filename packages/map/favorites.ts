/**
 * The two favorite sort modes, as a re-sort of an order that already exists.
 *
 * A sort mode is not a search. It takes whatever ranking is already in force -
 * the search's `order` on the map, alphabetical in the catalog - and moves rooms
 * within it, which is why this is a stable re-sort of a base array rather than a
 * ranking of its own. Everything the base order decided survives inside each
 * group: search a term, sort by favorites, and the favorited rooms arrive in the
 * order that search put them in.
 *
 * ### Sorting to the front, not filtering
 *
 * `'mine'` moves the reader's favorites ahead of everything else and keeps the
 * rest below them. Filtering was the alternative and it reads wrong on the map -
 * a library that empties out to the four rooms someone has starred is not a
 * library - and it would also duplicate what `filterBlockedIds` already does for
 * a different reason. The catalog gets the same treatment for the same reason
 * the two views share one `result.order`: a room must not sit at a different
 * position depending on which view is asking.
 *
 * ### Why files, not ids
 *
 * Favorites are recorded by filename (see `persist.ts` and
 * `packages/server/favorites.ts`) because room ids are positional and shift
 * when the corpus grows. Ids are the currency inside a session, so this module
 * is handed `files` - the id -> filename lookup, i.e. `manifest.rooms` - and
 * does the crossing itself, in one place.
 *
 * No DOM and no React, so every case below is assertable in the plain test
 * runner.
 */

/** Which order the reader asked for. `'relevance'` is the base order untouched. */
export type SortMode = 'relevance' | 'mine' | 'count';

export interface FavoriteSortInput {
  mode: SortMode;
  /** id -> filename, i.e. `manifest.rooms` */
  files: { file: string }[];
  /** global counts by filename, as `/api/favorites` reports them */
  counts: Record<string, number>;
  /** the reader's own favorites, by filename */
  mine: ReadonlySet<string>;
}

/**
 * Re-sort `base` for the given mode.
 *
 * Returns `base` itself for `'relevance'` - the same array, not a copy, so a
 * consumer memoising on identity sees no change at all when nothing sorted.
 *
 * @param base room ids, best first
 * @returns room ids, best first under this mode
 */
export function favoriteOrder(base: number[], { mode, files, counts, mine }: FavoriteSortInput): number[] {
  if (mode === 'relevance') return base;

  // The base position IS the tiebreak, so it is captured before sorting rather
  // than relied on: `Array.prototype.sort` is stable in every engine this runs
  // in, but a comparator that says so out loud survives a future rewrite that
  // sorts a different array.
  const at = new Map<number, number>();
  base.forEach((id, i) => at.set(id, i));

  const key =
    mode === 'mine'
      ? (id: number) => (mine.has(files[id]?.file ?? '') ? 1 : 0)
      : (id: number) => counts[files[id]?.file ?? ''] ?? 0;

  return [...base].sort((a, b) => key(b) - key(a) || (at.get(a) as number) - (at.get(b) as number));
}

/** How many of `mine` this corpus actually has rooms for - what the sort would move to the front. */
export function favoriteCount(files: { file: string }[], mine: ReadonlySet<string>): number {
  return files.reduce((n, room) => n + (mine.has(room.file) ? 1 : 0), 0);
}
