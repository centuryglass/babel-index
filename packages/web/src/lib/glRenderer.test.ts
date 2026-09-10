import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, shuffledOrder } from '../../../map/ordering.ts';
import { createGLRenderer, type GLDrawOpts, type GLDrawResult } from './glRenderer.ts';
import {
  createTileCache, CENTER, DISTILL_ON,
  type LoadableImage, type RoomId,
} from './tiles.ts';
import { CELL_ASPECT, MIN_ZOOM, MAX_ZOOM } from './camera.ts';
import { sizeOf } from './pyramid.ts';
import { BOOK_COUNT, type Slot } from './center.ts';
import type { GLContext, Rect } from './gl/context.ts';
import type { GLTextureCache } from './gl/textureCache.ts';
import type { GlowTextureCache } from './gl/glowTexture.ts';

/**
 * Records instead of drawing - the GL counterpart of `render.test.ts`'s
 * `fakeCtx()`. `flats`/`textured`/`strokes` split the same way
 * `gl/context.ts`'s three draw primitives do, so a test can tell a badge
 * (textured) from a generic-fade overlay (flat) from the cursor ring
 * (stroke) without guessing from a shared list's shape.
 */
interface FlatCall { x: number; y: number; w: number; h: number; color: [number, number, number, number] }
interface TexturedCall {
  img: unknown; src: Rect; texW: number; texH: number;
  x: number; y: number; w: number; h: number; alpha: number;
}
interface StrokeCall { x: number; y: number; w: number; h: number; width: number; color: [number, number, number, number] }

interface FakeGL extends GLContext {
  flats: FlatCall[];
  textured: TexturedCall[];
  strokes: StrokeCall[];
  resizes: { w: number; h: number; dpr: number }[];
  clears: [number, number, number, number][];
}

function fakeGLContext(): FakeGL {
  const flats: FlatCall[] = [];
  const textured: TexturedCall[] = [];
  const strokes: StrokeCall[] = [];
  const resizes: { w: number; h: number; dpr: number }[] = [];
  const clears: [number, number, number, number][] = [];
  return {
    // Never dereferenced by this file's tests - nothing here hovers a badge/
    // toggle (the flat-rect glow fallback needs no real `gl.gl`) or passes
    // `centreSlots` (spine compositing needs a real `document`, unavailable
    // under `node --test` - see `gl/spineTexture.ts`'s own guard - so it is
    // out of scope here the same way `map-gestures.e2e.ts` calls out CDP
    // touch injection as a known blind spot).
    gl: {} as WebGL2RenderingContext,
    maxTextureSize: 8192,
    flats, textured, strokes, resizes, clears,
    resize: (w, h, dpr) => resizes.push({ w, h, dpr }),
    clear: (r, g, b, a) => clears.push([r, g, b, a]),
    drawFlatQuad: (dst, color) => flats.push({ x: dst.x, y: dst.y, w: dst.w, h: dst.h, color }),
    drawTexturedQuad: (texture, src, texW, texH, dst, alpha = 1) =>
      textured.push({ img: texture, src, texW, texH, x: dst.x, y: dst.y, w: dst.w, h: dst.h, alpha }),
    drawStrokeQuad: (dst, width, color) => strokes.push({ x: dst.x, y: dst.y, w: dst.w, h: dst.h, width, color }),
    dispose: () => {},
  };
}

/**
 * `createGLTextureCache`'s real implementation only accepts a real
 * `ImageBitmap` (see that file's doc), which does not exist under
 * `node --test`. This stand-in hands back a "texture" that IS the drawable
 * itself, so a test can recognise which tile/icon a draw call carries the
 * same way `render.test.ts` reads a recorded `drawImage`'s own `img`.
 */
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

/** No offscreen canvas in Node, same reason `gl/glowTexture.ts` needs `document` - every hover falls back to the flat-rect glow, which is what these tests assert on. */
function fakeGlowTextureCache(): GlowTextureCache {
  return { get: () => null, dispose: () => {} };
}

const FAKE_ICON_SIZE = { width: 96, height: 96 };

interface FakeImage extends LoadableImage {
  src: string;
  width: number;
  height: number;
}

function fakeImages() {
  const made: FakeImage[] = [];
  return {
    made,
    createImage: (): LoadableImage => {
      const img: FakeImage = { src: '', onload: null, onerror: null, bitmap: null, ...FAKE_ICON_SIZE };
      made.push(img);
      return img;
    },
    settleAll: () => made.forEach((i) => { i.bitmap = i; i.onload?.(); }),
    urls: () => made.map((i) => i.src),
    levelsRequested: () =>
      made.map((i) => Number(/^\/l(\d+)\//.exec(i.src)?.[1])).filter((n) => !Number.isNaN(n)),
  };
}

const ROOMS = 400;

function world({ concurrency = 4 }: { concurrency?: number } = {}) {
  const images = fakeImages();
  const cache = createTileCache({
    locateTile: (id, level) => ({ url: `/l${level}/${id}.jpg`, rect: null }),
    createImage: images.createImage,
    concurrency,
  });
  cache.pin(CENTER);
  const layout = createLayout({ roomCount: ROOMS, contentRatio: 0.2, seed: 1, aspect: CELL_ASPECT });
  return {
    images,
    cache,
    layout,
    order: shuffledOrder(ROOMS, 1),
    renderer: createGLRenderer({ cache, textures: fakeTextureCache(), glowTextures: fakeGlowTextureCache() }),
  };
}

type World = ReturnType<typeof world>;

const frame = (
  w: World,
  { zoom, x = 0, y = 0, dpr = 1, gl = fakeGLContext(), ...rest }:
    { zoom: number; x?: number; y?: number; dpr?: number; gl?: FakeGL } & Partial<GLDrawOpts>
): GLDrawResult =>
  w.renderer.draw({
    gl, width: 1600, height: 900, dpr,
    cam: { x, y, zoom }, layout: w.layout, order: w.order, ...rest,
  } as GLDrawOpts);

// --- level selection --------------------------------------------------------

test('the far-out view draws the coarsest level, not the source art', () => {
  const w = world();
  const stats = frame(w, { zoom: MIN_ZOOM });
  assert.ok(stats.cells > 2000, `expected a big screen, got ${stats.cells}`);
  for (const level of w.images.levelsRequested()) assert.equal(level, stats.level);
});

test('zoomed all the way in, the source art is what gets drawn', () => {
  const w = world();
  assert.equal(frame(w, { zoom: MAX_ZOOM, dpr: 2 }).level, 0);
});

// --- one draw call per on-camera cell, at the right rect ---------------------

test('every on-camera cell draws exactly one textured quad once its art has landed, at the tile\'s own screen rect', () => {
  const w = world();
  frame(w, { zoom: 220 }); // nothing resident: requests everything
  w.images.settleAll();

  const gl = fakeGLContext();
  const stats = frame(w, { zoom: 220, gl });
  assert.equal(stats.blank, 0);

  const tileDraws = gl.textured.filter((d) => d.w > 100 || d.h > 100);
  assert.equal(tileDraws.length, stats.cells, 'one tile-sized draw per on-camera cell');

  // The screen rect handed to the shader is in DEVICE pixels and lines up
  // with `gl.resize()`'s own viewport size - a cell one to the right of the
  // camera sits exactly one cell width further along `x`.
  const rects = new Map(tileDraws.map((d) => [`${d.x},${d.y}`, d]));
  assert.ok(rects.size > 1, 'expected more than one distinct on-screen rect');
});

test('a room with only a coarse tile is drawn coarse, and counted as substituted', () => {
  const w = world();
  frame(w, { zoom: MIN_ZOOM });
  w.images.settleAll();

  const stats = frame(w, { zoom: 400 });
  assert.equal(stats.blank, 0);
  assert.equal(stats.drawn, stats.cells);
  assert.equal(stats.substituted, stats.cells, 'every one of them was a stand-in');
});

test('nothing resident draws the blank fallback, never a missing quad', () => {
  const w = world();
  const gl = fakeGLContext();
  const stats = frame(w, { zoom: 220, gl });
  assert.equal(stats.blank, stats.cells);
  assert.equal(gl.textured.filter((d) => d.w > 100 || d.h > 100).length, 0);
  assert.ok(gl.flats.length >= stats.cells, 'every blank cell got a flat fill');
});

// --- the favorite badge, the sort switch, the distill toggle, the overlay ---

test('the favorite badge draws on every room cell, and only room cells', () => {
  const w = world();
  const isFavorite = (id: number) => id === w.order[0];
  const cam = { zoom: 220, x: 0.5, y: 0.5 };

  frame(w, { ...cam, favorites: { isFavorite } });
  w.images.settleAll();

  const gl = fakeGLContext();
  const stats = frame(w, { ...cam, gl, favorites: { isFavorite } });

  let rooms = 0;
  for (let gy = stats.bounds.y0; gy <= stats.bounds.y1; gy++)
    for (let gx = stats.bounds.x0; gx <= stats.bounds.x1; gx++) {
      const cell = w.layout.roomAt(gx, gy, w.order);
      if (!cell.center && !cell.generic) rooms++;
    }
  assert.ok(rooms > 0, 'expected at least one room cell in view');

  const badgeDraws = gl.textured.filter((d) => /^\/l0\/fav-(on|off)\.jpg$/.test((d.img as { src?: string }).src ?? ''));
  assert.equal(badgeDraws.length, rooms, 'one badge per room cell, none for center/generic');
});

test('no favorites option draws no badge and no favorites-sort switch', () => {
  const w = world();
  frame(w, { zoom: 220 });
  w.images.settleAll();

  const gl = fakeGLContext();
  frame(w, { zoom: 220, gl });
  for (const d of gl.textured)
    assert.ok(!String((d.img as { src?: string }).src).includes('fav-'), 'unexpected favorite art with favorites omitted');
});

test('distillMode undefined draws no distill toggle at all', () => {
  const w = world();
  frame(w, { zoom: 220 });
  w.images.settleAll();

  const gl = fakeGLContext();
  frame(w, { zoom: 220, gl });
  for (const d of gl.textured)
    assert.ok(!String((d.img as { src?: string }).src).includes('distill'), 'unexpected distill art with distillMode omitted');
});

test('the distill toggle draws whichever face matches distillMode, once its art has landed', () => {
  const w = world();
  frame(w, { zoom: 220, distillMode: true });
  w.images.settleAll();

  const gl = fakeGLContext();
  frame(w, { zoom: 220, gl, distillMode: true });
  const on = gl.textured.filter((d) => (d.img as { src?: string }).src === `/l0/${DISTILL_ON}.jpg`);
  assert.equal(on.length, 1);
});

test('the clear-history book overlay draws only once the last shelf slot asks to forget history', () => {
  const w = world();
  const centreSlotsForget: (Slot | null)[] = Array(BOOK_COUNT).fill(null);
  centreSlotsForget[BOOK_COUNT - 1] = { kind: 'override', text: 'forget searches', action: 'forgetHistory' };

  frame(w, { zoom: 220, centreSlots: centreSlotsForget });
  w.images.settleAll();

  const gl = fakeGLContext();
  frame(w, { zoom: 220, gl, centreSlots: centreSlotsForget });
  assert.ok(gl.textured.some((d) => String((d.img as { src?: string }).src).includes('clear-history-book')));

  const glWithout = fakeGLContext();
  frame(w, { zoom: 220, gl: glWithout, centreSlots: Array(BOOK_COUNT).fill(null) });
  assert.ok(!glWithout.textured.some((d) => String((d.img as { src?: string }).src).includes('clear-history-book')));
});

// --- the keyboard cursor ring -------------------------------------------------

test('the keyboard cursor draws a stroke ring only when passed, and only on screen', () => {
  const w = world();
  const slot = w.layout.slots[0];
  const cam = { x: slot.x + 0.5, y: slot.y + 0.5, zoom: 220 };

  const gl = fakeGLContext();
  frame(w, { ...cam, gl, cursor: { x: slot.x, y: slot.y } });
  assert.equal(gl.strokes.length, 1, 'a cursor on screen must draw exactly one ring');

  const noCursor = fakeGLContext();
  frame(w, { ...cam, gl: noCursor });
  assert.equal(noCursor.strokes.length, 0, 'no cursor argument must draw no ring at all');

  const offscreen = fakeGLContext();
  frame(w, { ...cam, gl: offscreen, cursor: { x: slot.x + 10000, y: slot.y + 10000 } });
  assert.equal(offscreen.strokes.length, 0, 'a cursor far off screen must not be drawn');
});

// --- rule 2: load ahead -------------------------------------------------------

test('a ring outside the viewport is warmed, behind everything visible', () => {
  const w = world({ concurrency: 1000 });
  const stats = frame(w, { zoom: 200 });

  const wanted = new Set<RoomId>();
  for (let gy = stats.bounds.y0; gy <= stats.bounds.y1; gy++)
    for (let gx = stats.bounds.x0; gx <= stats.bounds.x1; gx++)
      wanted.add(w.layout.roomAt(gx, gy, w.order).id);

  assert.ok(w.images.made.length > wanted.size, 'nothing beyond the visible cells was warmed');
});

test('warming reaches one level coarser, never finer', () => {
  const w = world({ concurrency: 1000 });
  const stats = frame(w, { zoom: 200 });
  const levels = new Set(w.images.levelsRequested());

  assert.ok(levels.has(stats.level), 'the visible level must be fetched');
  assert.ok(levels.has(stats.level + 1), 'the next level out must be warmed');
  assert.ok(!levels.has(stats.level - 1), 'nothing finer than the visible level');
});

test('prefetching cannot outrun the visible pass', () => {
  const w = world({ concurrency: 2 });
  const stats = frame(w, { zoom: MIN_ZOOM });

  const visibleUrls = w.images.urls().slice(0, stats.cells);
  assert.ok(
    visibleUrls.every((u) => u.startsWith(`/l${stats.level}/`)),
    'a prefetch was issued before the visible pass finished'
  );
});

test('the tile size the level implies actually matches the cell on screen', () => {
  const w = world();
  for (const zoom of [MIN_ZOOM, 40, 90, 200, 500, MAX_ZOOM]) {
    for (const dpr of [1, 2]) {
      const stats = frame(w, { zoom, dpr });
      const tile = sizeOf(stats.level);
      const needed = zoom * dpr;
      assert.ok(
        tile.w >= needed || stats.level === 0,
        `zoom ${zoom} dpr ${dpr}: level ${stats.level} is ${tile.w}px for a ${needed}px cell`
      );
    }
  }
});
