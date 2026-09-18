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

## The public face:
- **Nothing tells a visitor what the site stores.** Favoriting mints a token in
  `localStorage` and sends it to the server, and the whole shape of
  `favorites.ts` is an argument about refusing to spy on people — an argument
  no reader can currently see. A short paragraph in `HelpDialog` would say it.

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

## Corpus generation:
- **[2026-09-17] The pipeline assumes one source size, and checks only that it
  is not mixed in shape.**
  `checkAspects` compares aspect ratios with a 1% tolerance, so a corpus of
  differing pixel dimensions passes, and `index.ts` takes `sizes[0]` as the
  corpus's size for the level plan it prints and for every sheet's `tileSize`;
  `scan.ts`'s `discoverLevels` makes the same assumption from the first room
  that reports a size. Two consequences, worked out on synthetic pairs:
  - Same aspect, different sizes (1024x1024 with 512x512): mostly
    self-correcting, because a level directory is named for its width and each
    source plans its own rungs, so `<width>/` still holds only that width. What
    is lost is coverage - the smaller source writes no `512/` file, so that room
    404s at the level the manifest advertises and falls back through its own
    levels (rule 1 of `pyramid.ts` absorbs that) - and the `16/` directory only
    the smaller source produces is written, never discovered, and never served.
  - Within tolerance, different heights (1024x1024 with 1024x1029, 0.5% apart):
    both write `128/`, one image 128px tall and the other 129px, and
    `writeSheets` lays them out on `sizes[0]`'s row pitch. A 16-row sheet drifts
    15px by its bottom row, and the `tileH` the manifest publishes for that
    level matches only the first source.
  Not reachable with a corpus the inpainting renders at one size, so this is a
  hole in the preflight rather than a live bug. The fix is either to require one
  exact dimension set (a second check beside the aspect check, and the cheaper
  option) or to size each sheet grid from its own members, which the sheet
  addressing in `layout.ts` cannot express today.

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
- **[2026-09-17] `slide.prepareTimeoutMs` cannot be raised above 5000ms.**
  `duration()`'s `DURATION_MAX_MS` ceiling is written for animation durations -
  "past a few seconds a camera move has stopped being a transition and become a
  wait" - and `prepareRearrangement`'s fetch budget is the one value in the
  config that *is* a wait, so the default sits exactly at the ceiling and the
  overlay can only shorten it. A slow host that wants a longer prepare (the
  Android Firefox tail in `docs/performance-research.md`'s "Measured findings"
  runs well past it) has no way to ask. Lifting it is a code change and a
  decision about whether `duration()` should take a separate ceiling for waits.
