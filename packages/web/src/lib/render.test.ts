import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, shuffledOrder } from '../../../map/ordering.ts';
import { createRenderer, type DrawContext, type DrawResult } from './render.ts';
import { createTileCache, CENTER, type LoadableImage } from './tiles.ts';
import { CELL_ASPECT, MIN_ZOOM, MAX_ZOOM } from './camera.ts';
import { PYRAMID, BASE_TILE, FALLBACK_LEVEL, sizeOf } from './pyramid.ts';

interface DrawnCall {
  img: LoadableImage;
  rect: { sx: number; sy: number; sw: number; sh: number } | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FillCall { x: number; y: number; w: number; h: number }
interface StrokeCall extends FillCall { colour: string | CanvasGradient | CanvasPattern }

interface FakeCtx extends DrawContext {
  drawn: DrawnCall[];
  fills: FillCall[];
  strokes: StrokeCall[];
}

/**
 * A 2d context that records instead of painting. The renderer's job is a
 * sequence of decisions - which level, which image, how many requests - and
 * every one of them is observable here without a browser.
 */
function fakeCtx(): FakeCtx {
  const drawn: DrawnCall[] = [];
  const fills: FillCall[] = [];
  const strokes: StrokeCall[] = [];
  return {
    drawn,
    fills,
    strokes,
    fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', globalAlpha: 1,
    // Either drawImage(img, dx, dy, dw, dh) or the 9-arg source-rect form
    // (img, sx, sy, sw, sh, dx, dy, dw, dh) - a sheet-backed tile uses the
    // latter, so both must be distinguishable to the test asserting on it.
    drawImage(img: LoadableImage, ...rest: number[]) {
      if (rest.length === 8) {
        const [sx, sy, sw, sh, x, y, w, h] = rest;
        drawn.push({ img, rect: { sx, sy, sw, sh }, x, y, w, h });
      } else {
        const [x, y, w, h] = rest;
        drawn.push({ img, rect: null, x, y, w, h });
      }
    },
    fillRect: (x, y, w, h) => fills.push({ x, y, w, h }),
    // Reads its own `strokeStyle` at call time, so the colour recorded is
    // whatever the caller last set - just as a real context's stroke colour
    // is read when the stroke is drawn, not when the shape is described.
    strokeRect(x, y, w, h) {
      strokes.push({ x, y, w, h, colour: this.strokeStyle });
    },
    fillText: () => {},
  };
}

interface FakeImage extends LoadableImage {
  src: string;
}

function fakeImages() {
  const made: FakeImage[] = [];
  return {
    made,
    createImage: (): LoadableImage => {
      const img: FakeImage = { src: '', onload: null, onerror: null };
      made.push(img);
      return img;
    },
    settleAll: () => made.forEach((i) => i.onload?.()),
    urls: () => made.map((i) => i.src),
    levelsRequested: () =>
      made.map((i) => Number(/^\/l(\d+)\//.exec(i.src)?.[1])).filter((n) => !Number.isNaN(n)),
  };
}

const ROOMS = 400;

function world({ only = null, concurrency = 4 }: { only?: number[] | null; concurrency?: number } = {}) {
  const images = fakeImages();
  const cache = createTileCache({
    locateTile: (id, level) =>
      only && !only.includes(level) ? null : { url: `/l${level}/${id}.jpg`, rect: null },
    createImage: images.createImage,
    concurrency,
  });
  // No generic tiles here, so every generic cell falls back to the center tile;
  // pinning it is what keeps rule 1 (never blank) true across a zoom.
  cache.pin(CENTER);
  const layout = createLayout({ roomCount: ROOMS, contentRatio: 0.2, seed: 1, aspect: CELL_ASPECT });
  return {
    images,
    cache,
    layout,
    order: shuffledOrder(ROOMS, 1),
    renderer: createRenderer({ cache }),
  };
}

type World = ReturnType<typeof world>;

const frame = (
  w: World,
  { zoom, x = 0, y = 0, dpr = 1, ctx = fakeCtx() }: { zoom: number; x?: number; y?: number; dpr?: number; ctx?: FakeCtx }
): DrawResult =>
  w.renderer.draw({
    ctx, width: 1600, height: 900, dpr,
    cam: { x, y, zoom }, layout: w.layout, order: w.order,
  });

// --- level selection --------------------------------------------------------

test('the far-out view draws the coarsest level, not the source art', () => {
  // The whole point. At MIN_ZOOM a screen is thousands of cells; drawing them
  // at level 0 is the ~22 GB of decoded bitmap the pyramid exists to avoid.
  const w = world();
  const stats = frame(w, { zoom: MIN_ZOOM });
  assert.equal(stats.level, FALLBACK_LEVEL);
  assert.ok(stats.cells > 2000, `expected a big screen, got ${stats.cells}`);
  for (const level of w.images.levelsRequested())
    assert.equal(level, FALLBACK_LEVEL, 'nothing finer should have been asked for');
});

test('zoomed all the way in, the source art is what gets drawn', () => {
  const w = world();
  assert.equal(frame(w, { zoom: MAX_ZOOM, dpr: 2 }).level, 0);
});

test('a zoomed-out frame costs a bounded number of bytes, not a bounded count', () => {
  // The regression this exists to catch: someone reintroduces a full-resolution
  // draw at every zoom and nothing else notices, because the *count* of tiles
  // is unchanged - it is the bytes behind them that explode.
  const w = world();
  const stats = frame(w, { zoom: MIN_ZOOM });
  const bytes = stats.cells * PYRAMID.bytesOf(stats.level);
  const atFullRes = stats.cells * PYRAMID.bytesOf(0);

  assert.ok(bytes < 256 * 1024 * 1024, `a far-out screen wants ${(bytes / 2 ** 20).toFixed(0)} MB`);
  assert.ok(atFullRes / bytes > 100, 'the coarsest level must be orders of magnitude cheaper');
});

test('the level holds through jitter but follows a decisive zoom', () => {
  // Hysteresis, seen from the renderer: every level change is a screenful of
  // fetches, so a trackpad wobble must not trigger one.
  const w = world();
  const boundary = sizeOf(2).w; // px per cell that sits on a level boundary
  const start = frame(w, { zoom: boundary }).level;
  for (const jitter of [0.99, 1.01, 0.98, 1.02])
    assert.equal(frame(w, { zoom: boundary * jitter }).level, start, `jitter x${jitter}`);

  assert.notEqual(frame(w, { zoom: boundary * 4 }).level, start, 'a real zoom must still cross');
});

test('demand is in device pixels, so a retina screen gets finer art', () => {
  const a = world();
  const b = world();
  assert.ok(
    frame(b, { zoom: 200, dpr: 2 }).level < frame(a, { zoom: 200, dpr: 1 }).level,
    'the same zoom at dpr 2 must select a finer level'
  );
});

// --- rule 1: never blank ----------------------------------------------------

test('every cell draws something once the generic has landed', () => {
  const w = world();
  const ctx = fakeCtx();
  frame(w, { zoom: MIN_ZOOM, ctx });        // nothing resident: all flat fill
  w.images.settleAll();

  const after = fakeCtx();
  const stats = frame(w, { zoom: MIN_ZOOM, ctx: after });
  assert.equal(stats.blank, 0, 'no cell may fail to display');
  assert.equal(after.drawn.length, stats.cells, 'every cell drew an image');
});

test('a sheet-backed hit draws with the 9-arg source-rect form', () => {
  // A sheet-packed level's tiles all live in one shared image, so the renderer
  // must slice a source rect out of it rather than drawing the whole thing.
  const images = fakeImages();
  const cache = createTileCache({
    locateTile: (id, level) => ({ url: `/sheet-${level}.jpg`, rect: { sx: 1, sy: 2, sw: 3, sh: 4 } }),
    createImage: images.createImage,
  });
  cache.pin(CENTER);
  const layout = createLayout({ roomCount: ROOMS, contentRatio: 0.2, seed: 1, aspect: CELL_ASPECT });
  const w = { images, cache, layout, order: shuffledOrder(ROOMS, 1), renderer: createRenderer({ cache }) };

  frame(w, { zoom: MIN_ZOOM }); // nothing resident yet: requests the sheet(s)
  w.images.settleAll();

  const after = fakeCtx();
  const stats = frame(w, { zoom: MIN_ZOOM, ctx: after });
  assert.equal(stats.blank, 0);
  assert.ok(after.drawn.length > 0);
  for (const d of after.drawn) assert.deepEqual(d.rect, { sx: 1, sy: 2, sw: 3, sh: 4 });
});

test('a room with only a coarse tile is drawn coarse, and counted as substituted', () => {
  const w = world();
  frame(w, { zoom: MIN_ZOOM });   // loads the coarse field
  w.images.settleAll();

  // Now zoom in. The fine tiles are requested but nothing has landed, so the
  // coarse ones must carry the frame rather than the screen going blank.
  const stats = frame(w, { zoom: 400 });
  assert.equal(stats.blank, 0);
  assert.equal(stats.drawn, stats.cells, 'every cell drew something');
  assert.equal(stats.substituted, stats.cells, 'and every one of them was a stand-in');
});

test('a flat corpus renders exactly as it did before the pyramid', () => {
  // Only level 0 on disk. Every level resolves to it, so the map still works -
  // which is what keeps "point it at a directory of images" true.
  const w = world({ only: [0] });
  frame(w, { zoom: MIN_ZOOM });
  w.images.settleAll();
  const stats = frame(w, { zoom: MIN_ZOOM });
  assert.equal(stats.blank, 0);
  for (const level of w.images.levelsRequested()) assert.equal(level, 0);
});

test('generic cells draw generic tiles, positionally and never blank', () => {
  // With generic tiles in play a generic cell is one of several ids, chosen by
  // position; the far-out field must still fill, from a handful of pinned tiles.
  const images = fakeImages();
  const cache = createTileCache({
    locateTile: (id, level) => ({ url: `/l${level}/${id}.jpg`, rect: null }),
    createImage: images.createImage,
  });
  const GENERICS = 6;
  for (let i = 0; i < GENERICS; i++) cache.pin(`generic:${i}`);
  cache.pin(CENTER);
  const layout = createLayout({
    roomCount: ROOMS, contentRatio: 0.2, seed: 1, aspect: CELL_ASPECT,
    genericCount: GENERICS, genericSeed: 3,
  });
  const renderer = createRenderer({ cache });
  const order = shuffledOrder(ROOMS, 1);
  const drawOnce = (ctx: DrawContext) =>
    renderer.draw({ ctx, width: 1600, height: 900, dpr: 1, cam: { x: 0, y: 0, zoom: MIN_ZOOM }, layout, order });

  drawOnce(fakeCtx());
  images.settleAll();
  const stats = drawOnce(fakeCtx());
  assert.equal(stats.blank, 0, 'the generic tiles fill every generic cell');

  const genericsSeen = new Set(images.urls().filter((u) => /\/generic:\d+\.jpg$/.test(u)));
  assert.ok(genericsSeen.size > 1, `expected several generic tiles on screen, saw ${genericsSeen.size}`);
});

// --- rule 2: load ahead -----------------------------------------------------

test('a ring outside the viewport is warmed, behind everything visible', () => {
  const w = world({ concurrency: 1000 });
  const stats = frame(w, { zoom: 200 });

  const wanted = new Set();
  for (let gy = stats.bounds.y0; gy <= stats.bounds.y1; gy++)
    for (let gx = stats.bounds.x0; gx <= stats.bounds.x1; gx++)
      wanted.add(w.layout.roomAt(gx, gy, w.order).id);

  // Something outside the drawn bounds was requested: that is the ring.
  assert.ok(
    w.images.made.length > wanted.size,
    'nothing beyond the visible cells was warmed'
  );
});

test('warming reaches one level coarser, never finer', () => {
  // Zooming out needs ~4x as many tiles at once and has nothing to show until
  // they land; zooming in has the coarse tile on screen already.
  const w = world({ concurrency: 1000 });
  const stats = frame(w, { zoom: 200 });
  const levels = new Set(w.images.levelsRequested());

  assert.ok(levels.has(stats.level), 'the visible level must be fetched');
  assert.ok(levels.has(stats.level + 1), 'the next level out must be warmed');
  assert.ok(!levels.has(stats.level - 1), 'nothing finer than the visible level');
});

test('prefetching cannot outrun the visible pass', () => {
  // Every visible cell is asked for before any prefetch is issued, so a
  // prefetch can never take the connection a visible tile needed.
  const w = world({ concurrency: 2 });
  const stats = frame(w, { zoom: MIN_ZOOM });

  const visibleUrls = w.images.urls().slice(0, stats.cells);
  assert.ok(
    visibleUrls.every((u) => u.startsWith(`/l${stats.level}/`)),
    'a prefetch was issued before the visible pass finished'
  );
});

test('the tile size the level implies actually matches the cell on screen', () => {
  // The selection contract, end to end: the chosen tile is never smaller than
  // the cell it is stretched over, at any zoom the camera allows.
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

test('the renderer never assumes a square cell', () => {
  // A 4:3 tile fits more rows than columns on a 16:9 screen; a renderer that
  // used `zoom` for both axes would report a square grid.
  const w = world();
  const stats = frame(w, { zoom: 100 });
  const cols = stats.bounds.x1 - stats.bounds.x0 + 1;
  const rows = stats.bounds.y1 - stats.bounds.y0 + 1;
  const drawnAspect = (900 / rows) / (1600 / cols);
  assert.ok(
    Math.abs(drawnAspect - BASE_TILE.h / BASE_TILE.w) < 0.25,
    `cells came out at aspect ${drawnAspect.toFixed(2)}, not ${(BASE_TILE.h / BASE_TILE.w).toFixed(2)}`
  );
});

test('the keyboard cursor draws a ring only when passed, and only on screen', () => {
  // `chrome: false` isolates the cursor's ring from the center room's own
  // marker - at a 1600x900 screen and this zoom the origin is easily still in
  // view of a room a couple of cells out, and chrome strokes it unconditionally.
  const w = world();
  const slot = w.layout.slots[0];
  const cam = { x: slot.x + 0.5, y: slot.y + 0.5, zoom: 220 };

  const ctx = fakeCtx();
  w.renderer.draw({
    ctx, width: 1600, height: 900, dpr: 1,
    cam, layout: w.layout, order: w.order, chrome: false,
    cursor: { x: slot.x, y: slot.y },
  });
  assert.equal(ctx.strokes.length, 1, 'a cursor on screen must draw exactly one ring');

  const noCursor = fakeCtx();
  w.renderer.draw({
    ctx: noCursor, width: 1600, height: 900, dpr: 1,
    cam, layout: w.layout, order: w.order, chrome: false,
  });
  assert.equal(noCursor.strokes.length, 0, 'no cursor argument must draw no ring at all');

  const offscreen = fakeCtx();
  w.renderer.draw({
    ctx: offscreen, width: 1600, height: 900, dpr: 1,
    cam, layout: w.layout, order: w.order, chrome: false,
    cursor: { x: slot.x + 10000, y: slot.y + 10000 },
  });
  assert.equal(offscreen.strokes.length, 0, 'a cursor far off screen must not be drawn');
});

// --- the favorite badge -----------------------------------------------------

test('the favorite badge draws on every room cell, and only room cells', () => {
  const w = world();
  const isFavorite = (id: number) => id === w.order[0];
  const cam = { x: 0.5, y: 0.5, zoom: 220 };

  w.renderer.draw({
    ctx: fakeCtx(), width: 1600, height: 900, dpr: 1,
    cam, layout: w.layout, order: w.order, favorites: { isFavorite },
  }); // requests the badge art alongside every tile
  w.images.settleAll();

  const ctx = fakeCtx();
  const stats = w.renderer.draw({
    ctx, width: 1600, height: 900, dpr: 1,
    cam, layout: w.layout, order: w.order, favorites: { isFavorite },
  });

  // One badge per non-center, non-generic cell drawn this frame - never more,
  // never for the center or a generic cell.
  let rooms = 0;
  for (let gy = stats.bounds.y0; gy <= stats.bounds.y1; gy++)
    for (let gx = stats.bounds.x0; gx <= stats.bounds.x1; gx++) {
      const cell = w.layout.roomAt(gx, gy, w.order);
      if (!cell.center && !cell.generic) rooms++;
    }
  assert.ok(rooms > 0, 'expected at least one room cell in view');

  const badgeDraws = ctx.drawn.filter((d) => d.w < 100 && d.h < 300); // the badge is tiny next to a tile
  // +1: the center tile's favorites-sort switch base plate draws small too,
  // whenever a favorite store is present - see `drawFavoriteSwitch`.
  assert.equal(badgeDraws.length, rooms + 1);
});

test('no favorites option means no badge at all', () => {
  const w = world();
  frame(w, { zoom: 220 });
  w.images.settleAll();

  const ctx = fakeCtx();
  frame(w, { zoom: 220, ctx });
  // Every drawn image is a tile-sized draw; nothing badge-sized appears.
  for (const d of ctx.drawn) assert.ok(d.w > 100 || d.h > 300, 'unexpected small draw with no favorites option');
});

test('the badge follows the same zoom scale as the tile it sits on', () => {
  const w = world();
  const isFavorite = () => false;
  w.renderer.draw({
    ctx: fakeCtx(), width: 1600, height: 900, dpr: 1,
    cam: { x: 0.5, y: 0.5, zoom: 220 }, layout: w.layout, order: w.order, favorites: { isFavorite },
  });
  w.images.settleAll();

  const at = (zoom: number) => {
    const ctx = fakeCtx();
    w.renderer.draw({
      ctx, width: 1600, height: 900, dpr: 1,
      cam: { x: 0.5, y: 0.5, zoom }, layout: w.layout, order: w.order, favorites: { isFavorite },
    });
    const badge = ctx.drawn.find((d) => d.w < 100 && d.h < 300);
    return badge!;
  };

  const small = at(110);
  const big = at(220);
  assert.ok(Math.abs(big.w / small.w - 2) < 0.05, `badge did not scale with zoom: ${small.w} -> ${big.w}`);
});
