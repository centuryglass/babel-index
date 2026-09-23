# Rendering

Hazards for coding agents working on the two map renderers, WebGL and
Canvas2D. `AGENTS.md`'s "Things that will bite you" routes here, and its
conventions still apply.

## The WebGL renderer

WebGL is the default renderer; Canvas2D (`render.ts`/`slide.ts`) is the
second.

- **The two renderers are separate implementations kept in lockstep.**
  `glRenderer.ts`/`glSlideRenderer.ts` make the same per-cell decisions as
  `render.ts`/`slide.ts` (pyramid level, what each cell draws, badge gating,
  prefetch order) with `gl/context.ts`'s quad primitives. A change to either
  draw loop needs the matching change in the other. `GLDrawOpts`/
  `GLDrawResult` derive from `render.ts`'s `DrawOpts`/`DrawResult`, so a
  shape change fails typecheck. Behavior drift is caught by
  `npm run test:parity`; run it by hand when touching either loop.
- **GL setup happens once per canvas element's lifetime.**
  `gl/context.ts`'s `createGLContext` creates a new shader program, VAO and
  buffer on every call, and only its `dispose()` frees them.
  `useMapRendererGL.ts`'s canvas-lifetime effect (dependencies
  `[canvasRef, cache]`) keeps it to once. Adding a dependency that changes
  often (a search, a favorite toggle) leaks GPU resources.
- **The texture cache has its own eviction budget.** `gl/textureCache.ts`
  follows `tiles.ts`'s frame-aware LRU rule but keeps a separate budget,
  since GPU memory is a different resource from `pyramid.ts`'s decoded-byte
  budget. It is a strong `Map` with explicit eviction; a `WeakMap` would
  never free GPU handles, since garbage collection runs no cleanup code.
- **The renderer default lives in `webglFlag.ts`.** `DEFAULT_WEBGL` is
  `true`. `?webgl=0` (or `off`/`false`/`no`) forces Canvas2D, and `WEBGL`
  falls back to Canvas2D when `supportsWebGL2()` fails. The parity suite's
  Canvas2D session and readers hitting a GL glitch depend on `?webgl=0`;
  keep it while Canvas2D exists.
