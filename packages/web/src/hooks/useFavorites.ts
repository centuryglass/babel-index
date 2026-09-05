/**
 * Favorites: the reader's own list, the library's global counts, and the one
 * call that changes both.
 *
 * Two different kinds of state behind one hook, which is the point - a favorite
 * is one act with two consequences. The personal list is `localStorage` and
 * never leaves the browser; the count is the server's, and the server holds
 * nothing that could reconstruct a personal list from it (see
 * `packages/server/favorites.ts`). Nothing here ever asks "what have I
 * favorited" of the server, because there is no endpoint that could answer.
 *
 * Everything is keyed by room FILENAME rather than id: ids are positional and
 * shift when the corpus grows, so a stored id would come back pointing at a
 * different room. Ids are what the rest of the app passes around, so the
 * crossing happens here, against `rooms`.
 *
 * ### Optimistic, and honest when it fails
 *
 * A toggle updates local state immediately and then tells the server. The reply
 * carries the authoritative count, which replaces the guess. A failed request
 * puts the personal list back the way it was and says so in the live region -
 * a favorite that silently did not register is the one outcome worth
 * interrupting someone for, since the whole feature is a count.
 *
 * `enabled` is false when this deployment has no store at all
 * (`manifest.favorites === null`), and every consumer reads that as "render no
 * favorite control" rather than "zero favorites".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { load, save, clear, KEYS, getOrCreateFavoriteClientId } from '../lib/persist.ts';
import type { ManifestResponse } from '../../../map/manifest.ts';

interface UseFavoritesOpts {
  manifest: ManifestResponse;
  /** the live region, for a toggle the server refused */
  setStatus: (message: string) => void;
}

export function useFavorites({ manifest, setStatus }: UseFavoritesOpts) {
  const enabled = Boolean(manifest.favorites?.enabled);

  // Mine, by filename. A Set in state rather than an array so membership is a
  // lookup at every row of the catalog; persisted as an array, since that is
  // what JSON has.
  const [mine, setMine] = useState<Set<string>>(() =>
    enabled
      ? new Set(
          load<string[]>(KEYS.favorites, [], {
            validate: (v) => Array.isArray(v) && v.every((f) => typeof f === 'string'),
          })
        )
      : new Set()
  );

  useEffect(() => {
    if (!enabled) return;
    if (mine.size) save(KEYS.favorites, [...mine]);
    else clear(KEYS.favorites);
  }, [mine, enabled]);

  // The global counts, by filename. Fetched once - a count that changes while
  // someone is reading is not worth a poll, and every toggle gets the fresh
  // number for its own room in the reply.
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Relative, like every other url this client fetches - see base-path.ts.
    fetch('api/favorites')
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled) setCounts(body?.counts ?? {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const fileOf = useCallback((id: number) => manifest.rooms[id]?.file ?? null, [manifest]);

  // Generated once per page and reused for every write - see persist.ts for
  // why the server hashes against this rather than the visitor's address.
  const clientId = useMemo(() => (enabled ? getOrCreateFavoriteClientId() : ''), [enabled]);

  const toggle = useCallback(
    async (id: number) => {
      const file = fileOf(id);
      if (!enabled || !file) return;

      const on = mine.has(file);
      const next = new Set(mine);
      if (on) next.delete(file);
      else next.add(file);
      setMine(next);
      // The optimistic count, replaced by the server's own below. Clamped at
      // zero: a stale local count must not be able to render a negative one.
      setCounts((prev) => ({ ...prev, [file]: Math.max(0, (prev[file] ?? 0) + (on ? -1 : 1)) }));

      try {
        const res = await fetch(`api/favorites/${encodeURIComponent(file)}`, {
          method: on ? 'DELETE' : 'POST',
          headers: { 'X-Favorite-Client': clientId },
        });
        if (!res.ok) throw new Error(`the library answered ${res.status}`);
        const body = await res.json();
        setCounts((prev) => ({ ...prev, [file]: body.count ?? 0 }));
      } catch (e) {
        setMine((prev) => {
          const reverted = new Set(prev);
          if (on) reverted.add(file);
          else reverted.delete(file);
          return reverted;
        });
        setCounts((prev) => ({ ...prev, [file]: Math.max(0, (prev[file] ?? 0) + (on ? 1 : -1)) }));
        setStatus(
          `the favorite could not be recorded - ${(e as Error).message}. This room is unchanged.`
        );
      }
    },
    [enabled, fileOf, mine, setStatus, clientId]
  );

  const isFavorite = useCallback((id: number) => {
    const file = fileOf(id);
    return file ? mine.has(file) : false;
  }, [fileOf, mine]);

  const countOf = useCallback((id: number) => {
    const file = fileOf(id);
    return file ? counts[file] ?? 0 : 0;
  }, [fileOf, counts]);

  // What `favoriteOrder` needs, in the shape it wants it - so a consumer sorts
  // without reaching into this hook's internals.
  const sortInput = useMemo(() => ({ files: manifest.rooms, counts, mine }), [manifest, counts, mine]);

  return { enabled, mine, counts, toggle, isFavorite, countOf, sortInput };
}
