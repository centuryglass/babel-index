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

## Hosting:
- The Cloudflare abuse protection in `infra/abuse-protection.tf` only scopes
  `assets_hostname` (the R2 bucket). `/api/search` is a much better DoS target
  than static asset serving - it's CPU-bound ML inference on an unprotected
  origin. Add a second ruleset (rate limit + short-TTL cache keyed on the
  query string) scoped to the app's hostname for that endpoint specifically.
- Although I intend to host it in my VPS, dockerizing it for the sake of
  making future hosting changes easier would be a good idea.

## Favorites:
- No e2e coverage yet. A spec favoriting a room from a catalog row, switching
  the sort and reloading would cover the whole path; it needs the demo server
  the suite starts to be given a throwaway `--favorites` path.
- The JSON store is one file written by one process. If a second process ever
  serves this corpus, that is the moment for the Postgres adapter behind
  `FavoriteStore` rather than a lock on the file.

## Rendering:
- Hardening the experimental WebGL map renderer (`webgl-test` branch) toward
  production quality - see `docs/webgl-renderer-plan.md` for the phased
  work queue.

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

## Other:
- **Check the in-tile search field on an actual iOS device.** Its font size
  is whatever `.center-search input` inherits (13px, the app's body size),
  well under the ~16px that keeps iOS Safari from auto-zooming the viewport
  on focus. The page's `maximum-scale=1, user-scalable=no` viewport meta
  likely suppresses that already, but it needs testing.
