# Favorite sort drives placement

Today a favorite sort (`'mine'`/`'count'`) is a pure re-sort of `order`
(`packages/map/favorites.ts`), applied *downstream* of the layout: `main.tsx`
memoises `layout` on `[roomCount, contentRatio, seed, total, result, config,
genericCount, genericSeed]` — search and the sliders — and `sortMode`/
`favorites` never enter it. So favorites move to the front of `order` and land
in the nearest content slots, but the **density gradient is left frozen at the
search's per-rank certainty**. A favorited-but-irrelevant room pulled to rank 0
then sits in a cell the gradient built to mean "highly confident match." That
is the bug this plan fixes, and the fix is to let an active favorite sort feed
placement the same way a search does.

This is a change to one invariant, stated three ways across `CLAUDE.md` and
`ordering.ts`: **"only a search may rebuild the layout."** It becomes **"only a
*placement-driving* signal rebuilds — a search, or an active favorite sort."**
A relevance re-sort and the shuffle button stay pure `order` swaps; they drive
nothing and must still not rebuild.

## The idea

`createLayout`'s `density.certainty` is signal-agnostic — a per-rank `[0, 1]`
array, and nothing in `ordering.ts` cares whether it came from CLIP or anywhere
else (see the `densityRamp`/`collectSlots` contract). Favorite-ness is a
legitimate certainty signal, in fact a *more* absolute one than a min-maxed CLIP
cosine: "the reader starred this" is a crisp fact, not a relative score. So we
**fold favorites into the certainty profile** rather than replacing it:

> When a favorite sort is active, every room the sort lifts to the front has its
> match certainty boosted to 1.0, composed with (not substituted for) whatever
> certainty the current search already gave it.

- **No search + `mine`**: certainty is 1 for the reader's favorites, 0 for the
  rest — a tight cluster of favorites packed against the center at peak density,
  everything else at the slider's baseline. This is the "view my favorites near
  the center" behaviour the current order-swap only half-delivers (favorites are
  near center, but scattered at baseline density with generics between them).
- **Search + `mine`**: `max(searchCertainty(room), favorited ? 1 : 0)`. A room
  the search is already sure about keeps its cluster; a favorite the search
  ranked low is *also* pulled tight, because you asked for it. The search's
  cluster is enriched by favorites, not discarded.
- **`count`**: the lifted set is rooms with a global count > 0; boost those to
  1. (Scaling by normalised count instead of a flat boost is a possible later
  refinement — start with the flat boost, which matches "sorted to the front =
  confident about it" exactly.)

The rule in one line: **the boost applies to exactly the rooms `favoriteOrder`
lifts.** Whatever got moved forward is what the map is now confident about —
order and density can never drift, because one is derived from the other.

### Monotonicity is satisfied for free

`densityRamp` requires certainty non-increasing with rank and clamps with a
running minimum. The boosted profile is already monotone: the lifted rooms sit
at the front at 1.0, and the trailing rooms keep their search-relevance order
(a stable sort preserves it) whose certainty was already non-increasing and is
≤ 1.0. Even if a corner case dipped, the running-min clamp corrects it. No new
constraint.

## Work

### 1. `packages/map/favorites.ts` — emit certainty alongside order

`favoriteOrder` currently returns `number[]`. Add a sibling (or widen it) that
also returns the boosted per-rank certainty aligned to the order it produced.
Because certainty enters as per-*rank* today (`result.certainty[i]` is the
certainty of `result.order[i]`), the caller hands in a per-room lookup and this
module does the crossing, exactly as it already crosses id → filename for
favorites:

```ts
export interface FavoriteSortResult {
  order: number[];
  /** per rank, aligned to `order`; null when nothing drives density */
  certainty: Float32Array | null;
}
```

- Build a per-room certainty from the search: `base.forEach((id, i) => byRoom.set(id, searchCertainty[i]))`.
- After sorting, `certainty[newRank] = max(byRoom.get(order[newRank]) ?? 0, lifted(order[newRank]) ? 1 : 0)`.
- `'relevance'` returns `{ order: base, certainty: searchCertainty }` untouched
  (same array identity when nothing sorted, preserving the memo short-circuit).
- No search + `'relevance'` returns `certainty: null` — the uniform map, exactly
  as `result?.certainty ? … : null` gives today.
- Keep `favoriteCount` as-is.

Convert `favorites.test.mjs` → `favorites.test.ts` in the same commit (the
module is already `.ts`; the paired test converting with it is the standing
rule). Assert the boosted profile is monotone and that `mine`/`count` boost the
right set; assert `relevance` passes certainty through by identity.

### 2. `packages/web/src/main.tsx` — let the sort into the layout memo

- Compute the favorite sort **once**, producing `{ order, certainty }`, and feed
  `certainty` into `createLayout`'s `density`:
  ```ts
  density: sortCertainty
    ? { ...config.search.density, certainty: sortCertainty }
    : null,
  ```
  where `sortCertainty` is the boosted profile when a favorite mode is active,
  else `result?.certainty ?? null`.
- Add `sortMode` and `favorites.sortInput` to the `layout` memo deps. This is
  the crux: toggling a favorite while sorted by favorites, or switching into a
  favorite mode, now rebuilds placement.
- The catalog's `catalogOrder` keeps only the `order` half — density is map-only
  and the catalog never rendered it, so nothing there changes and the two views
  still share `order`.

### 3. "Re-apply the search" on a live favorite toggle

Toggling a favorite while a favorite mode is active should recompute order +
certainty and animate — the user's framing is "treat a favorite toggle like
re-applying the current search (or lack of one)." Search ranking is cheap
(O(tokens × keywords)), so this is affordable per toggle. In `relevance` mode a
toggle changes no placement — only the badge repaints, no slide. The
`animateNext`/`requestAnimation` request already gates this; wire the favorite
toggle to request an animation only when a favorite mode is active.

### 4. Camera: zoom out in place, don't fly home

The fly-home (`flyTo(0, 0, defaultZoom)` in `startRearrangement`) recenters
*and* zooms out. The recenter is unnecessary — a normal search is already at the
center, and a favorite toggle should leave the reader where they are. Replace
the "park at center" behaviour with **zoom out in place**:

1. Ease zoom to `Math.min(cam.zoom, defaultZoom)` at the *current* `x`/`y`
   (`flyTo(cam.x, cam.y, target)`), so we widen the view to give the slide a
   wall of rooms without moving the reader. If the reader is already at or below
   `defaultZoom`, this is a no-op and the slide runs immediately.
2. Run the slide against the parked (zoomed-out) camera — `buildRearrangement`
   already accepts any rectangle.
3. Ease zoom back to `returnZoom` at the same `x`/`y`.

This collapses the current two-mode split (`parkAtCenter` true = fly home,
false = stay put): there is now one behaviour, "zoom out in place," and the
`parkAtCenter` flag / its fly-home branch in `useRearrangement.ts` can go. The
`returnZoom !== target` guard that skips the redundant zoom-back stays.

**Tradeoff, stated deliberately:** a reader who searches while panned far from
center now keeps that position, so the central cluster forming may be partly or
wholly off their screen (the slide there falls back to instant via
`buildRearrangement` returning null, which is already handled). The common case
— searching from the center tile's own controls — is unaffected and is the
design target. If this reads wrong in practice, the fallback is to recenter
*only* when the camera is outside the content region, but do not add that until
it's shown to be needed.

## Invariant/doc updates

- `CLAUDE.md` "Re-ranking swaps one array; only a search may move slots" and
  "A sort is a re-rank … must never rebuild the layout" — generalise both to
  "a search **or an active favorite sort**." The shuffle button and a relevance
  re-sort stay pure swaps.
- `CLAUDE.md` "While flying home to start a rearrangement…" and the reorder
  animation's "The center room is the planner's fixed tile" / "The board is
  finite only because the camera is parked on the center" — the board is finite
  because the camera is *parked*, at whatever position; drop "on the center."
  The center room stays the planner's fixed *value* (same in both boards), which
  is unrelated to where the camera is.
- `ordering.ts` module comment ("Re-ranking after a search swaps one array")
  and `favorites.ts` module comment ("A sort mode is not a search") — both now
  overstate the split; a favorite sort *is* a placement input. Rewrite to the
  generalised invariant.
- `ordering.test.mjs` asserts slot stability under reorder — keep it for the
  reorders that don't drive placement (shuffle, relevance re-sort) and add
  coverage that a favorite mode *does* re-derive density.

## Out of scope / non-goals

- Filtering to only favorites (rejected in `favorites.ts` for the same reason as
  before — a near-empty library is not a library).
- Count-scaled density (flat boost first; revisit if the cluster reads flat).
- Any change to how the catalog orders or renders — density is map-only.
