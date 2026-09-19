import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateBuckets } from './rate-buckets.ts';

test('a burst of writes is rate limited rather than served without end', () => {
  const buckets = createRateBuckets({ burst: 2, refillMs: 60_000 });
  assert.equal(buckets.take('10.0.0.1'), true);
  assert.equal(buckets.take('10.0.0.1'), true);
  assert.equal(buckets.take('10.0.0.1'), false, 'the bucket is empty');
  assert.equal(buckets.take('10.0.0.2'), true, 'and it is per address');
});
