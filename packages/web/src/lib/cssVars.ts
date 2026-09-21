/**
 * The one declaration point for style values shared between canvas-drawn
 * chrome and plain CSS - today, only the hover glow the open book
 * (`center.ts`'s `composeSpines`, `render.ts`'s favorite-badge/distill-toggle
 * hover, `gl/glowTexture.ts`'s bake) and its CSS-DOM counterparts
 * (`.center-book.hover`, `.center-controls button.hover`,
 * `.catalog-center-book:hover` in style.css) both draw. A canvas draw call
 * needs the color as a string or float tuple at module scope; CSS needs it as
 * a custom property. Neither side can read the other's format directly, and
 * `center.ts` is asserted browser-free (`center.test.ts`), so nothing here
 * queries the DOM except `applyCssVars`, called once from `main.tsx` at
 * module scope.
 *
 * Deliberately its own file rather than living on `center.ts`: the value is
 * shared by the favorite badge and distill toggle too, which have nothing to
 * do with the center tile's own geometry.
 */
export const HOVER_GLOW_RGB: readonly [number, number, number] = [200, 169, 95];

/** `HOVER_GLOW_RGB` as a 2D canvas fill style. */
export const HOVER_GLOW_FILL = `rgba(${HOVER_GLOW_RGB.join(',')},0.28)`;
/** `HOVER_GLOW_RGB` as a 2D canvas stroke style. */
export const HOVER_GLOW_STROKE = `rgba(${HOVER_GLOW_RGB.join(',')},0.55)`;

/**
 * Push `HOVER_GLOW_RGB` into style.css's `--hover-glow-rgb` custom property,
 * so `rgba(var(--hover-glow-rgb), a)` rules stay in step with the canvas
 * constants above without restating the numbers. style.css keeps a
 * same-value literal as a no-JS fallback; this is what keeps it from
 * silently drifting once JS runs.
 */
export function applyCssVars(): void {
  document.documentElement.style.setProperty('--hover-glow-rgb', HOVER_GLOW_RGB.join(', '));
}
