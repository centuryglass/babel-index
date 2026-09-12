# The Index of Babel — pending task list

What is still to do, and nothing else. Remove a task as it is completed — the
code and the git log are the record of what was.

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

## CI:
- **Nothing builds the `Dockerfile`.** It exists so hosting can move without a
  rewrite, and it will drift out of step with `package.json` unnoticed until
  the day that matters. A build-only job is enough — no push, no registry.
- **Two `map-gestures.e2e.ts` tests fail in a cloud agent container (2026-09-12).**
  "right-clicking a room opens its card, and a chip searches for it" and "a long
  press opens the card, and a drag cancels it" both fail the same way:
  `locator('.overlay')` times out after 5s, i.e. the room card never opens. The
  other 13 tests in the file pass, as do `catalog`, `accessibility`, `favorites`,
  `shelf`, `artist-statement`, `keyboard-cursor` and `webgl-map` in full.

  Reproduce: `BABEL_E2E_CHROMIUM=/opt/pw-browsers/chromium node --import
  ./build/register.mjs --test --test-concurrency=1
  packages/web/e2e/map-gestures.e2e.ts`.

  Already ruled out — it is NOT a regression from any recent branch. Reproduced
  identically at three commits: `97dcca6` (the catalog chip/float work),
  `85d7555` (the merge of #160 `overlay-header-chrome`, whose name made it the
  obvious suspect — it is not), and `4df7e20` (the merge of #159, before that).
  So it predates both PRs rather than being introduced by either.

  Not yet checked, and the cheapest next step: whether these two are green on
  `main` in GitHub Actions. e2e is a merge gate, so if CI is green the fault is
  environmental — this container runs whatever Chromium sits at
  `/opt/pw-browsers/chromium` rather than the suite's pinned build, and both
  failing tests are exactly the gesture-to-overlay path AGENTS.md already flags
  as a CDP blind spot (right-click via CDP, and a synthesised long press). If CI
  is red too, bisect further back than `4df7e20` instead.

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
