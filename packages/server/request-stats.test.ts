import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { createRequestStats, percentile, routeLabel, STATIC_ROUTE, UNMATCHED_ROUTE } from './request-stats.ts';

/** Just the fields `routeLabel` reads. */
const req = (originalUrl: string, routePath?: string, baseUrl = '') =>
  ({ originalUrl, baseUrl, route: routePath ? { path: routePath } : undefined }) as unknown as Request;

test('percentile is nearest-rank over an ascending array, and null when empty', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 0.5), 50);
  assert.equal(percentile(sorted, 0.95), 95);
  assert.equal(percentile(sorted, 0.99), 99);
  assert.equal(percentile([7], 0.99), 7);
  assert.equal(percentile([], 0.5), null);
});

test('counts are kept per route, with 5xx counted beside the total', () => {
  const stats = createRequestStats();
  stats.record('/api/manifest', 200, 1);
  stats.record('/api/manifest', 500, 1);
  stats.record('/catalog', 404, 1);
  stats.recordClientError();
  const snap = stats.snapshot();
  assert.deepEqual(snap.requests, {
    total: 3,
    serverErrors: 1,
    byRoute: { '/api/manifest': { count: 2, serverErrors: 1 }, '/catalog': { count: 1, serverErrors: 0 } },
  });
  assert.equal(snap.clientErrors, 1);
  assert.deepEqual(snap.search, { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null });
});

test('search latency is sampled from /api/search only, over a bounded window', () => {
  const stats = createRequestStats();
  stats.record('/api/manifest', 200, 9999);
  for (let i = 1; i <= 1500; i++) stats.record('/api/search', 200, i);
  const { search } = stats.snapshot();
  // The window keeps the newest 1000 of 1500, so 1-500 age out, and the manifest's 9999 never entered.
  assert.equal(search.samples, 1000);
  assert.equal(search.p50Ms, 1000);
  assert.equal(search.p99Ms, 1490);
});

test('a snapshot is a copy, not a view of the live counters', () => {
  const stats = createRequestStats();
  stats.record('/api/health', 200, 1);
  const snap = stats.snapshot();
  stats.record('/api/health', 200, 1);
  assert.equal(snap.requests.byRoute['/api/health'].count, 1);
});

test('routeLabel names a route by its pattern, never by the raw path', () => {
  assert.equal(routeLabel(req('/api/favorites/001.jpg', '/api/favorites/:file'), 200), '/api/favorites/:file');
  assert.equal(routeLabel(req('/catalog?page=2', '/catalog'), 200), '/catalog');
});

test('routeLabel folds static hits and unanswered paths into fixed buckets', () => {
  assert.equal(routeLabel(req('/images/001.jpg'), 200), '/images/*');
  assert.equal(routeLabel(req('/images/missing.jpg'), 404), '/images/*');
  assert.equal(routeLabel(req('/shared/center.png'), 200), '/shared/*');
  assert.equal(routeLabel(req('/og-image.jpg'), 200), STATIC_ROUTE);
  assert.equal(routeLabel(req('/wp-login.php'), 404), UNMATCHED_ROUTE);
  assert.equal(routeLabel(req('/another/probe'), 404), UNMATCHED_ROUTE);
});
