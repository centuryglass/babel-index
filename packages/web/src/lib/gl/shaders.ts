/**
 * One shader pair for every quad `gl/context.ts` draws - a textured tile blit
 * and a flat-color fill (the blank-cell fallback, the generic-fade overlay)
 * share it via `u_useTexture` rather than switching programs, since a program
 * bind is exactly the kind of per-draw state change §5.2's "one draw call
 * per cell" first cut wants to avoid multiplying.
 *
 * Sources live in `shaders/quad.vert`/`quad.frag` and are pulled in as raw
 * text by esbuild's `.vert`/`.frag` loader (`packages/server/index.ts`,
 * `assets.d.ts`), the same technique already used for `center.ts`'s `.svg`
 * import.
 */
import quadVert from './shaders/quad.vert';
import quadFrag from './shaders/quad.frag';

export const VERTEX_SRC = quadVert;
export const FRAGMENT_SRC = quadFrag;
