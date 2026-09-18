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

- **The subpath deployment's nginx config is still untracked** (noticed
  9/14/26 while wiring up `deploy/`). Nothing in the repo names
  `server-nginx.conf` any more - the 2026-09-17 AGENTS.md and
  `packages/server` comment passes cleared those pointers; AGENTS.md now says
  "the VPS's hand-managed nginx config" and cites `deploy/README.md` - and no
  such file is tracked here or in `.gitignore`: it only ever lived on the
  VPS. The open decision is whether to commit the real thing: it is the one
  piece of the deployment still managed entirely by hand, and the one the
  workflow's public health check fails on when it is wrong. Do not
  reconstruct it from the AGENTS.md description without diffing against the
  live file first.
- **The CLIP weights cache inside `node_modules`.** transformers.js defaults
  `env.cacheDir` to `node_modules/@huggingface/transformers/.cache`, so any
  `npm ci` throws away a few hundred MB of downloaded model.
  `deploy/deploy.sh` moves it aside and back across the install, which works
  but means a deploy script knows where a dependency keeps its cache. Setting
  `env.cacheDir` to a path outside the tree where `app.ts` imports the model
  would delete that coupling, and would also let the Docker image mount the
  cache as a volume instead of re-downloading on every container start.

## CI:
- **Nothing builds the `Dockerfile`.** It exists so hosting can move without a
  rewrite, and it will drift out of step with `package.json` unnoticed until
  the day that matters. A build-only job is enough — no push, no registry.

## Portfolio signal (2026-09-16):
This repo is also a software engineering portfolio piece (see AGENTS.md's
section on this), and a reviewer skimming it fast is a different audience
than a visitor to the site. These are process/documentation gaps that matter
for that audience specifically, not things the art itself needs:
- **No engineering framing in `README.md`.** It has a `ci`/`codeql`/`deploy`
  status badge row now, but otherwise still reads purely as an art
  description — nothing points a skimming reviewer at the interesting
  engineering (the health-check-gated deploy, the rearrangement planner, the
  favorites set-hashing design) without making them excavate this file.
- **No API contract documentation.** `/api/manifest`, `/api/search`,
  `/api/favorites`, `/api/health` (see `packages/server/app.ts`) exist only as
  inline code — no OpenAPI spec, not even a short `docs/api.md` describing
  request/response shapes.
- **No production error/metrics visibility beyond `/api/health`.** There's no
  error tracking (a Sentry-class tool) or basic request metrics — only
  `logger.ts`'s structured logs and the deploy-time health check. Possibly
  legitimate overkill for a single-VPS art site, but "how do you know when
  it's broken" is a fair question from this audience.

## Comments and doc pointers:
- **[2026-09-17] A generic cell is named two different things in one
  dialog's chrome**: `RoomOverlay`'s card shows the visible literal "a Babel
  shelf", while the same room's accessible name comes from `describe.ts`'s
  generic `name`, "a library wall" — a screen reader announces one thing and
  the eye reads another in the same dialog. Reconciling them may be
  deliberate art-copy layering rather than drift — an art decision for the
  maintainer.

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
## Search:
- **[2026-09-18] `rankHybrid` scores the whole corpus synchronously,
  immediately before the rearrangement it triggers.** `scoring.ts`'s
  `rankHybrid` runs `embeddingScores` over the full embedding set plus
  per-room tokenization/lemmatization on the main thread, and whatever it
  costs lands as a single stall right at the start of the animation - the
  moment a dropped frame is most visible. The scoring functions are already
  pure and browser-free, which is most of the work a worker would need
  done; the complication is `useSearch` already juggles an async server
  round trip for the CLIP text tower, so adding a second async boundary
  needs care about ordering and cancellation. Not yet measured how large
  this actually is - worth profiling before committing to the worker move.

## Rendering:
- **[2026-09-18] A forced synchronous layout runs on every frame the map ever
  draws.** `useMapRenderer.ts` writes inline styles to `searchEl`/`booksEl`/
  `bookEl`/`controlsEl` and then, in the same callback, calls
  `arrowEl.getBoundingClientRect()` and `canvas.getBoundingClientRect()` -
  reading either forces the browser to flush the layout the writes just
  queued, before the frame's canvas drawing starts. `SearchOrbitArrow` always
  renders (`MapView.tsx`), so `arrowEl` is never null and this never skips.
  It costs nothing on resize/scroll, so caching both rects and refreshing
  them from a `ResizeObserver` (one on the canvas, one on the badge, since
  the badge's position can change from CSS alone) removes it entirely.
  Verifiable in Chrome DevTools' performance panel ("Forced reflow") in
  under a minute. `document.getElementById('hud')` also runs every frame in
  the same function and can be hoisted into the effect - it returns null on
  every call outside `?debug`.
- **[2026-09-18] The center shelf's spines are refit from scratch every
  frame during the zoom-out flight.** `composeSpines` (`center.ts`) calls
  `fitFontSize` and `fitText` for all `BOOK_COUNT` spines every frame -
  several `measureText` calls per spine, each preceded by a `ctx.font =`
  assignment that reparses a CSS font shorthand - even though the titles
  never change and only the scale does. A rearrangement's flight *starts*
  at the opening view, framed on the shelf, so this runs at full cost for
  the whole stretch until `areSpinesLegible` goes false partway through the
  zoom-out - a cost profile that would look exactly like "the first half of
  the zoom stutters, then smooths out." Memoize per `(text, quantized
  spine width)`; the cache is bounded by `BOOK_COUNT` and needs clearing on
  `document.fonts.ready` so a late-loading web font doesn't leave stale
  sizes.
- **[2026-09-18] Three independent rAF loops drive one frame, adding a
  one-frame lag.** During a rearrangement, `useMapCamera.ts`'s permanent
  flight/glide loop, `useRearrangement.ts`'s slideshow tick, and
  `useDistillMode.ts`'s fade loop each call `requestDraw`, which schedules
  `render` for the *next* rAF tick rather than drawing immediately - so the
  camera advances in frame N and paints for that position in frame N+1.
  Consolidating into one driver loop that steps every animator and then
  draws once is a real refactor (each subsystem currently owns its own
  motion for a documented reason - see `useMapRenderer.ts`'s own docblock).
  Low priority: it reads as latency, not as a dropped frame, so it is worth
  knowing about before attributing a stutter to something else rather than
  fixing on its own. (`useMapCamera.ts`'s idle-glide branch does call
  `prefersReducedMotion()` - and so `matchMedia` - on every tick, but that
  file's own docblock argues the cost is negligible next to what the read
  decides; leave it unless a profile says otherwise.)
- **[2026-09-18] The canvas backing store stays at full device pixel ratio
  during motion.** `useMapRenderer.ts` sizes the canvas at `min(2,
  devicePixelRatio)` at all times, so a retina display fills ~4x the pixels
  of a `dpr=1` frame on every draw, including mid-flight and mid-slide when
  a dropped frame is most visible and reduced resolution is least
  perceptible. Dropping to `dpr=1` for the duration of an animation and
  restoring it on settle needs care: resizing `canvas.width`/`height`
  reallocates the backing store (must happen once at start/end, never per
  frame, or it flashes), and a lower dpr changes `pickLevel`'s demand
  width, which can trigger a pyramid level transition - this wants
  designing together with level selection, not shipped as an isolated
  toggle.
- **[2026-09-18] Both renderers pay for a redundant full-screen clear every
  frame.** `render.ts` and `slide.ts` both start with a full-viewport
  `fillRect`, then draw a cell grid that's computed to cover the entire
  viewport anyway (including the "blank" fallback path, which fills its own
  rect). Cheap to remove, but the clear is genuinely load-bearing the
  moment a future change leaves a gap in coverage - keep it behind `DEBUG`
  or add a coverage assertion in `render.test.ts`/`slide.test.ts` rather
  than deleting it outright.
- **[2026-09-18] Several per-cell hot paths allocate on every call even
  though the answer is constant.** `rankOf` (`ordering.ts`) builds a
  `` `${x},${y}` `` template-literal string as a Map key on every call, and
  `roomAt` returns a fresh result object every time - both are called from
  the render loop's visible pass and its prefetch ring, so at coarse zoom
  that's on the order of 12,500 strings and 12,500 objects per frame.
  `genericId(i)` (`tiles.ts`) similarly builds `` `generic:${i}` `` fresh on
  every call from every generic cell every frame; since `genericCount` is
  known at load, those ids can just be interned into an array once (keeping
  `genericId(-1) === CENTER`). The `roomAt`/`rankOf` fix is less trivial:
  `RoomAtResult` is a discriminated union used well beyond the render loop,
  so removing its per-call allocation probably wants a second
  scalar-returning API for the hot path (e.g. `rankAt(x, y)` returning `-1`
  for generic) rather than a shared mutable result object, which would be a
  footgun for anything that retains it across iterations. Only matters at
  coarse zoom / far pan, not during an ordinary rearrangement.
- **[2026-09-18] The favorite badge draws and hits-tests with no zoom gate,
  which is both wasted work and a real usability bug.** `render.ts`/
  `slide.ts` call `drawFavoriteBadge` for every non-center, non-generic
  cell regardless of zoom - at a cell width of 10px the badge draws at
  roughly 1% of its native size, for no visible output, roughly doubling
  the draw calls and cache lookups of a zoomed-out frame. Separately, and
  worse, `favoriteBadge.ts`'s `favoriteHitRect` returns a real (touch-padded)
  hit rect at any size down to sub-pixel, and `main.tsx` hit-tests against
  it directly with no minimum - so a coarse-zoom tap can toggle a favorite
  on an invisible target. Gating both draw and hit-test on one shared
  legibility threshold (the center tile's controls already do this via
  `areSpinesLegible`) fixes the live sub-pixel target and the wasted draws
  together, at the cost of badges fading out when zoomed way out - which is
  a design call (an at-a-glance sense of favorited rooms across a wide
  view would need a cheaper coarse-zoom representation instead of silence,
  if that view matters).
- **[2026-09-18] The prefetch ring computes work it then throws away once
  its queue is full, and the warm pass repeats the same few ids thousands
  of times.** `render.ts`'s ring walk calls `layout.roomAt()`/`idOf()` for
  every ring cell (at coarse zoom, several thousand extra cells beyond the
  visible area) before calling `cache.prefetch`, which early-returns once
  `queue.length >= QUEUE_LIMIT` (256) - everything computed after the queue
  fills is pure waste. Separately, the warm pass iterates the whole
  `visible` array per level even though ~80% of entries at coarse zoom are
  one of a handful of generic ids. Checking remaining queue capacity before
  computing an id, and deduplicating the warm pass to walk distinct ids
  rather than cells, are both mechanical fixes - but bailing early makes
  prefetch coverage order-dependent (the ring is walked in a fixed raster
  order), so pair it with rotating the start point per frame or widening
  `QUEUE_LIMIT` to avoid always warming the same corner first.
- **[2026-09-18] The slide's non-moving field is redrawn in full every
  frame even though it cannot change.** `slide.ts` paints every cell not in
  a moving row/column on every frame; caching that "still field" to an
  offscreen canvas and blitting it, drawing only the moving lines on top,
  would help both the slide and (generalized to panning in `render.ts`) the
  zoomed-out browsing case. This is a structural change, not a quick fix:
  invalidation is the whole problem (a step absorption, a fade change, a
  hover, a badge toggle, or a tile arriving via `onLoad` at an arbitrary
  time all dirty the cache), it costs a second full-size dpr-2 backing
  store, and it complicates the `DrawContext` abstraction `render.test.ts`
  relies on to test the renderer without a browser. Worth doing only with a
  real invalidation design in hand, not as a quick win.
- **[2026-09-18] The unthrottled `pointermove` handler does several times
  the work it needs to, every event.** `useMapRenderer.ts`'s pointermove
  handler runs a `getBoundingClientRect`, three `querySelector` calls, two
  polygon point-in-shape tests, and an allocating `roomAtPoint`, and can call
  `draw.current()` up to three times - on every event, and high-rate mice/
  trackpads fire well above 60Hz. Storing the last event and processing it
  once per rAF, caching the three `querySelector` results in the effect,
  and sharing a cached canvas rect (see the forced-layout item above) would
  fix it at the cost of one imperceptible frame of hover latency.
- **[2026-09-18] Whether level 3's sheets should also move to per-file is
  an open question, not yet decided.** Level 2's sheets were unpacked
  because sheets there cost a ~94x memory amplification to save a dozen
  requests; level 3 is a less extreme but still poor trade (roughly 96MB of
  sheets against 2.6MB per-file, for 56 requests saved at a typical
  desktop viewport). The reason to hold off was to move one rung, measure,
  and decide about the next rather than committing to the whole ladder at
  once - that follow-up measurement/decision hasn't happened.
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
  levels for the shared dir through `packages/pipeline` would close it.
- **[2026-09-17] Two hover golds.** `.center-book.hover` (`style.css`) fills
  with `--accent-rgb` (196,150,84), while the canvas-side hover glows -
  `center.ts`'s `HOVER_GLOW_FILL`/`_STROKE`, `render.ts`'s
  `FAVORITE_HOVER_GLOW_FILL`/`_STROKE`, `gl/glowTexture.ts`'s bake - are
  rgba(200,169,95). Whether the open book and the
  shelf/badge/toggle hovers should carry one gold is an art decision.
- **[2026-09-17] WebGL's two `reset()` methods have no caller.**
  `GLTextureCache.reset` and `SpineTextureCache.reset` are documented "for a
  lost context", but nothing reaches them: `useMapRendererGL.ts`'s
  `webglcontextlost` handler drops the whole runtime and `setup()` rebuilds
  fresh renderers and caches on restore, and the unmount cleanup calls
  `dispose()` on every cache. Either wire the path they were designed for (a
  rebuild that reuses the renderer and its caches rather than replacing them)
  or delete the methods.
## Shareable permalinks:
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
- **[2026-09-14] A `flyTo` from a control cannot interrupt an active
  rearrangement's own camera control.** A `flyTo` issued from the 'center'
  button or a keyboard nudge while a rearrangement is mid-flight or
  mid-fly-back can be overridden by that rearrangement's next `flyTo` call -
  triggerable for real by a fast-clicking reader, not just an
  under-synchronized test. AGENTS.md's "Camera and gestures"
  section documents `pointerdown`/`wheel` each dropping an in-flight flight,
  and the rearrangement section documents "Anything that moves the camera
  mid-rearrangement (pan, zoom, `flyTo`) must end the animation instead" - but
  a `flyTo` from a control does not currently do this. Confirm whether that's
  the intended reading of the invariant and, if so, wire `flyTo` to end an
  active rearrangement the same way a pointer grab does.
- **[2026-09-18] The rearrangement's zoom-out target could go further, but
  it's blocked on animation pacing, not on rendering cost.** The
  rearrangement's zoom-out currently reuses `config.camera.minVisibleCells`
  (5), which puts it at pyramid level 0 - full-resolution 1024x768 tiles.
  Raising it to ~8 cells (level 1, 4x fewer pixels per tile) is close to
  free: the working set drops and the planner gets slightly cheaper, at the
  cost of stretching a 0.81s animation to about 1.43s. Going further (level
  2, 16x smaller tiles) needs its own animation-pacing work first: measured
  timings put a minVis-16 animation at ~3.8s and minVis-32 at ~10s, because
  more lines cross the camera and `buildTimeline` sequences them mostly
  sequentially - peak concurrent motions barely rises across that whole
  range. Running more lanes concurrently could keep it near a second while
  looking richer, but changing which stages `illusion.ts` marks `wave`
  touches the independence guarantees documented in AGENTS.md's "The
  reorder animation" and isn't a constant to twiddle casually. Any of this
  also needs its own `config.slide` constant (e.g. `zoomOutCells`) rather
  than reusing `minVisibleCells`, which is shared with the unrelated
  return-to-center view (`Home`/`End`, the center button, double-tap-back) -
  raising that one directly would zoom the reader out on every keypress,
  not just during a rearrangement.
- **[2026-09-17] `slide.prepareTimeoutMs` cannot be raised above 5000ms.**
  `duration()`'s `DURATION_MAX_MS` ceiling is written for animation durations -
  "past a few seconds a camera move has stopped being a transition and become a
  wait" - and `prepareRearrangement`'s fetch budget is the one value in the
  config that *is* a wait, so the default sits exactly at the ceiling and the
  overlay can only shorten it. A slow host that wants a longer prepare (the
  Android Firefox tail in `docs/performance-research.md`'s "Measured findings"
  runs well past it) has no way to ask. Lifting it is a code change and a
  decision about whether `duration()` should take a separate ceiling for waits.
