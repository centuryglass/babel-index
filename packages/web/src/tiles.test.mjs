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
