import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advancePlayback,
  frameIndexAt,
  pickRandomOther,
  type PlaybackState,
  type CycleTiming,
} from './loadingAnimation.ts';

const CYCLES: CycleTiming[] = [{ frames: 16 }, { frames: 16 }, { frames: 16 }];
const DUR = 100; // ms/frame -> 1600ms per 16-frame cycle
const CYCLE_MS = 16 * DUR;

/** A pickNext that walks in order, so boundary crossings are deterministic. */
const inOrder = (count: number) => (current: number) => (current + 1) % count;

function fresh(mode: 'run' | 'debug' = 'run'): PlaybackState {
  return { index: 0, cycleStart: 0, completed: 0, stopRequested: false, mode };
}

test('advancePlayback stays put within a cycle', () => {
  const s = fresh();
  const r = advancePlayback(s, CYCLE_MS - 1, CYCLES, DUR, inOrder(3));
  assert.equal(r.stopped, false);
  assert.equal(s.completed, 0);
  assert.equal(s.index, 0);
});

test('advancePlayback advances to the next cycle at a boundary', () => {
  const s = fresh();
  const r = advancePlayback(s, CYCLE_MS, CYCLES, DUR, inOrder(3));
  assert.equal(r.stopped, false);
  assert.equal(s.completed, 1);
  assert.equal(s.index, 1);
  assert.equal(s.cycleStart, CYCLE_MS);
});

test('advancePlayback crosses several boundaries a slow tick skipped', () => {
  const s = fresh();
  advancePlayback(s, CYCLE_MS * 3 + 5, CYCLES, DUR, inOrder(3));
  assert.equal(s.completed, 3);
  assert.equal(s.index, 0); // 0 -> 1 -> 2 -> 0
  assert.equal(s.cycleStart, CYCLE_MS * 3);
});

test('a stop request is honoured only at the boundary, not mid-cycle', () => {
  const s = fresh();
  s.stopRequested = true;
  assert.equal(advancePlayback(s, CYCLE_MS - 1, CYCLES, DUR, inOrder(3)).stopped, false);
  assert.equal(advancePlayback(s, CYCLE_MS, CYCLES, DUR, inOrder(3)).stopped, true);
  assert.equal(s.completed, 1); // exactly one full cycle played
});

test('always at least one full cycle: an immediate stop still runs a whole cycle', () => {
  const s = fresh();
  s.stopRequested = true; // requested before any time passed
  // Partway through the first cycle: not yet.
  assert.equal(advancePlayback(s, CYCLE_MS / 2, CYCLES, DUR, inOrder(3)).stopped, false);
  // First boundary: stops now, one cycle in.
  assert.equal(advancePlayback(s, CYCLE_MS, CYCLES, DUR, inOrder(3)).stopped, true);
});

test('debug mode never stops even with a stray stop flag', () => {
  const s = fresh('debug');
  s.stopRequested = true;
  const r = advancePlayback(s, CYCLE_MS * 2, CYCLES, DUR, inOrder(3));
  assert.equal(r.stopped, false);
  assert.equal(s.completed, 2);
});

test('a zero-length cycle cannot spin the advance loop forever', () => {
  const s = fresh();
  const r = advancePlayback(s, 10_000, [{ frames: 0 }], DUR, inOrder(1));
  assert.equal(r.stopped, false);
});

test('frameIndexAt walks frames and clamps past the end', () => {
  const s = fresh();
  assert.equal(frameIndexAt(s, 0, CYCLES, DUR), 0);
  assert.equal(frameIndexAt(s, 350, CYCLES, DUR), 3);
  assert.equal(frameIndexAt(s, (16 - 1) * DUR, CYCLES, DUR), 15);
  // A hair past the last boundary, before the loop advanced: held, not out of range.
  assert.equal(frameIndexAt(s, CYCLE_MS + 5, CYCLES, DUR), 15);
});

test('pickRandomOther never returns the current index', () => {
  const seq = [0, 0.5, 0.99, 0.4, 0.75];
  let i = 0;
  const random = () => seq[i++ % seq.length];
  for (let current = 0; current < 3; current++) {
    for (let n = 0; n < seq.length; n++) {
      assert.notEqual(pickRandomOther(3, current, random), current);
    }
  }
});

test('pickRandomOther on a lone cycle repeats it', () => {
  assert.equal(pickRandomOther(1, 0, () => 0.5), 0);
});
