# Rendering

Hazards for coding agents working on the two map renderers, WebGL and
Canvas2D. `AGENTS.md`'s "Things that will bite you" routes here, and its
conventions still apply.

## The WebGL renderer

WebGL is the default renderer; Canvas2D (`render.ts`/`slide.ts`) is the
second.

- **The renderers share a planner and differ only in their painters.**
  `framePlan.ts` (map) and `slidePlan.ts` (rearrangement) make every
  per-cell decision - pyramid level, what each cell draws, badge gating,
  overlay geometry, prefetch order - into a `drawList.ts` `DrawList`.
  `render.ts`'s `paintCanvas2D` and `glRenderer.ts`'s `paintGL` only walk it.
  - A rule change goes in the planner, once, and is unit-tested there.
  - A new primitive kind needs a case in both painters; each painter's
    `switch` ends in `assertNever`, so a missing case fails typecheck.
  - Painter behavior (blending, smoothing, stroke placement, texture
    filtering) can still drift. `npm run test:parity` catches it; run it by
    hand when touching either painter.
- **The GL painter can lose a planned image.** A tile the cache has decoded
  may not have a texture yet (`gl/textureCache.ts`). `paintGL` then draws
  the item's `fallback` and reports the cell, and the GL renderers move it
  from drawn to blank in their `DrawResult`. Planning cannot know this, so
  don't move that count into the planner.
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
