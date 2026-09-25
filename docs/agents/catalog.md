# The catalog

Hazards for coding agents working on the catalog view and its switch with
the map. `AGENTS.md`'s "Things that will bite you" routes here, and its
conventions still apply.

## The catalog, and the two modes

- **The map is hidden, never unmounted.** `.map-view` toggles between
  `display: contents` and `display: none`, and the render loop returns early
  when `mode !== 'map'`. A remounted canvas comes back with no pointer
  listeners, because `useMapCamera`'s listener effect reads
  `canvasRef.current` only when it runs, and none of its dependencies is the
  element: the HUD still reads correctly and the map never pans again. `catalog.e2e.ts`'s "the map is where it was left when the
  catalog closes" drags after a mode switch to catch this. Hiding also keeps
  the tile caches warm.
- **A room's permalink is its title, and `packages/map/slug.ts` decides it
  for every caller.** The server, the sitemap and the overlay's copy-link
  button all read `buildSlugTable`. A room's filename stem is a permanent
  alias that redirects to the title url, so links survive a retitle. A room
  id never reaches a path, since ids are positional. Two rooms with the
  same title each get their stem as a suffix, and `roomContent.ts` warns at
  startup.
- **The catalog is not the accessibility mode.** It is a control offered to
  everyone: nothing detects a screen reader or defaults into it, and
  `role="application"` stays scoped to the canvas. The map's ranked results
  list is debug-only for now (#238).
  The catalog is a `<ul>`, not a listbox, because its rows contain keyword
  chips.
- **One live region for the whole app, outside both views,** so a mode
  switch can't unmount it. `.note` holds only the static hint and must never
  share a node with `role="status"`.
- **Rows are a fixed height and the spacers are arithmetic, not
  estimates.** `spacerHeight` stands in for unmounted pages to the pixel, so
  recycling a page never moves the scroll position. Anything that makes row
  heights vary - expanding a story in place, letting chips grow the row -
  turns the spacers into estimates. A row is a fixed-height flow area plus
  the score strip below it, so match strength is never pushed off the card.
  The center room's row is the exception, sized to its content outside the
  paging arithmetic. `catalog.ts`, `CatalogView.tsx` and `style.css`'s
  `.catalog-flow`/`.score-strip` comments carry the layout mechanics.
- **A room row's thumbnail floats, and the story wraps around it.** So the
  story is cut by a measured `max-height`/`overflow: clip`, not
  `-webkit-line-clamp` (whose block formatting context would stop the
  wrap), and "did this row cut something" asks the story's own
  `scrollHeight`, not the card's. The center room's row can't float: its
  picture and spines share one CSS grid so both land on the same column
  lines. `style.css`'s `.catalog-row .story` comment has the details.
- **What a row cannot show, it counts.** `chipLines` sizes the chip box from
  the row's real leftover height, and whatever doesn't fit becomes a `+N`
  chip (`RoomDetails`'s `chipOverflow`) that opens the room. The counter is
  absolutely positioned and skipped when counting, since it is rendered from
  a measurement of the box it sits in.
- **A fixed row cannot show everything, so the overlay is not optional.**
  `RoomOverlay` shows the full tile and story, reached from the thumbnail and
  from a clipped story's "read the rest". `TEXT_CHROME_PX` reserves room for
  that button on every row, including rows that don't show one, or it is
  clipped away on the narrow displays that need it.
- **Pagination and infinite scroll are one primitive with a different
  window.** Both slice `pageOf`; pagination passes `windowPages: 0`, so a
  room sits at the same position however the reader pages. `windowFor`
  widens the window when a screenful spans more pages than the budget
  mounts.
- **Highlighting mirrors the match rules.** `scoring.ts` has two range
  finders beside the scorers - substring for keywords and titles, prefix for
  story words - fed the same folded query and tokens the ranking used, so a
  token that didn't score can't mark. `useSearch`'s `highlight` is the only
  source of "what matched"; don't re-derive it in a component. Only a real
  title is marked, never the "Room N" fallback.
- **Folded offsets are not source offsets.** NFD, mark-stripping and
  lowercasing change length, so highlighting maps positions through
  `scoring.ts`'s `foldWithMap`. A folded index used on the original text
  misplaces every mark on accented text.
- **The CLIP row of a score breakdown must show its raw cosine.**
  `breakdown.clip` is min-maxed per query, so some room scores 1.00 even for
  `cghjj`. `explainRanking` prints the raw cosine beside it, with strength
  on its own line.
- **Namespace catalog CSS.** `.row` belongs to the dev panel, so an
  unprefixed `.row` rule reaches into its slider rows. The reverse also
  bites: the panel's global `button { flex: 1 }` stretches any button the
  catalog doesn't opt out. `.chips`, `.story`, `.picture` and `.score` are
  shared by design, from `RoomDetails`.
- **The query length cap is enforced in `search()`, not the input.**
  `maxLength` covers only typing; a keyword chip, a shelf book and a restored
  history entry all call `search()` directly. Scoring is O(tokens x keywords)
  per room, so an uncapped paste stalls the page.
