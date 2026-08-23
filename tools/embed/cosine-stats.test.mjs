import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentileOf, summarize, suggestClipBounds } from './cosine-stats.mjs';

test('percentileOf: endpoints and exact ranks', () => {
  const sorted = [1, 2, 3, 4, 5];
  assert.equal(percentileOf(sorted, 0), 1);
  assert.equal(percentileOf(sorted, 100), 5);
  assert.equal(percentileOf(sorted, 50), 3);
});

test('percentileOf: interpolates between ranks', () => {
  const sorted = [0, 10];
  assert.equal(percentileOf(sorted, 25), 2.5);
});

test('percentileOf: empty array is NaN, not a crash', () => {
  assert.ok(Number.isNaN(percentileOf([], 50)));
});

test('summarize: mean, population std and percentiles of a known set', () => {
  // 2,4,4,4,5,5,7,9: mean 5, population variance 4, std 2 (a textbook example).
  const out = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(out.count, 8);
  assert.equal(out.min, 2);
  assert.equal(out.max, 9);
  assert.equal(out.mean, 5);
  assert.ok(Math.abs(out.std - 2) < 1e-9);
  assert.equal(out.percentiles.p50, 4.5);
});

test('summarize: empty input reports zero count rather than throwing', () => {
  const out = summarize([]);
  assert.equal(out.count, 0);
  assert.ok(Number.isNaN(out.mean));
  assert.deepEqual(out.percentiles, {});
});

test('summarize: does not mutate its input', () => {
  const values = [3, 1, 2];
  summarize(values);
  assert.deepEqual(values, [3, 1, 2]);
});

test('suggestClipBounds: separates a noise band from a match band', () => {
  // Overall is dominated by unrelated pairs clustered low; each keyword's own
  // best match sits well above that band - the shape the file header argues for.
  const overall = Array.from({ length: 1000 }, () => 0.1 + Math.random() * 0.05);
  const keywordMax = Array.from({ length: 50 }, () => 0.3 + Math.random() * 0.05);
  const out = suggestClipBounds({ overall, keywordMax });
  assert.ok(out.valid);
  assert.ok(out.clipHigh > out.clipLow);
  assert.deepEqual(out.notes, []);
});

test('suggestClipBounds: reports an overlapping band rather than fabricating a gap', () => {
  const overall = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4];
  const keywordMax = [0.12, 0.14]; // both keywords' bests sit inside the noise band
  const out = suggestClipBounds({ overall, keywordMax });
  assert.equal(out.valid, false);
  assert.equal(out.notes.length, 1);
});
