# Search

Hazards for coding agents working on search ranking and the density gradient
it drives. `AGENTS.md`'s "Things that will bite you" routes here, and its
conventions still apply.

## Search and the density gradient

- **Search blends three signals into one sort; it does not tier them.**
  Every signal is normalised to [0, 1] before weighting, and the CLIP term
  is min-maxed across the corpus for that query. Tiering keyword hits ahead
  of everything would let one weak partial beat a room CLIP is certain about.
- **A query is matched term by term and as one whole string, and the better
  reading wins.** `rankHybrid` classifies each term against a room's
  keywords and title, then the whole folded query the same way, so a
  multi-word tag typed plainly (`outsider art`) is an exact match. A keyword
  chip searches its text unquoted, and many real keywords are multi-word. A
  whole-query match counts as one exact match, so two separate exact tags
  still outrank one matched phrase.
- **Keyword partials divide by the keyword; story matches divide by the
  query.** `art` matches only 3/11 of `art nouveau`, but a hit in a long
  story is worth the same as in a short one.
- **The density gradient is one formula**
  (`contentRatio + (peak - contentRatio) * strength`, walking outward), not
  special cases for cluster, falloff and no-match. Strength must stay
  non-increasing with rank, and anything under `STRENGTH_FLOOR` snaps to the
  baseline; both are asserted.
- **Distance from the center carries one meaning at a time, so a search and
  a favorite sort are mutually exclusive** (`docs/search_requirements.md`
  SR-24, SR-27, SR-28, SR-41).
  - A real (non-empty) search ends an active favorite sort: `useSearch.ts`'s
    `search` calls `onSearchStart` before the fetch.
  - A favorite sort or `'random'` ends an active search: `changeSort` calls
    `clearSearch()` for any mode but `'relevance'`.
  - Clearing the search box (the clear-x, an empty submit) is not starting a
    search and must not touch the sort.
  - Because the two never run at once, `main.tsx`'s `sortResult` reads
    whichever strength is active (`result.strength`, or
    `packages/map/favorites.ts`'s `favoriteStrength`), and nothing composes
    the two. `'relevance'` and `'random'` claim no strength and leave the
    map uniform.
- **Strength is absolute; ranking is relative. Don't feed one the other's
  numbers.** The blend min-maxes CLIP, so some room scores 1 for *any*
  query; a gradient driven by that clusters nonsense as confidently as an
  exact match. `matchStrength` reads raw cosines against absolute bounds
  (`CLIP_STRENGTH`, config `search.density.clipCentre/High`).
- **`embeddings.bin` is keyed by row order; `metadata.json` by filename.**
  `scan.ts` rejects a blob whose row count drifted. The sidecar joins per
  file, so a partial match is just partial - but `matched: 0` against
  non-zero `entries` means the keys drifted, which `index.ts` warns about.
- **A room's optional `alt` is an image caption, not a story.** It goes on
  the real `<img alt>` (`RoomOverlay`, the catalog thumbnail) and never feeds
  the search index. The map canvas's fallback content (`RoomDetails`'s
  `showPicture`) renders it as a paragraph, since it has no `<img>`. Don't
  write placeholder captions into `assets/corpus-sample/`.
- **`tagLinks.json` is a flat keyword -> url map, not joined to anything.**
  It is hand-edited and optional; `scan.ts` only counts its keys, and a
  corpus without one renders chips with no "more about this" link.
  `RoomDetails.tsx` receives it as a prop (see `useCorpus.ts`).
