/**
 * The center shelf's spine typeface - Roboto Slab, chosen after the
 * `tools/font-lab` sweep (see that tool's `docs/file_map.md` entry).
 *
 * Split from `center.ts`: `center.ts` composites titles but touches
 * no DOM (its own doc comment says so, and `center.test.ts` asserts it browser-
 * free), while loading a `FontFace` is a DOM API. `SPINE_FONT_FAMILY` is the
 * pure half - just the CSS family string `composeSpines` puts in `ctx.font` -
 * and `loadSpineFont` is the DOM half, called once from `main.tsx`.
 *
 * The woff2 asset is imported inside `loadSpineFont`, never at module scope.
 * Node test suites import this module through `center.ts` and have no loader
 * for `.woff2`, so a static import crashes them; only the browser bundle
 * (esbuild's `dataurl` loader, `packages/server/index.ts`) resolves it.
 */

/** `ctx.font`'s family list - Georgia is the fallback while the webfont loads. */
export const SPINE_FONT_FAMILY = "'Roboto Slab', Georgia, serif";

let loaded: Promise<FontFace> | null = null;

/**
 * Load the webfont and register it on the document, once. Callers await this
 * and trigger a redraw on completion - until it resolves, `SPINE_FONT_FAMILY`
 * falls back to Georgia, so a spine composited before the font is ready is
 * legible but not final.
 */
export function loadSpineFont(): Promise<FontFace> {
  if (!loaded) {
    loaded = import('../assets/roboto-slab-400.woff2').then(({ default: robotoSlab400 }) => {
      const face = new FontFace('Roboto Slab', `url(${robotoSlab400})`, { weight: '400', style: 'normal' });
      return face.load();
    }).then((f) => {
      document.fonts.add(f);
      return f;
    });
  }
  return loaded;
}
