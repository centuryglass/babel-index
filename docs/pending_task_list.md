# The Index of Babel — pending task list

What is still to do, and nothing else. Remove a task as it is completed — the
code and the git log are the record of what was.

## A11y:
- **A catalog row's `.catalog-tile-button` can be unclickable, intercepted by
  its own row's `.story` text** (noticed 2026-09-14 while adding
  `useContentZoom.ts`/`ZoomControls.tsx`, unrelated to that change - confirmed
  by reverting it and reproducing the same failure on unmodified `main`).
  Repro: open `/?catalog` at a 900x700 viewport, click the first row's
  `.catalog-tile-button` - Playwright (and, by the same geometry, a real
  pointer) hits the row's `<p class="story">` instead, which "intercepts
  pointer events" per its own overlap report. `.catalog-row
  .catalog-tile-button` is `float: left` specifically so the story wraps
  around it (AGENTS.md's "the story wraps around it" note), and floats sit in
  their own layer relative to normal-flow siblings - some width/viewport
  combination is apparently landing the story's box on top of the floated
  button rather than flowing around it. Not yet root-caused: unconfirmed
  whether this is a `.catalog-row`/`.catalog-body` stacking order issue, a
  float-vs-line-box quirk at this specific width, or something else - and it
  needs checking across `NARROW_PX`/`ULTRA_NARROW_PX` and a few concrete
  viewport widths before a fix is safe, not a same-pass guess.
- No actual screen reader testing has happened yet. Learn orca and test
  manually. See accessibility-plan.md for more details on what to check, and
  other lingering questions.
- The ranked results listbox now lives in the dev panel, which is
  `?debug`-only. Give it a non-debug home before this
  matters for anyone relying on the lossless reading of a search.

## Hosting:
- The Cloudflare abuse protection in `infra/abuse-protection.tf` only scopes
  `assets_hostname` (the R2 bucket). `/api/search` is a much better DoS target
  than static asset serving - it's CPU-bound ML inference on an unprotected
  origin. Add a second ruleset (rate limit + short-TTL cache keyed on the
  query string) scoped to the app's hostname for that endpoint specifically.

- **`server-nginx.conf` does not exist in this repo** (noticed 9/14/26 while
  wiring up `deploy/`). `AGENTS.md`'s "Deployment and the base path" section
  and `packages/server/index.ts`'s header both name it as the file that makes
  a subpath deployment work, quoting two specific `location` blocks from it,
  but there is no such file tracked here and it is not in `.gitignore` — it
  only ever lived on the VPS. Either commit the real thing (it is the one
  piece of the deployment still managed entirely by hand, and the one the
  workflow's public health check fails on when it is wrong) or stop pointing
  at it by name from two files. Do not reconstruct it from the AGENTS.md
  description without diffing against the live file first.
  Update [2026-09-17]: the AGENTS.md comment pass took the first half of
  "stop pointing at it by name" - AGENTS.md now calls it "the VPS's
  hand-managed nginx config" and cites `deploy/README.md`, and still quotes
  the two `location` blocks as what that config must do. The code-comment
  namings (`index.ts`, `scan.ts`, `base-path.ts`, `app.test.ts`) remain for
  the queued `packages/server` comment pass, and the commit-or-not decision
  is still open.
- **The CLIP weights cache inside `node_modules`.** transformers.js defaults
  `env.cacheDir` to `node_modules/@huggingface/transformers/.cache`, so any
  `npm ci` throws away a few hundred MB of downloaded model.
  `deploy/deploy.sh` moves it aside and back across the install, which works
  but means a deploy script knows where a dependency keeps its cache. Setting
  `env.cacheDir` to a path outside the tree where `app.ts` imports the model
  would delete that coupling, and would also let the Docker image mount the
  cache as a volume instead of re-downloading on every container start.

## CI:
- **[2026-09-17] `npm run lint` checks almost nothing of the app.** Noticed
  while verifying AGENTS.md's linting claims: the migration left zero `.js`
  and `.jsx` files under `packages/` and `tools/`, but eslint's flat-config
  default file list is `.js`/`.mjs`/`.cjs` - no config here extends it. So
  `eslint .` checks `eslint.config.js`, `deploy/health-check.mjs`,
  `build/*.mjs`, and `tools/comment-check/*.mjs` - nothing else. No
  browser-globals or react-hooks checking of `packages/web`, and no
  rule runs against any `.ts`/`.tsx`. The "Linting is minimal" list in
  `AGENTS.md` now states this plainly; the fix is deciding whether the flat
  config should lint `.ts` (a TS-parser dependency decision) or whether
  lint is Node-side-only by design. Either way the CI `lint` job is
  currently a green light over an empty room.
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

## Portfolio signal (2026-09-16):
This repo is also a software engineering portfolio piece (see AGENTS.md's new
section on this), and a reviewer skimming it fast is a different audience
than a visitor to the site. These are process/documentation gaps that matter
for that audience specifically, not things the art itself needs:
- **No CI/build status badge and no engineering framing in `README.md`.** The
  README currently reads purely as an art description — nothing signals to a
  skimming reviewer that CI/lint/typecheck/e2e are all green, or points them
  at the interesting engineering (the health-check-gated deploy, the
  rearrangement planner, the favorites set-hashing design) without making them
  excavate this file.
- **No release discipline.** `package.json` is pinned at `0.0.0`, there are no
  git tags, and no `CHANGELOG.md` — nothing visibly marks what shipped when,
  even though `deploy.yml`/`health-check.mjs` already tie a live deployment to
  an exact commit.
- **No API contract documentation.** `/api/manifest`, `/api/search`,
  `/api/favorites`, `/api/health` (see `packages/server/app.ts`) exist only as
  inline code — no OpenAPI spec, not even a short `docs/api.md` describing
  request/response shapes.
- **No standalone architecture overview for humans.** `docs/concept.md` is a
  dated design log, not a "read this in five minutes" system overview. A
  concise `ARCHITECTURE.md` — request flow, why esbuild bundles in-process,
  why the corpus lives in R2, why deploy is gated on `/api/health`'s reported
  commit — would let a reviewer assess system design without reading
  AGENTS.md end to end.
- **No production error/metrics visibility beyond `/api/health`.** There's no
  error tracking (a Sentry-class tool) or basic request metrics — only
  `logger.ts`'s structured logs and the deploy-time health check. Possibly
  legitimate overkill for a single-VPS art site, but "how do you know when
  it's broken" is a fair question from this audience.

Deliberately not listed here: adding a SAST/security-scanning workflow
(CodeQL, Dependency Review Action) alongside the existing informational
`npm audit` job — agreed as worth doing, but not yet planned or started.

## Comments and doc pointers:
- **[2026-09-17] Twenty code comments cite `accessibility-plan.md` sections that
  no longer exist** (13 files), and four more cite `docs/catalog-plan.md` §2/§7 —
  a file that does not exist at all. Both were caused by a4eb2ae ("AI
  documentation cull"), which deleted catalog-plan.md and rebuilt
  accessibility-plan.md as a "Still open" list, so `§3.2`, `§4.2a`, `§8 item 5`
  and friends resolve to nothing a reader can find. Not a code bug; a
  confident-looking lie. Fix: drop the pointer and keep the claim its sentence
  was citing — do not renumber it, since a section number into an ephemeral doc
  rots again at the next cull (see `docs/comment-refactor-plan.md` §2b's "Doc
  pointers rot fastest of all"). Reproduce with
  `grep -rn '§[0-9]\|catalog-plan' packages/ --include='*.ts*'`. The 2026-09-17
  comment pass cleared
  `packages/map/nextRoom.ts`; the rest are still-queued files the pass reaches
  anyway, so this entry is for the two that a queue position would not catch:
  `packages/web/src/main.tsx`'s pass is already ticked done and shipped holding
  `§3.2` and `§4.2b`, and `packages/map/ordering.ts`'s center-room note cites
  "docs/concept.md steps 5-6", a numbering concept.md has never used (its
  headings are dated). Same class, already-passed and about-to-be-passed.
- **[2026-09-17] Two comments cite a `pending_task_list.md` entry that has
  already shipped**: `useRearrangement.ts`'s `onPreparingChange` and
  `SearchIcon.tsx`'s `SearchOrbitSpinner` both point at "the far-field case
  `docs/pending_task_list.md`'s 'Loading indicator' entry asked for", and this
  file has no such entry — AGENTS.md documents the far-field spinner as built.
  A live TODO pointer anchored at the line it warns about is fine and gets
  cleaned up with the issue; a citation of finished work is dead text. Remove
  the citation, keep the sentence's own claim about what the component is for.
- **[2026-09-17] Two comments still call distill mode's transition a fade to
  black**: `useDistillMode.ts`'s `fadeMs` option doc ("how long the black fade
  takes") and `render.ts`'s `genericFade` doc ("distill mode's black fade over
  generic tiles"). Generic tiles now crossfade to their paired
  `assets/generic_distill` alternate — `drawGenericFade` in `render.ts` and
  AGENTS.md's "The center tile and its generic tiles" both describe it — so
  "black" names an implementation the crossfade replaced. Found while passing
  `packages/config/config.ts`, whose own copy of the claim this commit fixes;
  the two files above belong to the renderers' and hooks' batches.

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
- **[2026-09-17] The shared tiles have no pyramid.** `center_tile.png`, the
  generic tiles, and the favorite badges are served flat at level 0, so
  `main.tsx` must pin each shared id at level 0 - full resolution - and a
  zoomed-out view pays a full-res download per generic tile on screen
  (AGENTS.md, "The center tile and its generic tiles"). Generating pyramid
  levels for the shared dir through `packages/pipeline` would close it. This
  task's only previous home was a "plan §8" citation in AGENTS.md - a
  section of the deleted catalog-plan.md - until the 2026-09-17 AGENTS.md
  pass moved it here.

## Shareable permalinks:
- **[2026-09-16, done] Room permalinks already existed and were unused -**
  `packages/server/app.ts`'s `/catalog/:file` route SSRs a stable,
  filename-keyed permalink, and `main.tsx`'s `window.__INITIAL_ROUTE__`
  already booted a JS-capable visitor into it, but `RoomOverlay` had no way
  to reach the link. Fixed: a `.share-button` pinned to the paper page's own
  bottom-right corner (`RoomOverlay.tsx`'s `ShareButton`, `style.css`'s
  `.share-button`), building the same url `app.ts`'s `canonicalPath` does and
  copying it to the clipboard. Collapses to icon-only under 600px, same
  breakpoint the head's "view" link already used.
- **[2026-09-16] Add `/help` and `/about` as one-shot SSR-linkable routes,
  same pattern as `/catalog`.** Two more `app.get` routes in `app.ts`,
  each calling `renderPage` with a minimal `bodyHtml` (not full SSR content
  like the catalog list - just enough for a no-JS visitor/crawler) and an
  `initialRoute` value (`{ mode: 'help' }` / `{ mode: 'about' }`). Extend
  `window.__INITIAL_ROUTE__`'s type in `main.tsx` and open `HelpDialog` /
  `ArtistStatementOverlay` on mount when present, the same one-shot read
  `INITIAL_ROUTE` already does for catalog - no live path sync while the
  dialog is open, no back/forward handling, no router library. Motivation:
  sharing a link straight to the help page or the artist's statement without
  having to explain how to find them from `/`.
  - `/about`'s `ArtistStatementOverlay` links onward to `BabelBookOverlay`
    (a randomly generated "equivalent code" easter egg, stacked over the
    statement). Decided: add a small `/babel-book` (or similar) endpoint that
    serves the generated text directly rather than dropping the link, and add
    it to `robots.txt` (`packages/server/seo.ts`) as disallowed - it's
    infinite/generated content, not worth a crawler's time or an index entry.
    Bundle this with the `/about` work above since it's the one piece of that
    route with a real decision to make; the rest is mechanical.

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
- **[2026-09-17] `repairMultiset` takes a `start` board it never reads**
  (`packages/map/board.ts`): the signature is `(start, end, delta, geom)`, the
  body touches only `end`, `delta` and `geom`, and `buildRearrangement` still
  passes `start` at the call site. Found while passing the file's comments.
  Dropping the parameter is a code edit, which a comment pass may not make - its
  whole contract is that the verifier reports `comment-only` - so it is filed
  rather than fixed. Nothing gates it: eslint's `no-unused-vars` only reports
  arguments after the last used one, and `tsc` has no `noUnusedParameters`.
- **[2026-09-17] `slide.prepareTimeoutMs` cannot be raised above 5000ms.**
  `duration()`'s `DURATION_MAX_MS` ceiling is written for animation durations —
  "past a few seconds a camera move has stopped being a transition and become a
  wait" — and `prepareRearrangement`'s fetch budget is the one value in the
  config that *is* a wait, so the default sits exactly at the ceiling and the
  overlay can only shorten it. A slow host that wants a longer prepare (the
  Android Firefox tail in `docs/performance-research.md`'s "Measured findings"
  runs well past it) has no way to ask. Found while passing
  `packages/config/config.ts`, whose comment now states the limit rather than
  implying the budget is tunable; lifting it is a code change and a decision
  about whether `duration()` should take a separate ceiling for waits.
