# WebGL renderer: hardening plan

The gap between the `webgl-test` branch's spike (commit `8ab3808`) and a
renderer worth eventually defaulting to, and the steps to close it. Delete a
phase's items as they land - git history is the record of what was done, this
is only what's left. See `AGENTS.md`'s "The WebGL renderer (experimental)"
section for the standing invariants once Phase A lands (this doc is the
work queue; that section is the rules that keep it from regressing).

## Why

The spike measurably works - the rearrangement slide dropped from
~3.6-4.0ms/frame to ~0.2-0.3ms/frame, confirmed smooth on Android Firefox
(`docs/performance-research.md` §9.5-9.7's worst-case environment). It was
built fast, as a PoC, and two real problems surfaced on review, not just
style nits: `useMapRendererGL.ts`'s effect rebuilds the entire GL context
(new shader program/VAO/buffer, nothing old ever freed) on almost every app
state change, and the texture cache never frees GPU memory. Both are the
kind of thing that doesn't show up in a five-minute demo and does show up in
a real session.

Nothing in this plan changes `render.ts`, `slide.ts`, `tiles.ts`,
`pyramid.ts`, or `packages/map/*`'s existing behavior. The one exception
(Phase C) adds a single **optional** callback to `useRearrangement.ts` that
does nothing when omitted.

## Phase A - fix the resource lifecycle (blocks everything below) — DONE

- [x] `gl/context.ts`: `dispose()`, `gl.getError()` check after setup,
      `maxTextureSize` queried once, `UNPACK_FLIP_Y_WEBGL`/
      `UNPACK_PREMULTIPLY_ALPHA_WEBGL` set explicitly (not left to defaults).
- [x] `useMapRendererGL.ts`: split into a canvas-lifetime effect
      (`[canvasRef, cache]` deps - context/renderer/slideRenderer created
      exactly once) and a `latestRef` (assigned during the render body, not
      inside an effect, so it's always fresh regardless of effect order) for
      everything that legitimately changes often. A small second effect
      calls `draw.current()` when any of those values actually change.
      Verified: a search, a clear, and a second search no longer tear down
      the GL runtime (checked visually + no console errors across the
      sequence).
- [x] Context-loss handling in the same canvas-lifetime effect -
      `webglcontextlost`/`webglcontextrestored`, `render()` skips the frame
      while the runtime ref is null. Verified by forcing
      `WEBGL_lose_context`'s `loseContext()`/`restoreContext()` in a real
      browser: both events fire, the map fully redraws after restore.

## Phase B - texture cache eviction — DONE

- [x] `gl/textureCache.ts`: `WeakMap` → `Map` + frame counter + `beginFrame()`
      + budget-gated eviction calling `gl.deleteTexture`, mirroring (not
      reusing) `tiles.ts`'s own frame-aware LRU rule.
- [x] Max-texture-size guard: skip the upload (fall back to the blank fill)
      and warn once if a bitmap exceeds `gl.maxTextureSize`, instead of a
      silent broken/garbled upload.

## Phase C - fix the flight-phase regression — DONE

The spike's flight phase got *slower* under WebGL (~0.8-1.1ms → ~2.7-3.1ms
p50, with 28-64ms stalls) because textures upload lazily on first draw,
exactly during the flight - even though `useRearrangement.ts`'s
`prepareRearrangement` already fetches+decodes every tile the animation will
need before the camera moves.

- [x] `useRearrangement.ts`: `onPreparing?(ids: ReadonlySet<number>, level: number): void` on `UseRearrangementOpts`, fired once per prepare right after
      the `applyMove` simulation builds its `ids` set.
- [x] New `gl/warm.ts`: `warmGLTextures(ids, level, cache, gl, textures, timeoutMs)`
      polling `cache.get(id, level)` on a bounded rAF loop, pushing ready
      bitmaps through `textures.get()`.
- [x] `main.tsx`: a `warmTexturesRef`/`onPreparingGL` pair (mirroring
      `draw`'s "caller owns the ref, hook fills it in" shape) wires
      `useMapRendererGL`'s GL runtime to `useRearrangement`'s `onPreparing`,
      active only when `WEBGL` is on.
- [x] Re-measured with the `?perf&debug` vs `?perf&webgl&debug` script:
      steady-state (2nd/3rd rearrangement) flight p50 went from ~2.7-3.1ms
      (with 28-64ms stalls) to ~1.6ms with a 5.1ms max and zero long tasks -
      close to the Canvas2D baseline's own ~0.9ms, while the slide phase
      keeps its ~15x win untouched. The only remaining stall (~100ms) is on
      the session's very first rearrangement (cold cache + first shader
      compile), which the Canvas2D baseline also pays a version of - not
      something this phase was meant to fix.

## Phase D - feature parity

- [x] Favorites-sort switch, distill toggle icon, clear-history overlay in
      `glRenderer.ts` - same textured-quad technique as the favorite badge,
      reusing `favoriteSwitchScreenRect`/`distillIconScreenRect`/
      `clearHistoryBookScreenRect`. Also mirrored into `glSlideRenderer.ts`'s
      own `chrome` block (`slide.ts` already draws all three on the center
      tile during a rearrangement, so the GL slide renderer needed the same
      three draw calls to keep the two lockstep, per `AGENTS.md`) via the
      same exported `drawFavoriteSwitchGL`/`drawDistillToggleGL`/
      `drawClearHistoryBookOverlayGL`.
- [x] Keyboard cursor ring - `gl/context.ts` gained `drawStrokeQuad` (four
      flat quads, not `gl.LINES` - line width >1px isn't portable) in
      Phase A; wired into `glRenderer.ts`'s draw loop. `useMapRendererGL.ts`
      gained the matching `:focus-visible` tracking `useMapRenderer.ts`
      already had (duplicated, not shared - each hook owns its own
      canvas-lifetime effect) so the ring is gated the same way in both
      renderers. `slide.ts` draws no cursor ring during a rearrangement, so
      `glSlideRenderer.ts` doesn't either.
- [ ] Hover-glow silhouettes for the favorite badge and both distill-toggle
      states, done properly (not the flat-rect approximation the spike
      shipped) - bake each traced path to a static texture once via an
      offscreen 2D canvas at the same cell-fraction coordinate space the
      path is already defined in, upload once, composite over the cell's
      screen rect only when hovered. Requires extracting `render.ts`'s
      private `traceFavoriteToggle`/`traceDistillToggle` path-walking loop
      into one new exported pure function in `svgPath.ts` that both files
      call - `render.ts`'s own two functions become thin wrappers, behavior
      unchanged, `render.test.ts` must keep passing unmodified.
- [ ] Rank-label chrome text (`#123` labels, zoom>120): **not planned** -
      dropped permanently. It would change every frame at exactly the zoom
      level where framerate matters most, defeating any texture-cache
      approach. Document this reasoning in `glRenderer.ts`'s file doc so a
      future reader doesn't "fix" the gap without re-deriving why it was
      skipped.

## Phase E - testing

- [ ] `glRenderer.test.ts` / `glSlideRenderer.test.ts`: a `fakeGLContext()`
      recording `drawFlatQuad`/`drawTexturedQuad`/`drawStrokeQuad`/`clear`/
      `resize`, mirroring `render.test.ts`'s `fakeCtx()` assertion style -
      level picked, one draw call per on-camera cell with the right dst
      rect, badge/switch/toggle/overlay gating, spine-cache key changes only
      on real change, prefetch/warm-level ordering.
- [ ] `e2e/support.ts`: `openLibrary` needs to accept extra query params (it
      hardcodes `${origin}?debug` today).
- [ ] New `e2e/webgl-map.e2e.ts` smoke spec: map draws (`#hud` starts with
      `[gl]`), a search completes and a rearrangement settles via the
      existing `settled()` convention, no console errors.
- Visual regression testing (screenshot-diffing GL vs Canvas2D at fixed
  camera positions) is a good future idea - not scoped into this pass.

## Phase F - shader files, cleanup, path to eventual default

- [ ] Move `gl/shaders.ts`'s inline strings to `gl/shaders/quad.vert`/
      `quad.frag`; `packages/server/index.ts`'s esbuild `loader` map gains
      `'.vert'`/`'.frag'` → `'text'` alongside the existing `.svg`/`.woff2`
      entries; `assets.d.ts` gains matching ambient declarations.
- [ ] One `toGLRect` helper replacing the repeated inline translation
      between `rooms.ts`'s `Rect` (`sx/sy/sw/sh`) and `gl/context.ts`'s
      `Rect` (`x/y/w/h`).
- [ ] `webglFlag.ts`: add a `supportsWebGL2()` capability probe so an
      unsupported device falls back to Canvas2D automatically instead of a
      blank canvas, plus one named `DEFAULT_WEBGL` constant (`false` for
      now) - the whole mechanism for eventually flipping the default, no
      rollout infrastructure or persisted preference needed at this scale.
      Whether Canvas2D is ever removed after that flip is a later decision.
- [x] `AGENTS.md`: the GL files are in the Layout section, and "The WebGL
      renderer (experimental)" subsection covers the standing invariants
      (mirrors `render.ts`/`slide.ts` in lockstep, GL setup happens exactly
      once per canvas lifetime, the texture cache's own eviction budget,
      rank labels permanently out of scope, where the default-flip constant
      lives) - though that last one is aspirational: `webglFlag.ts` has no
      `DEFAULT_WEBGL` or `supportsWebGL2()` yet (see the unchecked items
      below), so `AGENTS.md`'s claim that "`WEBGL` itself already folds in a
      WebGL2 capability probe" is currently false and needs fixing alongside
      that item, not before it.

## Verification, each phase

`npm run typecheck && npm run lint && npm test`, plus:
- A: long manual session (searches, favorite toggles) under `?webgl` with
  Chrome DevTools' Performance Monitor open - GPU memory should not climb
  monotonically.
- C: perfProbe re-run, flight-phase numbers.
- D: visual side-by-side against Canvas2D for every new control, plus a real
  hover check for the glow shapes.
- E: `npm test` + `npm run test:e2e`.
- Final: re-check Android Firefox smooth, same as the original spike - make
  sure none of this regressed the actual result that justified doing it.
