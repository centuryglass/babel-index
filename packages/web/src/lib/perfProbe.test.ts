import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERF, PERF_FORCE_DPR1, percentile, perfRecordFrame, perfRecordSheetStart,
  perfRecordSheetLoaded, perfRecordSheetFirstDraw, perfSetPhase, perfDump,
} from './perfProbe.ts';

test('off by default outside a browser url with ?perf', () => {
  // node:test has no `location`, so both flags read the same "not present" answer.
  assert.equal(PERF, false);
  assert.equal(PERF_FORCE_DPR1, false);
});

test('percentile: empty input', () => {
  assert.equal(percentile([], 50), 0);
});

test('percentile: p50/p90 on a known set', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 50), 6);
  assert.equal(percentile(values, 90), 10);
  assert.equal(percentile(values, 0), 1);
});

test('percentile: unsorted input is sorted first', () => {
  assert.equal(percentile([9, 1, 5, 3, 7], 50), 5);
});

test('recorders are no-ops when PERF is off, so a test run never leaks console output', () => {
  // None of these should throw or print anything - PERF is false in this
  // environment, so every recorder below is a single boolean check that bails.
  // In particular, `perfSetPhase` must bail before touching
  // `requestAnimationFrame`/`PerformanceObserver`, neither of which node:test
  // provides - a real browser check happens in `ensureFrameGapLoop`/
  // `ensureObserver` themselves, but PERF being false must short-circuit both
  // before either is ever called.
  perfSetPhase('flight');
  perfRecordFrame('flight', 12);
  perfRecordSheetStart('https://example/sheet.jpg', 2);
  perfRecordSheetLoaded('https://example/sheet.jpg');
  perfRecordSheetFirstDraw('https://example/sheet.jpg');
  perfDump();
});
