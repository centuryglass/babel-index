import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTileCache, GENERIC } from './tiles.js';
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

/** Every level of every room exists, unless `only` says otherwise. */
const urls = (only = null) => (id, level) =>
  only && !only.includes(level) ? null : `/l${level}/${id}.jpg`;

const build = (opts = {}) => {
  const images = fakeImages();
  const cache = createTileCache({
    urlFor: urls(opts.only),
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
    urlFor: urls(), pyramid: LADDER, createImage: images.createImage, onLoad: () => loads++,
  });
  assert.equal(c.get(7, 0), null);
  assert.equal(images.made.length, 1);
  assert.equal(images.made[0].src, '/l0/7.jpg');
  assert.equal(loads, 0);

  images.settleAll();
  assert.equal(loads, 1, 'a finished load must ask for a redraw');
  assert.deepEqual(c.get(7, 0), { img: images.made[0], level: 0 });
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
  assert.deepEqual(cache.get(5, 1), { img: images.made[0], level: 1 });
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
  // The generic is what every other cell falls back to, so evicting it to make
  // room for one more cell would break the fallback for all of them.
  const { images, cache } = build();
  cache.pin(GENERIC);
  cache.get(GENERIC, 2);
  images.settleAll();

  for (let id = 0; id < 40; id++) cache.get(id, 2);
  images.settleAll();
  for (let id = 40; id < 60; id++) cache.get(id, 2);

  assert.equal(cache.get(GENERIC, 2).level, 2, 'the pinned generic was evicted');
  assert.equal(images.count('/l2/generic.jpg'), 1, 'and it must be fetched exactly once');
});

test('overBudget reports the pressure rather than hiding it', () => {
  const { images, cache } = build();
  cache.beginFrame();
  for (let id = 0; id < 10; id++) cache.get(id, 0);
  images.settleAll();
  assert.equal(cache.overBudgetAt(0), cache.sizeOf(0) - 4);
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
  const { images, cache } = build({ concurrency: 1 });
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
