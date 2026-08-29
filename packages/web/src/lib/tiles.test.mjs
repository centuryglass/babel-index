import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTileCache, CENTER } from './tiles.js';
import { createPyramid } from './pyramid.js';

/**
 * A three-rung ladder with tiny budgets, so eviction is reachable in a test
 * without loading hundreds of tiles. The policy under test is the cache's, not
 * the ladder's - pyramid.test.mjs owns the ladder.
 */
const LADDER = createPyramid({
  levels: [
    { level: 0, divisor: 1, budget: 4 },
    { level: 1, divisor: 2, budget: 6 },
    { level: 2, divisor: 4, budget: 8 },
  ],
});

/**
 * A stand-in for the browser's Image. Loading is manual, so a test can hold a
 * request in flight and check that the cache does not drop it.
 */
function fakeImages() {
  const made = [];
  const createImage = () => {
    const img = { src: null, onload: null, onerror: null };
    made.push(img);
    return img;
  };
  return {
    createImage,
    made,
    urls: () => made.map((i) => i.src),
    settleAll: () => made.forEach((i) => i.onload?.()),
    settle: (url) => made.filter((i) => i.src === url).forEach((i) => i.onload?.()),
    fail: (url) => made.filter((i) => i.src === url).forEach((i) => i.onerror?.()),
    count: (url) => made.filter((i) => i.src === url).length,
  };
}

/** Every level of every room exists as its own per-file tile, unless `only` says otherwise. */
const locate = (only = null) => (id, level) =>
  only && !only.includes(level) ? null : { url: `/l${level}/${id}.jpg`, rect: null };

/** N rooms per sheet at one level; every other level is per-file (`locate`). */
const sheetLocate = (level, roomsPerSheet) => (id, lvl) => {
  if (lvl !== level) return locate()(id, lvl);
  const sheetIndex = Math.floor(id / roomsPerSheet);
  const posInSheet = id % roomsPerSheet;
  return {
    url: `/sheet-l${level}-${sheetIndex}.jpg`,
    rect: { sx: posInSheet * 10, sy: 0, sw: 10, sh: 10 },
  };
};

const build = (opts = {}) => {
  const images = fakeImages();
  const cache = createTileCache({
    locateTile: locate(opts.only),
    pyramid: LADDER,
    createImage: images.createImage,
    ...opts,
  });
  return { images, cache };
};

// --- fetching ---------------------------------------------------------------

test('a miss starts one load and returns nothing until it finishes', () => {
  const { images, cache } = build();
  let loads = 0;
  const c = createTileCache({
    locateTile: locate(), pyramid: LADDER, createImage: images.createImage, onLoad: () => loads++,
  });
  assert.equal(c.get(7, 0), null);
  assert.equal(images.made.length, 1);
  assert.equal(images.made[0].src, '/l0/7.jpg');
  assert.equal(loads, 0);

  images.settleAll();
  assert.equal(loads, 1, 'a finished load must ask for a redraw');
  assert.deepEqual(c.get(7, 0), { img: images.made[0], rect: null, level: 0 });
  assert.equal(images.made.length, 1, 'a hit must not re-request');
  assert.equal(cache.size(), 0, 'caches do not share state');
});

test('an in-flight tile is requested once, however many cells ask for it', () => {
  const { images, cache } = build();
  for (let i = 0; i < 10; i++) assert.equal(cache.get(7, 1), null);
  assert.equal(images.count('/l1/7.jpg'), 1);
  assert.equal(cache.sizeOf(1), 1);
});

test('a failed load is remembered rather than retried every frame', () => {
  const { images, cache } = build();
  cache.get(3, 0);
  images.fail('/l0/3.jpg');
  assert.equal(cache.get(3, 0), null);
  assert.equal(images.count('/l0/3.jpg'), 1, 'a 404 must not be re-requested on every draw');
});

test('a level the corpus does not have resolves to one it does', () => {
  // A flat directory of images is a valid corpus with only level 0. Asking for
  // level 2 must not fire a request that can only 404 - and must not sit there
  // waiting for a file that will never exist either.
  const { images, cache } = build({ only: [0] });
  cache.get(3, 2);
  assert.deepEqual(images.urls(), ['/l0/3.jpg'], 'the only level that exists was fetched');
});

test('a partly generated pyramid fetches the nearest rung, coarser first', () => {
  // Levels 0 and 2 on disk, 1 missing. Wanting 1 should take the coarse one:
  // cheaper, and usually already resident from the zoomed-out view.
  const { images, cache } = build({ only: [0, 2] });
  cache.get(3, 1);
  assert.deepEqual(images.urls(), ['/l2/3.jpg']);
});

// --- rule 1: never blank ----------------------------------------------------

test('the wanted level is used when it is ready, and reported as itself', () => {
  const { images, cache } = build();
  cache.get(5, 1);
  images.settleAll();
  assert.deepEqual(cache.get(5, 1), { img: images.made[0], rect: null, level: 1 });
});

test('a missing level falls back to a coarser one, and says which', () => {
  const { images, cache } = build();
  cache.get(5, 2); // load the coarse tile only
  images.settleAll();

  const hit = cache.get(5, 0);
  assert.equal(hit.level, 2, 'a coarse tile upscales to something soft but correct');
  assert.equal(hit.img.src, '/l2/5.jpg');
  // And the level actually wanted is now on its way, not abandoned.
  assert.ok(images.urls().includes('/l0/5.jpg'), 'the wanted level must still be requested');
});

test('a finer level is used only when nothing coarser exists', () => {
  const { images, cache } = build();
  cache.get(5, 0);
  images.settleAll();
  assert.equal(cache.get(5, 2).level, 0, 'memory already spent beats drawing nothing');
});

test('nothing at all is the only way to report nothing', () => {
  const { cache } = build();
  assert.equal(cache.get(5, 0), null);
});

test('a flat corpus resolves every level to level 0', () => {
  // The property that keeps "point it at a directory of images" true.
  const { images, cache } = build({ only: [0] });
  cache.get(5, 0);
  images.settleAll();
  for (const want of [0, 1, 2]) assert.equal(cache.get(5, want).level, 0, `want ${want}`);
});

// --- per-level budgets ------------------------------------------------------

test('levels never evict each other', () => {
  // Rule 1 depends on this. One global LRU would let a zoom-in flood the cache
  // with level 0 and evict the whole coarse field, so zooming back out would
  // flash blank - exactly the failure the pyramid exists to prevent.
  const { images, cache } = build();

  for (let id = 0; id < 8; id++) cache.get(id, 2); // fill the coarse field
  images.settleAll();
  assert.equal(cache.sizeOf(2), 8);

  // Now zoom in hard: far more level-0 tiles than its budget of 4.
  for (let id = 0; id < 40; id++) cache.get(id, 0);
  images.settleAll();
  for (let id = 40; id < 50; id++) cache.get(id, 0);

  assert.ok(cache.sizeOf(0) <= 4 + 10, `level 0 ran away at ${cache.sizeOf(0)}`);
  assert.equal(cache.sizeOf(2), 8, 'the coarse field must survive a zoom-in untouched');
  for (let id = 0; id < 8; id++) assert.equal(cache.get(id, 2).level, 2, `coarse ${id} was evicted`);
});

test('each level stays within its own budget, evicting least-recently-used first', () => {
  const { images, cache } = build();
  for (let id = 0; id < 4; id++) cache.get(id, 0); // exactly the budget
  images.settleAll();

  // Touch 0 and 1 so they are the freshest two, then bring in exactly two
  // newcomers. The two nobody touched are the ones that should go.
  cache.get(0, 0);
  cache.get(1, 0);
  cache.get(4, 0);
  cache.get(5, 0);
  images.settleAll();

  assert.ok(cache.sizeOf(0) <= 4, `over budget at ${cache.sizeOf(0)}`);
  for (const id of [0, 1]) assert.notEqual(cache.get(id, 0), null, `recently used ${id} was evicted`);
});

test('an in-flight load is never evicted', () => {
  // Dropping one orphans the request: the image completes, writes into an entry
  // no longer in the map, and the url is fetched again the next time it draws.
  const { images, cache } = build();
  for (let id = 0; id < 4; id++) cache.get(id, 0);
  images.settleAll();
  for (let id = 10; id < 30; id++) cache.get(id, 0);

  images.settleAll();
  for (let id = 10; id < 30; id++)
    assert.notEqual(cache.get(id, 0), null, `pending ${id} was dropped mid-flight`);
  assert.equal(images.made.length, 24, 'nothing should have been re-requested');
});

// --- frame-aware eviction ---------------------------------------------------

test('a miss part way through a frame does not evict what the frame already drew', () => {
  // The renderer walks cells row by row, so mid-frame the tiles it has already
  // drawn are the least recently used entries. A plain LRU evicts the top of
  // the screen to make room for the bottom of the same screen.
  const { images, cache } = build();
  const onScreen = [0, 1, 2, 3, 4, 5, 6, 7];

  cache.beginFrame();
  for (const id of onScreen) cache.get(id, 0);
  images.settleAll();

  cache.beginFrame();
  for (const id of onScreen) cache.get(id, 0);
  for (let id = 100; id < 108; id++) cache.get(id, 0); // new cells scrolling in
  images.settleAll();

  cache.beginFrame();
  const requests = images.made.length;
  for (const id of onScreen) assert.notEqual(cache.get(id, 0), null, `${id} blanked while on screen`);
  assert.equal(images.made.length, requests, 'a still-visible tile was evicted and refetched');
});

test('the previous frame is protected too, since eviction runs before the draw', () => {
  const { images, cache } = build();
  cache.beginFrame();
  for (let id = 0; id < 8; id++) cache.get(id, 0);
  images.settleAll();

  cache.beginFrame(); // evicts, with the whole screen one frame old
  for (let id = 0; id < 8; id++)
    assert.notEqual(cache.get(id, 0), null, `tile ${id} was dropped between frames`);
});

test('tiles that fall off screen are collected once two frames have passed', () => {
  const { images, cache } = build();
  cache.beginFrame();
  for (let id = 0; id < 12; id++) cache.get(id, 0);
  images.settleAll();
  assert.ok(cache.sizeOf(0) > 4, 'in-flight loads are allowed past the budget');

  for (const pass of [0, 1]) {
    cache.beginFrame();
    cache.get(900 + pass, 0);
    images.settleAll();
  }
  cache.beginFrame();
  assert.ok(cache.sizeOf(0) <= 4, `expected a drain back to budget, got ${cache.sizeOf(0)}`);
});

test('a pinned room survives any amount of pressure, at every level', () => {
  // A base tile is what every other cell falls back to, so evicting it to make
  // room for one more cell would break the fallback for all of them.
  const { images, cache } = build();
  cache.pin(CENTER);
  cache.get(CENTER, 2);
  images.settleAll();

  for (let id = 0; id < 40; id++) cache.get(id, 2);
  images.settleAll();
  for (let id = 40; id < 60; id++) cache.get(id, 2);

  assert.equal(cache.get(CENTER, 2).level, 2, 'the pinned base tile was evicted');
  assert.equal(images.count(`/l2/${CENTER}.jpg`), 1, 'and it must be fetched exactly once');
});

test('overBudget reports the pressure rather than hiding it', () => {
  const { images, cache } = build();
  cache.beginFrame();
  for (let id = 0; id < 10; id++) cache.get(id, 0);
  images.settleAll();
  assert.equal(cache.overBudget(), cache.sizeOf(0) - 4);
  assert.ok(cache.overBudget() > 0);
});

// --- rule 2: load ahead -----------------------------------------------------

test('prefetches are capped in flight, so they cannot crowd out a visible tile', () => {
  const { images, cache } = build({ concurrency: 3 });
  for (let id = 0; id < 20; id++) cache.prefetch(id, 1);
  assert.equal(images.made.length, 3, 'only `concurrency` may be in flight at once');

  images.settleAll();
  assert.ok(images.made.length > 3, 'and the queue drains as they land');
});

test('a queued prefetch is dropped when the frame it was queued for ends', () => {
  // It was queued for a viewport that has since moved. Working through the
  // backlog would spend the whole budget on where the camera used to be.
  const { cache } = build({ concurrency: 1 });
  cache.beginFrame();
  for (let id = 0; id < 20; id++) cache.prefetch(id, 1);
  assert.ok(cache.pendingPrefetch() > 0);

  cache.beginFrame();
  assert.equal(cache.pendingPrefetch(), 0, 'last frame’s prefetch queue must not survive');
});

test('prefetching something already here is free', () => {
  const { images, cache } = build();
  cache.get(4, 1);
  images.settleAll();
  const before = images.made.length;
  cache.prefetch(4, 1);
  assert.equal(images.made.length, before, 'a resident tile must not be re-requested');
});

test('clear drops everything', () => {
  const { images, cache } = build();
  for (let id = 0; id < 3; id++) cache.get(id, 0);
  images.settleAll();
  assert.equal(cache.size(), 3);
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.get(0, 0), null, 'a cleared tile must be fetched afresh');
});

// --- sheet-packed levels -----------------------------------------------------

test('many rooms in one sheet share exactly one fetch and one decoded image', () => {
  const images = fakeImages();
  const cache = createTileCache({
    locateTile: sheetLocate(2, 4),
    pyramid: LADDER,
    createImage: images.createImage,
  });

  for (let id = 0; id < 4; id++) assert.equal(cache.get(id, 2), null); // same sheet, all miss together
  assert.equal(images.made.length, 1, 'four rooms in one sheet cost one Image');
  assert.equal(images.urls()[0], '/sheet-l2-0.jpg');

  images.settleAll();
  for (let id = 0; id < 4; id++) {
    const hit = cache.get(id, 2);
    assert.equal(hit.img, images.made[0], `room ${id} draws from the shared sheet image`);
  }
  assert.equal(images.made.length, 1, 'settling must not have triggered a second fetch');
});

test('get() reports each room’s own rect within the shared sheet', () => {
  const images = fakeImages();
  const cache = createTileCache({ locateTile: sheetLocate(2, 4), pyramid: LADDER, createImage: images.createImage });
  cache.get(0, 2);
  cache.get(3, 2);
  images.settleAll();

  assert.deepEqual(cache.get(0, 2).rect, { sx: 0, sy: 0, sw: 10, sh: 10 });
  assert.deepEqual(cache.get(3, 2).rect, { sx: 30, sy: 0, sw: 10, sh: 10 });
});

test('a second sheet is a second fetch, independent of the first', () => {
  const images = fakeImages();
  const cache = createTileCache({ locateTile: sheetLocate(2, 4), pyramid: LADDER, createImage: images.createImage });
  cache.get(0, 2); // sheet 0
  cache.get(4, 2); // sheet 1
  assert.equal(images.made.length, 2);
  assert.deepEqual(images.urls().sort(), ['/sheet-l2-0.jpg', '/sheet-l2-1.jpg']);
});

test('evicting a sheet-backed room pointer does not refetch the still-resident sheet', () => {
  // Unlike a per-file entry, a sheet-backed pointer owns no request - dropping
  // it under per-level budget pressure must not cost a second fetch once the
  // room is asked for again, as long as the underlying sheet is still cached.
  const images = fakeImages();
  const cache = createTileCache({ locateTile: sheetLocate(2, 4), pyramid: LADDER, createImage: images.createImage });
  cache.get(0, 2);
  images.settleAll();

  // Level 2's budget is 8 room-pointers; blow well past it with rooms from
  // OTHER sheets so room 0's pointer entry is evicted, while its sheet stays
  // referenced by nothing here (only the sheet cache's own budget governs it).
  for (let id = 100; id < 140; id += 4) cache.get(id, 2);
  images.settleAll();

  const hit = cache.get(0, 2);
  assert.notEqual(hit, null, 'room 0 must still resolve - its sheet is still cached');
  assert.equal(images.count('/sheet-l2-0.jpg'), 1, 'no second fetch for a sheet already resident');
});

test('sheetBudget evicts the least-recently-used sheet once exceeded', () => {
  const images = fakeImages();
  const cache = createTileCache({
    locateTile: sheetLocate(2, 4),
    pyramid: LADDER,
    createImage: images.createImage,
    sheetBudget: 1,
    neverEvictSheetLevels: [], // isolate ordinary budget eviction from the coarsest-level exemption below
  });
  cache.get(0, 2); // sheet 0
  images.settleAll();
  cache.get(4, 2); // sheet 1 - evicts sheet 0 under a budget of 1
  images.settleAll();
  assert.equal(cache.sheetCount(), 1);

  cache.get(0, 2); // sheet 0 must be fetched again
  assert.equal(images.count('/sheet-l2-0.jpg'), 2, 'the evicted sheet was refetched');
});

test('a sheet still in use this frame survives budget pressure', () => {
  const images = fakeImages();
  const cache = createTileCache({
    locateTile: sheetLocate(2, 4),
    pyramid: LADDER,
    createImage: images.createImage,
    sheetBudget: 1,
    neverEvictSheetLevels: [], // isolate frame protection from the coarsest-level exemption below
  });
  cache.beginFrame();
  cache.get(0, 2); // sheet 0
  images.settleAll();

  cache.beginFrame();
  cache.get(0, 2); // still on screen this frame
  cache.get(4, 2); // sheet 1 arrives too
  images.settleAll();

  cache.beginFrame(); // eviction runs here, at the top of the frame
  assert.notEqual(cache.get(0, 2), null, 'a sheet drawn last frame must not be dropped');
  assert.equal(images.count('/sheet-l2-0.jpg'), 1, 'no refetch for the still-in-use sheet');
});

test('prefetching many rooms from one sheet costs one concurrency slot, not one per room', () => {
  const images = fakeImages();
  const cache = createTileCache({
    locateTile: sheetLocate(2, 4),
    pyramid: LADDER,
    createImage: images.createImage,
    concurrency: 1,
  });
  for (let id = 0; id < 4; id++) cache.prefetch(id, 2); // all four rooms, one sheet
  assert.equal(images.made.length, 1, 'one sheet fetch serves every room queued for it');

  images.settleAll();
  for (let id = 0; id < 4; id++) assert.notEqual(cache.get(id, 2), null, `room ${id} never resolved`);
});

test('the coarsest level’s sheets are never evicted, even under heavy budget pressure', () => {
  // A pan at the most-zoomed-out level crosses the whole map in a couple of
  // gestures; the whole level's sheets are few and cheap, so they should
  // cache in full and stay, rather than being warmed and dropped repeatedly.
  const images = fakeImages();
  const cache = createTileCache({
    locateTile: sheetLocate(2, 4), // level 2 is LADDER's coarsest - the default exemption applies
    pyramid: LADDER,
    createImage: images.createImage,
    sheetBudget: 1, // would evict everything down to one sheet, if not exempt
  });
  cache.get(0, 2); // sheet 0
  images.settleAll();
  cache.get(4, 2); // sheet 1 - would evict sheet 0 under an ordinary budget of 1
  images.settleAll();
  cache.get(8, 2); // sheet 2
  images.settleAll();

  assert.equal(cache.sheetCount(), 3, 'every sheet at the coarsest level stays resident');
  for (const [id, url] of [[0, '/sheet-l2-0.jpg'], [4, '/sheet-l2-1.jpg'], [8, '/sheet-l2-2.jpg']]) {
    assert.notEqual(cache.get(id, 2), null, `room ${id} must still resolve`);
    assert.equal(images.count(url), 1, `${url} must not have been refetched`);
  }
});

test('an ordinary sheet-packed level (not the coarsest) still evicts under pressure', () => {
  // The exemption is specific to the coarsest level, not sheets in general -
  // a middle sheet-packed level must still obey its budget.
  const images = fakeImages();
  const cache = createTileCache({
    locateTile: sheetLocate(1, 4), // level 1 is NOT LADDER's coarsest level (2 is)
    pyramid: LADDER,
    createImage: images.createImage,
    sheetBudget: 1,
  });
  cache.get(0, 1); // sheet 0
  images.settleAll();
  cache.get(4, 1); // sheet 1 - evicts sheet 0 under a budget of 1
  images.settleAll();

  assert.equal(cache.sheetCount(), 1);
  cache.get(0, 1);
  assert.equal(images.count('/sheet-l1-0.jpg'), 2, 'the non-coarsest level must still evict');
});

test('sheetBudget evicts strictly oldest-first across more than two sheets', () => {
  // A queue, not "evict whatever is over budget in whatever order" - three
  // sheets touched in order, over a budget of two, must drop exactly the
  // one nobody has touched since.
  const images = fakeImages();
  const cache = createTileCache({
    locateTile: sheetLocate(2, 4),
    pyramid: LADDER,
    createImage: images.createImage,
    sheetBudget: 2,
    neverEvictSheetLevels: [],
  });
  cache.get(0, 2); // sheet 0 - oldest
  images.settleAll();
  cache.get(4, 2); // sheet 1
  images.settleAll();
  cache.get(8, 2); // sheet 2 - pushes sheet count to 3, over budget of 2

  assert.equal(cache.sheetCount(), 2, 'exactly one sheet was evicted to get back to budget');
  assert.equal(images.count('/sheet-l2-0.jpg'), 1, 'sheet 0 (oldest) was evicted, not refetched yet');
  images.settleAll();
  cache.get(0, 2); // now sheet 0 must be fetched again
  assert.equal(images.count('/sheet-l2-0.jpg'), 2, 'the oldest sheet was the one dropped');
  // The two more recently touched sheets survived untouched.
  assert.equal(images.count('/sheet-l2-1.jpg'), 1);
  assert.equal(images.count('/sheet-l2-2.jpg'), 1);
});

test('clear drops sheets too', () => {
  const images = fakeImages();
  const cache = createTileCache({ locateTile: sheetLocate(2, 4), pyramid: LADDER, createImage: images.createImage });
  cache.get(0, 2);
  images.settleAll();
  assert.equal(cache.sheetCount(), 1);
  cache.clear();
  assert.equal(cache.sheetCount(), 0);
  assert.equal(cache.get(0, 2), null, 'a cleared sheet must be fetched afresh');
});
