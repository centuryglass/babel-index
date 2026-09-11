# The Index of Babel — implementation plan

Pending task list. Remove tasks as they are completed, the code and git logs will
serve as completed task history.

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
- Although I intend to host it in my VPS, dockerizing it for the sake of
  making future hosting changes easier would be a good idea.

## Favorites:
- `favorites.e2e.ts` covers the map badge and the in-place resort that follows
  a toggle while sorted by favorites. The catalog side is still uncovered: a
  spec favoriting a room from a catalog ROW, switching the sort and reloading
  would close the remaining half of the path.
- The JSON store is one file written by one process. If a second process ever
  serves this corpus, that is the moment for the Postgres adapter behind
  `FavoriteStore` rather than a lock on the file.

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
