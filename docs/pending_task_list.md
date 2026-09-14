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

## The public face:
- **Nothing tells a visitor what the site stores.** Favoriting mints a token in
  `localStorage` and sends it to the server, and the whole shape of
  `favorites.ts` is an argument about refusing to spy on people — an argument
  no reader can currently see. A short paragraph in `HelpDialog` would say it.
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
- **[2026-09-14] Root-caused and fixed: the "second rearrangement cycle" was
  never real - it was `map-gestures.e2e.ts`'s own `a search reorders the
  library around wherever the camera already is` test reporting success
  before the search it triggered had even started.** That test presses Enter,
  then polls (`waitFor`) until the camera reads back exactly `atField` (where
  the search was triggered from) as proof the rearrangement finished. But
  `/api/search`'s fetch (slower still on a loaded/cold-cache container) had
  not resolved yet on the FIRST poll - so the camera was still just sitting,
  untouched, at `atField`, which is indistinguishable from "the rearrangement
  ran and eased back here." The check passed immediately, the test moved on,
  and the search's real rearrangement then ran to completion during the NEXT
  test (`right-clicking a room opens its card…`), its zoom-out flight and its
  post-slide fly-back both calling `flyTo` at moments that raced and
  sometimes beat that next test's own `recentre()`/right-click, landing the
  camera somewhere the fixed test coordinates no longer held a room. Confirmed
  by direct instrumentation (timestamped console logging of every
  `beginFlightTo`/`requestAnimation`/`startRearrangement` call plus explicit
  per-test markers, `page.on('console')`-captured): `requestAnimation`
  ("ranked by keywords") for the prior test's search fired to `t=10474`, which
  was already 90ms into the NEXT test (its `TESTMARK` at `t=10387`) - proof
  the search's own rearrangement had not even begun when the search test
  reported "ok". Fixed by making the search test wait for the HUD to actually
  report `rearranging` before waiting for it to settle back
  (`packages/web/e2e/map-gestures.e2e.ts`) - 5/5 clean runs of the whole file
  afterward in the same container that previously failed 3/4.

  Earlier investigation (now superseded, kept for context on what was ruled
  out): the two search requests, single `requestAnimationRef.current(...)`
  call, and 13-of-16 tests passing were all real observations - it was the
  interpretation ("a phantom second rearrangement") that was wrong; there was
  only ever one `startRearrangement` call per search, and its own perfectly
  ordinary zoom-out-then-fly-back was simply landing in the wrong test's
  timeline.

  Separately, still true and NOT itself a cause of this flakiness:
  `useMapCamera.ts`'s `flyTo` has no way to interrupt an active
  rearrangement's own camera control - a `flyTo` issued from a control (the
  'center' button, a keyboard nudge) while a rearrangement is mid-flight or
  mid-fly-back can be overridden by that rearrangement's next `flyTo` call,
  same as the race above but triggerable for real by a fast-clicking reader,
  not just an under-synchronized test. AGENTS.md's "Camera and gestures"
  section documents `pointerdown`/`wheel` each dropping an in-flight flight,
  and the rearrangement section documents "Anything that moves the camera
  mid-rearrangement (pan, zoom, `flyTo`) must end the animation instead" - but
  a `flyTo` from a control does not currently do this. Confirm whether that's
  the intended reading of the invariant and, if so, wire `flyTo` to end an
  active rearrangement the same way a pointer grab does.
