/**
 * The two favorite sort modes, as a re-sort of an order that already exists -
 * and, when one is active, as a placement input alongside a search.
 *
 * A sort mode moves rooms within whatever ranking is already in force - the
 * search's `order` on the map, alphabetical in the catalog - which is why this
 * is a stable re-sort of a base array rather than a ranking of its own.
 * Everything the base order decided survives inside each group: search a
 * term, sort by favorites, and the favorited rooms arrive in the order that
 * search put them in.
 *
 * An active favorite sort is now also a certainty signal, exactly as a search
 * is - see `docs/favorites-density-plan.md`. `favoriteSort` folds it in: every
 * room the sort lifts to the front gets certainty 1, composed with (not
 * replacing) whatever certainty a running search already gave it. `'mine'` with
 * no search is a tight cluster of the reader's favorites against the center at
 * baseline everywhere else; `'mine'` with a search enriches the search's own
 * cluster rather than discarding it. A relevance re-sort and the shuffle button
 * are not placement inputs and pass a search's certainty through untouched.
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
export function favoriteOrder(base: number[], input: FavoriteSortInput): number[] {
  if (input.mode === 'relevance') return base;

  // The base position IS the tiebreak, so it is captured before sorting rather
  // than relied on: `Array.prototype.sort` is stable in every engine this runs
  // in, but a comparator that says so out loud survives a future rewrite that
  // sorts a different array.
  const at = new Map<number, number>();
  base.forEach((id, i) => at.set(id, i));

  const key = liftKey(input);
  return [...base].sort((a, b) => key(b) - key(a) || (at.get(a) as number) - (at.get(b) as number));
}

/**
 * A search's own ranking and certainty, as `favoriteSort` needs it to fold a
 * favorite boost into a live search rather than replace it - the same shape
 * `useSearch`'s `result` carries (`order`/`certainty`), narrowed to the two
 * fields that matter here.
 */
export interface SearchCertainty {
  /** room ids, best first - the search's own order, before blocking/favorites */
  order: number[];
  /** per rank of `order`, in [0, 1] */
  certainty: ArrayLike<number>;
}

export interface FavoriteSortResult {
  order: number[];
  /** per rank, aligned to `order`; null when nothing drives density */
  certainty: Float32Array | null;
}

/**
 * `favoriteOrder` plus the certainty profile an active sort now drives - see
 * the file comment and `docs/favorites-density-plan.md`.
 *
 * `search` is the running search's own order/certainty, independent of `base`
 * (which may already be filtered for blocked tags) - passing the search's own
 * pair rather than something aligned to `base` is what lets this module do the
 * id -> certainty crossing itself, the same way it already crosses id ->
 * filename for favorites.
 */
export function favoriteSort(
  base: number[],
  input: FavoriteSortInput,
  search: SearchCertainty | null = null
): FavoriteSortResult {
  const order = favoriteOrder(base, input);

  if (input.mode === 'relevance') {
    // Same array identity as `result.certainty` when nothing sorted, so a
    // caller memoising on identity sees no change at all.
    return { order, certainty: (search?.certainty as Float32Array | undefined) ?? null };
  }

  const byRoom = new Map<number, number>();
  if (search) search.order.forEach((id, i) => byRoom.set(id, Number(search.certainty[i])));

  const key = liftKey(input);
  const certainty = new Float32Array(order.length);
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    certainty[i] = Math.max(byRoom.get(id) ?? 0, key(id) > 0 ? 1 : 0);
  }
  return { order, certainty };
}

/** The per-room sort key `favoriteOrder` sorts by and `favoriteSort` lifts on. */
function liftKey({ mode, files, counts, mine }: FavoriteSortInput): (id: number) => number {
  return mode === 'mine'
    ? (id: number) => (mine.has(files[id]?.file ?? '') ? 1 : 0)
    : (id: number) => counts[files[id]?.file ?? ''] ?? 0;
}

/** How many of `mine` this corpus actually has rooms for - what the sort would move to the front. */
export function favoriteCount(files: { file: string }[], mine: ReadonlySet<string>): number {
  return files.reduce((n, room) => n + (mine.has(room.file) ? 1 : 0), 0);
}
