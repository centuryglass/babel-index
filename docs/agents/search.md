# Search

Hazards for coding agents working on search ranking and the density gradient
it drives. `AGENTS.md`'s "Things that will bite you" routes here, and its
conventions still apply.

## Search and the density gradient

- **One number, `strength`, both places a room and sets the density around
  it.** `rankHybrid` sorts by it, so there is no second ranking score to
  reconcile. A rule about which signal wins (an exact tag over CLIP, a long
  story run over CLIP) holds because of `config.search.weights`, and
  `scoring.test.ts` checks each one on a built query: re-tuning a weight
  means re-running those tests, not re-deriving an inequality.
- **Search combines its signals; it does not tier them.** Tiering keyword
  hits ahead of everything would let one weak partial beat a room CLIP is
  confident about.
- **A query is matched term by term and as one whole string, and the better
  reading wins.** `rankHybrid` classifies each term against a room's
  keywords and title, then the whole folded query the same way, so a
  multi-word tag typed plainly (`outsider art`) is an exact match. A keyword
  chip searches its text unquoted, and many real keywords are multi-word. A
  whole-query match counts as one exact match, so two separate exact tags
  still outrank one matched phrase.
- **Keyword partials divide by the keyword; story matches count words.**
  `art` matches only 3/11 of `art nouveau`, and a hit in a long story is
  worth the same as in a short one.
- **The density gradient is one formula**, not special cases for cluster,
  falloff and no-match: a linear ramp from the baseline at `floor` to `peak`
  at `peakAt`, clamped at both ends (`ordering.ts`'s `densityRamp`), walking
  outward. Strength must stay non-increasing with rank, and anything at or
  under `floor` is the baseline; both are asserted.
- **`search.density.peakAt` tracks `search.weights.clip`.** A CLIP-only room
  never exceeds that weight, so re-tuning the weight without `peakAt` changes
  whether a genuine image match packs solid.
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
- **Every pull is absolute; never normalise one across the corpus.**
  Min-max puts some room at 1 for *any* query, and a gradient driven by that
  clusters nonsense as confidently as an exact match. CLIP reads its raw
  cosine against absolute bounds (`CLIP_STRENGTH`, config
  `search.density.clipCentre/High`).
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
