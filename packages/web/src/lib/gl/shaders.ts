/**
 * One shader pair for every quad `gl/context.ts` draws. The textured tile
 * blit and the flat-color fills (blank fallback, generic fade, glow
 * fallback) share it via `u_useTexture` rather than switching programs - a
 * program bind is per-draw state, and `glRenderer.ts`'s loop is one draw
 * call per cell.
 *
 * Sources live in `shaders/quad.vert`/`quad.frag` and are pulled in as raw
 * text by esbuild's `.vert`/`.frag` loader (`packages/server/index.ts`);
 * `assets.d.ts` declares the import shape for the typechecker.
 */
import quadVert from './shaders/quad.vert';
import quadFrag from './shaders/quad.frag';

export const VERTEX_SRC = quadVert;
export const FRAGMENT_SRC = quadFrag;
