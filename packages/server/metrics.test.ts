import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageMetrics, msUntilNextHour } from './metrics.ts';

test('an hour with nothing recorded logs nothing', () => {
  const logged: Record<string, number>[] = [];
  const metrics = createUsageMetrics({ log: (fields) => logged.push(fields) });
  metrics.flush();
  assert.deepEqual(logged, []);
  metrics.stop();
});

test('counts are reported once per flush and reset afterward', () => {
  const logged: Record<string, number>[] = [];
  const metrics = createUsageMetrics({ log: (fields) => logged.push(fields) });

  metrics.recordVisit('10.0.0.1');
  metrics.recordVisit('10.0.0.2');
  metrics.recordVisit('10.0.0.1'); // same visitor twice within the hour
  metrics.recordSearch();
  metrics.recordSearch();
  metrics.recordFavoriteAdd();
  metrics.recordFavoriteRemove();
  metrics.flush();

  assert.deepEqual(logged, [{ visitors: 2, searches: 2, favoriteAdds: 1, favoriteRemoves: 1 }]);

  // The next hour starts from zero, and a flush with nothing new logs nothing.
  metrics.flush();
  assert.deepEqual(logged, [{ visitors: 2, searches: 2, favoriteAdds: 1, favoriteRemoves: 1 }]);

  metrics.stop();
});

test('no raw address reaches the logged line, and an empty address is not counted', () => {
  const logged: Record<string, number>[] = [];
  const metrics = createUsageMetrics({ log: (fields) => logged.push(fields) });

  metrics.recordVisit('203.0.113.9');
  metrics.recordVisit('');
  metrics.flush();

  assert.deepEqual(logged, [{ visitors: 1, searches: 0, favoriteAdds: 0, favoriteRemoves: 0 }]);
  assert.ok(!JSON.stringify(logged).includes('203.0.113.9'));

  metrics.stop();
});

test('the same address counts once per hour, but is not carried over into the next', () => {
  const logged: Record<string, number>[] = [];
  const metrics = createUsageMetrics({ log: (fields) => logged.push(fields) });

  metrics.recordVisit('198.51.100.1');
  metrics.flush();
  metrics.recordVisit('198.51.100.1');
  metrics.flush();

  assert.deepEqual(
    logged,
    [{ visitors: 1, searches: 0, favoriteAdds: 0, favoriteRemoves: 0 }, { visitors: 1, searches: 0, favoriteAdds: 0, favoriteRemoves: 0 }],
    'the same visitor is counted fresh in each hour, not accumulated across the flush'
  );

  metrics.stop();
});

test('msUntilNextHour lands exactly on the next :00:00.000', () => {
  const midHour = new Date('2026-01-01T05:17:42.123Z').getTime();
  const next = midHour + msUntilNextHour(midHour);
  const nextDate = new Date(next);
  assert.equal(nextDate.getUTCMinutes(), 0);
  assert.equal(nextDate.getUTCSeconds(), 0);
  assert.equal(nextDate.getUTCMilliseconds(), 0);
  assert.equal(nextDate.getUTCHours(), 6);
});

test('msUntilNextHour on the boundary itself still returns a full hour, not zero', () => {
  const onHour = new Date('2026-01-01T05:00:00.000Z').getTime();
  assert.equal(msUntilNextHour(onHour), 60 * 60 * 1000);
});
