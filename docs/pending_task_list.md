# The Index of Babel — pending task list

What is still to do, and nothing else. Remove a task as it is completed — the
code and the git log are the record of what was.

## Paper-chrome pass:
The palette is now warm dark-leather with cream `.paper-sheet` cards floating on
it (see the color/texture commits). The remaining problem is that the DOM chrome
still mixes light-on-dark controls with the dark-on-cream cards, which reads as
awkward. Direction decided: move the chrome onto paper too, rather than either
leaving the mix or turning the whole background cream (which would kill the
floating-paper effect). Scope is everything DOM, both modes — the one exception
is the painted center-shelf book spines, which are canvas art and stay as they
are. Notes that will bite: `.paper-sheet` locally rebinds `--dim`/`--ink`/
`--edge`, and the gold accent washes out on cream, so paper controls take
`--paper-accent` (the focus ring / favorited-star already do). Pieces:
- **Buttons and search bars → paper background + ink text**, matching the
  catalog history's shelf-link look. Covers the catalog top-bar controls, the
  map-mode ranked panel's controls, AND the diegetic center-tile search input.
  The center input sits over a brass panel in the tile art, so paper should work
  there with at most minor adjustment - confirm on the real center tile.
- **Short text labels → small fit-to-text paper rectangles**, not stretched to
  fill. The catalog "N rooms, …" count/sort line is the type case. Fit-to-text
  (unlike the larger card blocks, which stretch) is a guess - confirm visually.
- **Catalog thumbnails → a thin paper mat** (a few px of cream around the
  image) so they stand out over the black. The right-side card height must match
  the MAT/page height, not the inner image (the cards already stretch to the
  image height today - this refines that target). Keep the mat→card gap equal to
  the current image→card gap, and do NOT let the mat's added margin widen the
  black gap between rows - that black gap stays constant. Needs a `MAT_PAD`-style
  constant priced into `CatalogView`'s `rowHeight`/spacer arithmetic, the same
  fixed-row coupling as `CARD_PAD`/`ROW_PAD`.
- **Painted map book titles stay unchanged** - the one deliberate exception.

## A11y:
- No actual screen reader testing has happened yet. Learn orca and test
  manually. See accessibility-plan.md for more details on what to check, and
  other lingering questions.
- The ranked results listbox (accessibility-plan.md §3.2) now lives in the
  dev panel, which is `?debug`-only. Give it a non-debug home before this
  matters for anyone relying on the lossless reading of a search.

## Loading indicator:
- The center-tile loading indicator (`loadingAnimation.ts`) only plays when the
  center book is on screen and legible (`useRearrangement.ts`'s `showLoading`
  gate). A rearrangement triggered from the far field - a favorite toggle or a
  relevance re-sort while browsing away from the center - shows nothing during
  its preload. Design and build a second indicator for that case (a small
  on-canvas spinner near the viewport centre, or a HUD-adjacent affordance).
  Until then the far-field preload pause is silent, same as before this feature.
- The indicator always runs at least one full cycle before the slide, so an
  on-center search now has a deliberate ~1.6s floor before the map rearranges,
  even on a warm cache. Intended (a diegetic loading beat, not just a spinner),
  but revisit if it ever feels like padding on fast searches.

## Hosting:
- The Cloudflare abuse protection in `infra/abuse-protection.tf` only scopes
  `assets_hostname` (the R2 bucket). `/api/search` is a much better DoS target
  than static asset serving - it's CPU-bound ML inference on an unprotected
  origin. Add a second ruleset (rate limit + short-TTL cache keyed on the
  query string) scoped to the app's hostname for that endpoint specifically.

## Security:
- **The query length cap is enforced in the browser only.** `useSearch.ts`
  slices to `config.search.maxQueryLength` and both inputs carry `maxLength`,
  but `/api/search` reads `req.query.q` without checking it — a direct GET
  hands an arbitrarily long string to the CLIP tokeniser and then keys the LRU
  cache on it, and that cache bounds entries, not bytes. Enforce the same cap
  server-side.

## CI:
- **Nothing builds the `Dockerfile`.** It exists so hosting can move without a
  rewrite, and it will drift out of step with `package.json` unnoticed until
  the day that matters. A build-only job is enough — no push, no registry.

## The public face:
- **Nothing tells a visitor what the site stores.** Favoriting mints a token in
  `localStorage` and sends it to the server, and the whole shape of
  `favorites.ts` is an argument about refusing to spy on people — an argument
  no reader can currently see. A short paragraph in `HelpDialog` would say it.
- **The library cannot be found from outside itself.** No `<meta
  name="description">`, no Open Graph or Twitter card, no `robots.txt`, no
  sitemap, and `/favicon.ico` answers 204 while `index.html` links one. Nothing
  is server-rendered either, so a crawler or a link unfurler sees an empty
  `<div id="root">` and a shared URL previews as bare text. A server-rendered
  catalog page closes both without touching the map — and discoverability is
  the reason the catalog exists (concept.md, 8/22/26).
- **`README.md` describes a center tile that no longer exists** — "5 shelves ×
  32 books = 160 books", abandoned in concept.md's 8/18/26 entry — and its
  "What it is" section is still a TODO while the site is live at the URL
  printed above it.

## Corpus loading:
- **A corpus that half-loads says nothing.** All three fetches in
  `useCorpus.ts` end in `.catch(() => {})`, so a missing `metadata.json` or
  `embeddings.bin` — a plausible result of an interrupted `tools/upload` sync —
  renders a library that searches and ranks with quietly degraded results. The
  manifest fetch has an error state; these deserve one too, or at least a line
  in the HUD.

## Favorites:
- `favorites.e2e.ts` covers the map badge and the in-place resort that follows
  a toggle while sorted by favorites. The catalog side is still uncovered: a
  spec favoriting a room from a catalog ROW, switching the sort and reloading
  would close the remaining half of the path.
- The JSON store is one file written by one process. If a second process ever
  serves this corpus, that is the moment for the Postgres adapter behind
  `FavoriteStore` rather than a lock on the file.

## Search:
- **The int8 quantisation scale is stated twice, once on each side of
  `embeddings.bin`** — `QUANT_SCALE` in `tools/embed/embed.ts` writes it,
  `EMBEDDING_SCALE` in `packages/map/ordering.ts` reads it, both 127, with no
  import binding them. Ranking is immune to a drift between them (a monotone
  factor cannot reorder), so the symptom would be `matchCertainty` reading the
  wrong absolute cosine and the density gradient clustering at the wrong
  confidence. `embeddings.json` already records `scale` and nothing reads it
  back — carrying it through the manifest removes the constant from the client
  entirely.

## Rendering:
- **WebGL is the default renderer** (`webglFlag.ts`'s `DEFAULT_WEBGL`), with
  `?webgl=0` as the Canvas2D escape hatch and a `supportsWebGL2()` probe that
  falls back automatically. Canvas2D is still a full second renderer, kept in
  lockstep (see AGENTS.md's "The WebGL renderer") and covered by
  `render-parity.parity.ts`. Open question, no work scheduled: whether to
  eventually retire Canvas2D. Retiring it drops the parity suite, the
  `?webgl=0` hatch, and the whole `render.ts`/`slide.ts` path - worth doing
  only once WebGL has real production mileage and nothing has needed the hatch.

## Rearrangement / camera:
- **[2026-09-10] A `flyTo` issued while a rearrangement is animating has no
  effect, and a search can sometimes trigger what looks like a SECOND full
  rearrangement cycle with no further user action.** Found while chasing
  flakiness in `map-gestures.e2e.ts`'s `right-clicking a room opens its
  card`/`a long press opens the card` tests (both click the 'center' button,
  then `landed()`, then act on a fixed screen point - see AGENTS.md's
  Testing-and-CI note on `recentre()`, added as the practical fix for the
  test suite).

  Confirmed by direct instrumentation (a page-injected HUD-transition
  recorder plus a `page.on('request')` listener during a run of `a search
  reorders the library around wherever the camera already is` followed by
  `right-clicking a room…`):
  - Exactly ONE `/api/search` request fires for the one Enter press (ruled
    out a duplicate submit).
  - `useSearch.ts`'s `search()` only calls `requestAnimationRef.current(...)`
    once per resolved fetch for a non-empty term (read the source; only one
    branch executes).
  - Despite that, the HUD shows a full `rearranging · preparing…` → `100%`
    cycle landing back at the search field's camera position, and then -
    with ZERO clicks or other interaction - a SECOND full `preparing…` →
    `100%` cycle starts within ~150ms and runs for ~1.5-3s more.
  - A plain `button[hasText=center].click()` issued during (or just before)
    that second cycle has NO effect on the final camera position - it lands
    exactly where the rearrangement itself was already headed, not at the
    clicked target. `landed()` still reports "settled" because it only
    checks for two consecutive stable reads, which a still-controlled camera
    also produces.

  Not yet root-caused. Candidates not yet ruled out: something downstream of
  `setResult` (e.g. `sortResult`/`layout`'s `useMemo` in `main.tsx`, or
  `pushHistory`) causing `useRearrangement.ts`'s effect to see `layout`/
  `order` change twice for one `requestAnimation()` call; a legitimate
  second animated pass that isn't a bug at all (e.g. a graded/clustered
  density recompute) but should then update the "rearranging" HUD text or
  `AGENTS.md`'s invariants to say so explicitly; or `startRearrangement`
  itself re-triggering under some condition on a small/cold-cache corpus.
  Worth an instrumented repro (the recorder script used above, not
  committed) as the starting point rather than re-discovering this from
  scratch.

  Separately, whether this is a bug or not, `useMapCamera.ts`'s `flyTo`
  currently has no way to interrupt an active rearrangement - AGENTS.md's
  "Camera and gestures" section documents `pointerdown`/`wheel` each
  dropping an in-flight flight, and the rearrangement section documents
  "Anything that moves the camera mid-rearrangement (pan, zoom, `flyTo`)
  must end the animation instead" - but a `flyTo` from a control (not a
  gesture) does not currently do this. Confirm whether that's the intended
  reading of the invariant and, if so, wire `flyTo` to end an active
  rearrangement the same way a pointer grab does.
