import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, shuffledOrder } from '../../../map/ordering.ts';
import { buildRearrangement } from '../../../map/board.ts';
import { planMoves, applyMove } from '../../../map/illusion.ts';
import { buildTimeline, createSlideshow } from './slide.ts';
import { DEFAULTS } from '../../../config/config.ts';
import { createTileCache, CENTER as CENTER_TILE, type LoadableImage } from './tiles.ts';
import { CELL_ASPECT } from './camera.ts';
import { createGLSlideRenderer, type GLSlideDrawOpts } from './glSlideRenderer.ts';
import type { GLContext, Rect } from './gl/context.ts';
import type { GLTextureCache } from './gl/textureCache.ts';
import type { GlowTextureCache } from './gl/glowTexture.ts';

const TIMING = DEFAULTS.slide;
const VIEW = { x0: -4, y0: -3, x1: 5, y1: 4 };
const ZOOM = 220;

// --- the same GL fakes as glRenderer.test.ts, restated rather than shared -
// each file owns its own recording context, same as `render.test.ts` and
// `slide.test.ts` each own their own `fakeCtx()`.

interface FlatCall { x: number; y: number; w: number; h: number; color: [number, number, number, number] }
interface TexturedCall {
  img: unknown; src: Rect; texW: number; texH: number;
  x: number; y: number; w: number; h: number; alpha: number;
}

interface FakeGL extends GLContext {
  flats: FlatCall[];
  textured: TexturedCall[];
}

function fakeGLContext(): FakeGL {
  const flats: FlatCall[] = [];
  const textured: TexturedCall[] = [];
  return {
    gl: {} as WebGL2RenderingContext,
    maxTextureSize: 8192,
    flats, textured,
    resize: () => {},
    clear: () => {},
    drawFlatQuad: (dst, color) => flats.push({ x: dst.x, y: dst.y, w: dst.w, h: dst.h, color }),
    drawTexturedQuad: (texture, src, texW, texH, dst, alpha = 1) =>
      textured.push({ img: texture, src, texW, texH, x: dst.x, y: dst.y, w: dst.w, h: dst.h, alpha }),
    drawStrokeQuad: () => {},
    dispose: () => {},
  };
}

function fakeTextureCache(): GLTextureCache {
  return {
    beginFrame: () => {},
    get: (_gl, drawable) => {
      const d = drawable as { width?: number; height?: number } | null;
      if (!d) return null;
      return { texture: drawable as unknown as WebGLTexture, width: d.width ?? 0, height: d.height ?? 0 };
    },
    reset: () => {},
    dispose: () => {},
  };
}

function fakeGlowTextureCache(): GlowTextureCache {
  return { get: () => null, dispose: () => {} };
}

const FAKE_ICON_SIZE = { width: 96, height: 96 };

interface FakeImage extends LoadableImage {
  src: string;
  width: number;
  height: number;
}

/** A cache whose images are always ready, so a frame's geometry is what is under test - same as `slide.test.ts`'s own `readyCache()`. */
function readyCache() {
  const made: FakeImage[] = [];
  const cache = createTileCache({
    locateTile: (id, level) => ({ url: `/l${level}/${id}.jpg`, rect: null }),
    createImage: (): LoadableImage => {
      const img: FakeImage = { src: '', onload: null, onerror: null, bitmap: null, ...FAKE_ICON_SIZE };
      made.push(img);
      return img;
    },
  });
  cache.pin(CENTER_TILE);
  return { cache, settle: () => made.forEach((i) => { i.bitmap = i; i.onload?.(); }) };
}

const arrangement = (n: number, order: number[]) => ({
  layout: createLayout({ roomCount: n, contentRatio: 0.2, seed: 1, aspect: CELL_ASPECT }),
  order,
});

function rearrangement(n = 200, seedA = 1, seedB = 2) {
  const built = buildRearrangement({
    before: arrangement(n, shuffledOrder(n, seedA)),
    after: arrangement(n, shuffledOrder(n, seedB)),
    view: VIEW,
    aspect: CELL_ASPECT,
  });
  return { built, moves: planMoves(built.start, built.end, built.bounds, built.fixed) };
}

function world() {
  const { built, moves } = rearrangement();
  const { cache, settle } = readyCache();
  const board = { ...built.start, cells: built.start.cells.slice() };
  const show = createSlideshow({ board, moves, apply: applyMove, timing: TIMING });
  const renderer = createGLSlideRenderer({ cache, textures: fakeTextureCache(), glowTextures: fakeGlowTextureCache() });
  const cam = { x: 0.5, y: 0.5, zoom: ZOOM };
  return { built, board, show, renderer, cache, settle, cam };
}

type World = ReturnType<typeof world>;

const frame = (w: World, motions: GLSlideDrawOpts['motions'], gl: FakeGL, extra: Partial<GLSlideDrawOpts> = {}) =>
  w.renderer.draw({
    gl, width: 1920, height: 1080, dpr: 1, cam: w.cam,
    board: w.board, origin: w.built.origin, motions, ...extra,
  });

// --- one draw call per on-camera cell, at the right rect ---------------------

test('every visible cell is painted in every frame, including mid-slide', () => {
  const w = world();
  frame(w, [], fakeGLContext());
  w.settle();

  const cellPx = { x: ZOOM, y: ZOOM * CELL_ASPECT };
  for (let t = 0; t <= w.show.totalMs; t += 37) {
    const { motions } = w.show.advanceTo(t);
    const gl = fakeGLContext();
    const stats = frame(w, motions, gl);

    const covers = [...gl.textured, ...gl.flats.filter((f) => f.w <= cellPx.x + 2)];
    for (let py = 20; py < 1080; py += 120)
      for (let px = 20; px < 1920; px += 120) {
        const covered = covers.some((d) => px >= d.x && px < d.x + cellPx.x && py >= d.y && py < d.y + cellPx.y);
        assert.ok(covered, `nothing painted under (${px}, ${py}) at t=${t}`);
      }

    w.settle();
    assert.equal(frame(w, motions, fakeGLContext()).blank, 0, `still blank after settling, at t=${t}`);
  }
});

test('the center room is never drawn anywhere but the center', () => {
  const w = world();
  w.settle();
  const centreIndex = w.built.origin.y * w.built.width + w.built.origin.x;
  for (let t = 0; t <= w.show.totalMs; t += 23) {
    w.show.advanceTo(t);
    assert.equal(w.board.cells[centreIndex], 'center', `the center moved at t=${t}`);
    const elsewhere = w.board.cells.filter((v) => v === 'center').length;
    assert.equal(elsewhere, 1, `${elsewhere} center rooms on the board at t=${t}`);
  }
});

// --- the favorite badge, the sort switch, the distill toggle, the overlay ---

test('the favorite badge rides along with a sliding board, room cells only', () => {
  const w = world();
  const isFavorite = () => false;
  const cellPx = { x: ZOOM, y: ZOOM * CELL_ASPECT };
  const isBadge = (d: TexturedCall) => d.w < cellPx.x / 2;

  frame(w, [], fakeGLContext(), { favorites: { isFavorite } });
  w.settle();

  for (let t = 0; t <= w.show.totalMs; t += 41) {
    const { motions } = w.show.advanceTo(t);
    const gl = fakeGLContext();
    frame(w, motions, gl, { favorites: { isFavorite } });
    if (motions.length === 0) continue;
    assert.ok(gl.textured.some(isBadge), `no badge drawn while a line is sliding, at t=${t}`);
  }
});

test('no favorites option on the GL slide renderer means no badge at all', () => {
  const w = world();
  frame(w, [], fakeGLContext());
  w.settle();

  const gl = fakeGLContext();
  frame(w, [], gl);
  const cellPx = { x: ZOOM, y: ZOOM * CELL_ASPECT };
  for (const d of gl.textured) assert.ok(d.w >= cellPx.x / 2, 'unexpected small draw with no favorites option');
});

test('the favorites-sort switch rides along with the center room during a rearrangement', () => {
  const w = world();
  const isFavorite = () => false;
  frame(w, [], fakeGLContext(), { favorites: { isFavorite }, sortMode: 'mine' });
  w.settle();

  const hasSwitchPiece = (gl: FakeGL, id: string) =>
    gl.textured.some((d) => String((d.img as { src?: string }).src ?? '').includes(id));

  for (let t = 0; t <= w.show.totalMs; t += 41) {
    const { motions } = w.show.advanceTo(t);
    const gl = fakeGLContext();
    frame(w, motions, gl, { favorites: { isFavorite }, sortMode: 'mine' });
    assert.ok(hasSwitchPiece(gl, 'fav-center-switch-base'), `no switch base drawn at t=${t}`);
    assert.ok(hasSwitchPiece(gl, 'fav-mine-on'), `no "mine" face drawn for sortMode: 'mine' at t=${t}`);
  }
});

test('the distill toggle rides along with the center room during a rearrangement', () => {
  const w = world();
  frame(w, [], fakeGLContext(), { distillMode: true });
  w.settle();

  const hasDistillOn = (gl: FakeGL) => gl.textured.some((d) => String((d.img as { src?: string }).src ?? '').includes('distill-on'));

  for (let t = 0; t <= w.show.totalMs; t += 41) {
    const { motions } = w.show.advanceTo(t);
    const gl = fakeGLContext();
    frame(w, motions, gl, { distillMode: true });
    assert.ok(hasDistillOn(gl), `no distill toggle drawn at t=${t}`);
  }
});

test('distillMode undefined on the GL slide renderer means no distill toggle at all', () => {
  const w = world();
  frame(w, [], fakeGLContext());
  w.settle();

  const gl = fakeGLContext();
  frame(w, [], gl);
  const hasDistill = gl.textured.some((d) => String((d.img as { src?: string }).src ?? '').includes('distill'));
  assert.ok(!hasDistill, 'unexpected distill draw with distillMode omitted');
});

test('the clear-history book overlay rides along with the center room during a rearrangement', () => {
  const w = world();
  frame(w, [], fakeGLContext(), { clearHistoryAvailable: true });
  w.settle();

  const hasOverlay = (gl: FakeGL) =>
    gl.textured.some((d) => String((d.img as { src?: string }).src ?? '').includes('clear-history-book'));

  for (let t = 0; t <= w.show.totalMs; t += 41) {
    const { motions } = w.show.advanceTo(t);
    const gl = fakeGLContext();
    frame(w, motions, gl, { clearHistoryAvailable: true });
    assert.ok(hasOverlay(gl), `no clear-history book overlay drawn at t=${t}`);
  }
});

test('clearHistoryAvailable omitted on the GL slide renderer means no overlay at all', () => {
  const w = world();
  frame(w, [], fakeGLContext());
  w.settle();

  const gl = fakeGLContext();
  frame(w, [], gl);
  const hasOverlay = gl.textured.some((d) => String((d.img as { src?: string }).src ?? '').includes('clear-history-book'));
  assert.ok(!hasOverlay, 'unexpected clear-history book draw with clearHistoryAvailable omitted');
});
