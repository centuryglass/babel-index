/**
 * The favorite sort modes, as a stable re-sort of an order that already
 * exists - and, for the two favorite-based ones, as a placement input
 * alongside a search.
 *
 * A sort mode moves rooms within whatever ranking is already in force - the
 * search's `order` on the map, alphabetical in the catalog - which is why this
 * is a stable re-sort of a base array rather than a ranking of its own.
 * Everything the base order decided survives inside each group: search a
 * term, sort by favorites, and the favorited rooms arrive in the order that
 * search put them in.
 *
 * An active favorite sort is also a certainty signal, the way a search is.
 * `favoriteSort` folds it in: every room the sort lifts to the front gets
 * certainty 1, composed with (not replacing) whatever certainty a running
 * search already gave it. `'mine'` with no search is a tight cluster of the
 * reader's favorites against the center at baseline everywhere else; with a
 * search it enriches the search's own cluster. A relevance re-sort, the
 * shuffle button, and `'random'` are not placement inputs and pass a
 * search's certainty through untouched.
 *
 * ### Sorting to the front, not filtering
 *
 * `'mine'` moves the reader's favorites ahead of everything else and keeps
 * the rest below them; removing rooms is `filterBlockedIds`'s job, for a
 * different reason. The map and the catalog share one `result.order`, so a
 * room must not sit at a different position depending on which view is
 * asking.
 *
 * ### Keys are filenames, not ids
 *
 * The reason is AGENTS.md's "Favorites are keyed by filename everywhere":
 * room ids are positional and renumber when the corpus grows. Ids are the
 * currency inside a session, so this module is handed `files` - the id ->
 * filename lookup, i.e. `manifest.rooms` - and does the crossing itself, in
 * one place.
 *
 * No DOM and no React, so every case in the file is assertable in the plain
 * test runner.
 *
 * ### `'random'`
 *
 * A fourth re-sort on the same stable-sort machinery: `liftKey` draws each
 * room's key from `randomSeed` instead of from a favorite fact. It is not a
 * placement input - a shuffled catalog is not a claim about confidence, so
 * it must not cluster the map around anything. The seed is the caller's to
 * manage: the same seed always produces the same order, so the caller
 * decides when a fresh shuffle is warranted (switching into `'random'`) and
 * when the existing one should hold (a re-render, a view switch).
 */

import { prng, seedFrom } from './prng.ts';

/** Which order the reader asked for. `'relevance'` is the base order untouched. */
export type SortMode = 'relevance' | 'mine' | 'count' | 'random';

export interface FavoriteSortInput {
  mode: SortMode;
  /** id -> filename, i.e. `manifest.rooms` */
  files: { file: string }[];
  /** global counts by filename, as `/api/favorites` reports them */
  counts: Record<string, number>;
  /** the reader's own favorites, by filename */
  mine: ReadonlySet<string>;
  /** seed for `'random'` mode; unused otherwise */
  randomSeed?: number;
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

  // The base position is the tiebreak, captured before sorting rather than
  // assumed: `Array.prototype.sort` is stable in every engine this runs in,
  // but a comparator that says the tiebreak out loud survives a rewrite
  // that sorts a different array.
  const at = new Map<number, number>();
  base.forEach((id, i) => at.set(id, i));

  const key = liftKey(input);
  return [...base].sort((a, b) => key(b) - key(a) || (at.get(a) as number) - (at.get(b) as number));
}

/**
 * A search's own ranking and certainty - the `order`/`certainty` pair
 * `useSearch`'s `result` carries, narrowed to the two fields a favorite
 * boost folds into.
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
 * `favoriteOrder` plus the certainty profile an active sort drives - see the
 * preamble.
 *
 * `search` carries the running search's own order/certainty pair, aligned to
 * each other and not to `base` (which may already be filtered for blocked
 * tags), so this module does the id -> certainty crossing itself, the way
 * `liftKey` crosses id -> filename.
 */
export function favoriteSort(
  base: number[],
  input: FavoriteSortInput,
  search: SearchCertainty | null = null
): FavoriteSortResult {
  const order = favoriteOrder(base, input);

  if (input.mode === 'relevance' || input.mode === 'random') {
    // Certainty passes through with the same array identity `favoriteOrder`
    // keeps for `'relevance'`, so a caller memoising on identity sees no
    // change. `'random'` shares the branch because a shuffle carries no
    // confidence claim - see the preamble.
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
function liftKey({ mode, files, counts, mine, randomSeed }: FavoriteSortInput): (id: number) => number {
  if (mode === 'mine') return (id: number) => (mine.has(files[id]?.file ?? '') ? 1 : 0);
  if (mode === 'random') return (id: number) => prng(seedFrom(`${randomSeed ?? 0}:${id}`))();
  return (id: number) => counts[files[id]?.file ?? ''] ?? 0;
}

/** How many of `mine` this corpus has rooms for - what the sort would move to the front. */
export function favoriteCount(files: { file: string }[], mine: ReadonlySet<string>): number {
  return files.reduce((n, room) => n + (mine.has(room.file) ? 1 : 0), 0);
}
