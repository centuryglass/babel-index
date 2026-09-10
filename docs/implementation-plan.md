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
- **[2026-09-10] WebGL map renderer: remaining validation before flipping
  `webglFlag.ts`'s `DEFAULT_WEBGL` to `true`.** The renderer (`glRenderer.ts`/
  `glSlideRenderer.ts`/`useMapRendererGL.ts`, gated behind `?webgl`) is
  feature-complete and measurably faster (Android Firefox now smooth,
  previously the worst-case environment `docs/performance-research.md`
  documented). What's left is validation, not code:
  - Only Android Firefox and desktop Chrome/Firefox have been hands-on
    tested. iOS/Safari has a history of WebGL2 edge cases that a bare
    `supportsWebGL2()` capability check won't catch (it only rules out "no
    support at all", not "reports support, behaves wrong") - needs an actual
    device pass.
  - Visual regression coverage between the GL and Canvas2D renderers now
    exists as `packages/web/e2e/render-parity.parity.ts` (`npm run
    test:parity`, deliberately outside `npm test`/`npm run test:e2e` - needs a
    real GPU, boots two sessions). It drives both renderers to the same camera
    and asserts (a) HUD parity on every per-frame draw decision and (b) a pixel
    diff under a threshold at two fully-resolved scenes: center-zoom (spine
    legibility, books, favorite badges) and post-search (slide-renderer end
    state, clustered placement). On this GPU both scenes are deterministic at
    meanAbs ~1 / <1% strong-diff pixels; a sabotage check confirmed a
    tile-draw break spikes them to ~37 / ~50%. Still manual, not covered by the
    suite: hover-glow states, and an iOS/Safari pass. A far-zoom "overview"
    scene was intentionally left out - see that file's header for why (per-
    session cache warm-up makes far-zoom tile resolution non-deterministic).
  - GPU memory was only checked informally (a short session, DevTools open,
    "no console errors"). Worth one deliberate long session - many searches,
    favorite toggles, rearrangements - watching the memory graph rather than
    eyeballing it.

  Once those three pass, flip `DEFAULT_WEBGL`. Whether Canvas2D is ever
  removed after that is a separate, later decision.
- **[2026-09-10, resolved] The `createImageBitmap` unpack-matching fix removed
  Firefox's texture-upload CPU conversion.** A 2-minute `?webgl` Firefox
  profile (`tools/perf-capture/out`, canvas2d vs webgl, seed `babel-perf`)
  showed the CanvasRenderer thread spending ~1.2s of CPU in
  `WebGLTexelConversions::pack/unpack` + `gfx::Swizzle*_SSE2` +
  `WebGLImageConverter::run` - work the Canvas2D run does not do at all,
  sustained at ~0.3-0.38s per 10s window during tile churn. Cause: tiles were
  decoded with a bare `createImageBitmap(blob)` (default premultiplied alpha +
  colorspace conversion) but uploaded with `UNPACK_PREMULTIPLY_ALPHA_WEBGL`
  false (`gl/context.ts`), so Firefox repacked every texel on the CPU instead
  of uploading straight to the GPU. Fixed by decoding with
  `{ premultiplyAlpha: 'none', colorSpaceConversion: 'none' }` in
  `tiles.ts`'s `decodeOnThread` (also `toString()`'d into the decode worker,
  so both paths change together). Confirmed by a fresh Firefox `?webgl`
  capture (2026-09-10 11.39): all three symbols are gone from the
  CanvasRenderer thread (nothing above 5ms), whose self-time is now purely the
  NVIDIA driver upload path (`NvGlEglGetFunctions`, `libnvidia-eglcore`) and
  GPU waits - the upload goes straight through the driver, no CPU repack, and
  no color/premultiply regression (tiles are opaque). Other findings from the
  original capture needed no action - WebGL already ~halves
  JS heap (+68MB vs +168MB), main-thread CPU is a wash (~18% one core, both
  renderers), and the node/listener growth in `summary.json` is an end-of-run
  interaction spike, not a monotonic leak.

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
