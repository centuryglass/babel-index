import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSequence, runSequence, DEFAULT_DURATION_MS, type DebugActions, type DebugActionName } from './debugActions.ts';

// A sample much longer than the real default - long enough that even the
// lowest-weighted action is virtually certain to turn up at least once, for
// the coverage test below. Not a claim about how long a real run should be.
const LONG_SAMPLE_MS = 5 * 60 * 1000;

test('buildSequence is deterministic for a given seed', () => {
  const a = buildSequence('babel-perf', LONG_SAMPLE_MS, 500);
  const b = buildSequence('babel-perf', LONG_SAMPLE_MS, 500);
  assert.deepEqual(a, b);
});

test('buildSequence differs across seeds', () => {
  const a = buildSequence('seed-one', LONG_SAMPLE_MS, 500);
  const b = buildSequence('seed-two', LONG_SAMPLE_MS, 500);
  assert.notDeepEqual(a, b);
});

test('buildSequence covers roughly the requested duration, not wildly over or under', () => {
  const steps = buildSequence('babel-perf', LONG_SAMPLE_MS, 500);
  const total = steps.reduce((sum, s) => sum + s.delayMs, 0);
  assert.ok(total >= LONG_SAMPLE_MS, 'sequence should run at least as long as requested');
  assert.ok(total < LONG_SAMPLE_MS + 1000, 'sequence should not overshoot by more than one extra step');
});

test('the default duration is one minute', () => {
  assert.equal(DEFAULT_DURATION_MS, 60 * 1000);
});

test('a full-length sequence exercises every action at least once', () => {
  const steps = buildSequence('babel-perf', LONG_SAMPLE_MS, 500);
  const seen = new Set(steps.map((s) => s.action));
  const expected: DebugActionName[] = [
    'pan', 'zoom', 'search', 'clearSearch', 'favorite', 'enterCatalog', 'exitCatalog',
    'book', 'reorder', 'rescatter', 'sort', 'distill', 'recentre', 'openCard', 'closeCard',
    'goToSearch',
  ];
  for (const action of expected) {
    assert.ok(seen.has(action), `expected "${action}" to appear in a full session`);
  }
});

test('runSequence dispatches every step to the matching action, in order, with no real delay', async () => {
  const steps = buildSequence('babel-perf', 2000, 500);
  const calls: string[] = [];
  const actions: DebugActions = {
    pan: (dx, dy) => calls.push(`pan ${dx} ${dy}`),
    zoom: (f) => calls.push(`zoom ${f}`),
    search: (t) => calls.push(`search ${t}`),
    favorite: (id) => calls.push(`favorite ${id}`),
    enterCatalog: () => calls.push('enterCatalog'),
    exitCatalog: () => calls.push('exitCatalog'),
    book: (i) => calls.push(`book ${i}`),
    reorder: () => calls.push('reorder'),
    rescatter: () => calls.push('rescatter'),
    sort: (m) => calls.push(`sort ${m}`),
    distill: () => calls.push('distill'),
    recentre: () => calls.push('recentre'),
    openCard: (id) => calls.push(`openCard ${id}`),
    closeCard: () => calls.push('closeCard'),
    goToSearch: () => calls.push('goToSearch'),
  };
  await runSequence(actions, steps, { wait: async () => {} });
  assert.equal(calls.length, steps.length);
});

test('runSequence reports each step via onStep before dispatching it', async () => {
  const steps = buildSequence('babel-perf', 1000, 500);
  const reported: DebugActionName[] = [];
  const noop = () => {};
  const actions: DebugActions = {
    pan: noop, zoom: noop, search: noop, favorite: noop, enterCatalog: noop, exitCatalog: noop,
    book: noop, reorder: noop, rescatter: noop, sort: noop, distill: noop, recentre: noop,
    openCard: noop, closeCard: noop, goToSearch: noop,
  };
  await runSequence(actions, steps, {
    wait: async () => {},
    onStep: (step) => reported.push(step.action),
  });
  assert.deepEqual(reported, steps.map((s) => s.action));
});

test('runSequence skips map-only actions while mode() reports catalog, but still dispatches the rest', async () => {
  const mapOnly: DebugActionName[] = ['pan', 'zoom', 'book', 'recentre', 'openCard', 'goToSearch'];
  const steps = buildSequence('babel-perf', LONG_SAMPLE_MS, 500).filter((s) =>
    mapOnly.includes(s.action) || s.action === 'search'
  );
  assert.ok(steps.some((s) => mapOnly.includes(s.action)), 'fixture should include at least one map-only step');
  const calls: DebugActionName[] = [];
  const noop = (name: DebugActionName) => () => calls.push(name);
  const actions: DebugActions = {
    pan: noop('pan'), zoom: noop('zoom'), search: noop('search'), favorite: noop('favorite'),
    enterCatalog: noop('enterCatalog'), exitCatalog: noop('exitCatalog'), book: noop('book'),
    reorder: noop('reorder'), rescatter: noop('rescatter'), sort: noop('sort'), distill: noop('distill'),
    recentre: noop('recentre'), openCard: noop('openCard'), closeCard: noop('closeCard'),
    goToSearch: noop('goToSearch'),
  };
  const skips: boolean[] = [];
  await runSequence(actions, steps, {
    wait: async () => {},
    mode: () => 'catalog',
    onStep: (_step, _i, skipped) => skips.push(skipped),
  });
  assert.ok(!calls.includes('pan') && !calls.includes('zoom') && !calls.includes('book')
    && !calls.includes('recentre') && !calls.includes('openCard') && !calls.includes('goToSearch'),
    'no map-only action should have been dispatched');
  assert.ok(calls.includes('search'), 'a non-map-only action should still dispatch');
  assert.deepEqual(skips, steps.map((s) => mapOnly.includes(s.action)));
});
