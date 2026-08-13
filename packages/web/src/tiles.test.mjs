import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTileCache } from './tiles.js';

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
    /** Complete every outstanding request. */
    settleAll: () => made.forEach((i) => i.onload?.()),
    settle: (url) => made.filter((i) => i.src === url).forEach((i) => i.onload?.()),
    fail: (url) => made.filter((i) => i.src === url).forEach((i) => i.onerror?.()),
  };
}

test('a miss starts one load and returns nothing until it finishes', () => {
  const images = fakeImages();
  let loads = 0;
  const cache = createTileCache({ createImage: images.createImage, onLoad: () => loads++ });

  assert.equal(cache.get('/images/000.jpg'), null);
  assert.equal(images.made.length, 1);
  assert.equal(images.made[0].src, '/images/000.jpg');
  assert.equal(loads, 0);

  images.settleAll();
  assert.equal(loads, 1, 'a finished load must ask for a redraw');
  assert.equal(cache.get('/images/000.jpg'), images.made[0]);
  assert.equal(images.made.length, 1, 'a hit must not re-request');
});

test('an in-flight url is requested once, however many cells ask for it', () => {
  const images = fakeImages();
  const cache = createTileCache({ createImage: images.createImage });
  for (let i = 0; i < 10; i++) assert.equal(cache.get('/images/007.jpg'), null);
  assert.equal(images.made.length, 1);
  assert.equal(cache.size(), 1);
});

test('a failed load is remembered rather than retried every frame', () => {
  const images = fakeImages();
  const cache = createTileCache({ createImage: images.createImage });
  cache.get('/images/gone.jpg');
  images.fail('/images/gone.jpg');
  assert.equal(cache.get('/images/gone.jpg'), null);
  assert.equal(images.made.length, 1, 'a broken image must not be re-requested on every draw');
});

test('the cache stays within budget, evicting least-recently-used first', () => {
  const images = fakeImages();
  const cache = createTileCache({ budget: 10, createImage: images.createImage });

  for (let i = 0; i < 10; i++) cache.get(`/images/${i}.jpg`);
  images.settleAll();
  assert.equal(cache.size(), 10);

  // Touch the first five so they are the freshest, then overflow the budget.
  for (let i = 0; i < 5; i++) cache.get(`/images/${i}.jpg`);
  for (let i = 10; i < 15; i++) cache.get(`/images/${i}.jpg`);
  images.settleAll();

  assert.ok(cache.size() <= 10, `over budget at ${cache.size()}`);
  for (let i = 0; i < 5; i++)
    assert.notEqual(cache.get(`/images/${i}.jpg`), null, `recently used ${i} was evicted`);
});

test('an in-flight load is never evicted', () => {
  const images = fakeImages();
  const cache = createTileCache({ budget: 4, createImage: images.createImage });

  // Fill the budget with settled entries, then queue far more than fits
  // without letting any of them complete.
  for (let i = 0; i < 4; i++) cache.get(`/settled/${i}.jpg`);
  images.settleAll();
  for (let i = 0; i < 20; i++) cache.get(`/pending/${i}.jpg`);

  const requested = images.urls().filter((u) => u.startsWith('/pending/'));
  assert.equal(requested.length, 20);

  // Dropping a loading entry would orphan the request: the image completes,
  // writes 'ready' into an entry no longer in the map, and the url is fetched
  // again the next time it is drawn. So every pending url must still be here.
  images.settleAll();
  for (let i = 0; i < 20; i++)
    assert.notEqual(cache.get(`/pending/${i}.jpg`), null, `pending ${i} was dropped mid-flight`);
  assert.equal(images.made.length, 24, 'nothing should have been re-requested');
});

test('the cache drains back to budget once loads settle', () => {
  const images = fakeImages();
  const cache = createTileCache({ budget: 4, createImage: images.createImage });
  for (let i = 0; i < 20; i++) cache.get(`/images/${i}.jpg`);
  assert.ok(cache.size() > 4, 'in-flight loads are allowed to exceed the budget');
  images.settleAll();
  // Once they are no longer in flight, the next miss is free to collect them.
  for (let i = 20; i < 24; i++) cache.get(`/images/${i}.jpg`);
  assert.ok(cache.size() <= 4, `expected a drain back to budget, got ${cache.size()}`);
});

// --- frame-aware eviction --------------------------------------------------

test('a miss part way through a frame does not evict what the frame already drew', () => {
  // The bug this pins, seen at MIN_ZOOM with a big corpus: one screen wants
  // more distinct rooms than the budget holds, the renderer walks cells row by
  // row, so the tiles it has already drawn are the least recently used things
  // in the cache. A miss half way down evicts the top of the same screen, and
  // the next frame refetches tiles that never left the viewport.
  const images = fakeImages();
  const cache = createTileCache({ budget: 10, createImage: images.createImage });
  const onScreen = Array.from({ length: 20 }, (_, i) => `/old/${i}.jpg`);

  cache.beginFrame();
  for (const u of onScreen) cache.get(u);
  images.settleAll();

  // A pan: the same 20 are still visible, and 20 new ones scroll in behind
  // them. Every new url is a miss, and a miss is what triggers eviction.
  cache.beginFrame();
  for (const u of onScreen) cache.get(u);
  for (let i = 0; i < 20; i++) cache.get(`/new/${i}.jpg`);
  images.settleAll();

  cache.beginFrame();
  const requests = images.made.length;
  for (const u of onScreen) assert.notEqual(cache.get(u), null, `${u} blanked while still on screen`);
  assert.equal(images.made.length, requests, 'a still-visible tile was evicted and refetched');
});

test('the previous frame is protected too, since it is nearly the current one', () => {
  // Eviction runs at the top of a frame, before the renderer has touched
  // anything, so protecting only the frame in progress would protect nothing.
  const images = fakeImages();
  const cache = createTileCache({ budget: 2, createImage: images.createImage });

  cache.beginFrame();
  for (let i = 0; i < 8; i++) cache.get(`/images/${i}.jpg`);
  images.settleAll();

  cache.beginFrame(); // evicts, with the whole screen one frame old
  for (let i = 0; i < 8; i++)
    assert.notEqual(cache.get(`/images/${i}.jpg`), null, `tile ${i} was dropped between frames`);
});

test('tiles that fall off screen are collected once two frames have passed', () => {
  // The other half: protection must expire, or panning across a big corpus
  // would grow the cache without bound.
  const images = fakeImages();
  const cache = createTileCache({ budget: 4, createImage: images.createImage });

  cache.beginFrame();
  for (let i = 0; i < 12; i++) cache.get(`/gone/${i}.jpg`);
  images.settleAll();
  assert.ok(cache.size() > 4, 'in-flight loads are allowed past the budget');

  // Two frames drawing something else entirely: the first still protects
  // /gone/ as the previous frame, the second lets it go.
  for (const pass of [0, 1]) {
    cache.beginFrame();
    cache.get(`/here/${pass}.jpg`);
    images.settleAll();
  }
  cache.beginFrame();
  assert.ok(cache.size() <= 4, `expected a drain back to budget, got ${cache.size()}`);
});

test('without beginFrame it is the plain LRU it always was', () => {
  // The cache is usable outside a render loop, and nothing is protected there:
  // "the current frame" has no meaning if no one opens one.
  const images = fakeImages();
  const cache = createTileCache({ budget: 4, createImage: images.createImage });
  for (let i = 0; i < 12; i++) cache.get(`/images/${i}.jpg`);
  images.settleAll();
  for (let i = 12; i < 16; i++) cache.get(`/images/${i}.jpg`);
  assert.ok(cache.size() <= 4, `expected plain LRU behaviour, got ${cache.size()}`);
});

test('a pinned url survives any amount of pressure', () => {
  // The generic room is what every other cell falls back to, so evicting it to
  // make room for one more cell would break the fallback for all of them.
  const images = fakeImages();
  const cache = createTileCache({ budget: 2, createImage: images.createImage });

  cache.pin('/images/base.png');
  images.settleAll();
  for (let i = 0; i < 50; i++) cache.get(`/images/${i}.jpg`);
  images.settleAll();
  for (let i = 50; i < 60; i++) cache.get(`/images/${i}.jpg`);

  assert.notEqual(cache.get('/images/base.png'), null, 'the pinned generic was evicted');
  assert.equal(
    images.urls().filter((u) => u === '/images/base.png').length,
    1,
    'the generic must be fetched once and kept'
  );
});

test('overBudget reports the pressure rather than hiding it', () => {
  // When one screen exceeds the budget the cache holds it anyway - blanking
  // would be worse - so the overage is worth surfacing instead of pretending.
  const images = fakeImages();
  const cache = createTileCache({ budget: 4, createImage: images.createImage });
  cache.beginFrame();
  for (let i = 0; i < 10; i++) cache.get(`/images/${i}.jpg`);
  images.settleAll();
  assert.equal(cache.overBudget(), cache.size() - 4);
  assert.ok(cache.overBudget() > 0);
});

test('clear drops everything', () => {
  const images = fakeImages();
  const cache = createTileCache({ createImage: images.createImage });
  for (let i = 0; i < 5; i++) cache.get(`/images/${i}.jpg`);
  images.settleAll();
  assert.equal(cache.size(), 5);
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.get('/images/0.jpg'), null, 'a cleared url must be fetched afresh');
});
