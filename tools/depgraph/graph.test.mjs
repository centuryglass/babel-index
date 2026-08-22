import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjacency, bfsDepth, reachable, cycles } from './graph.mjs';

/** 0 -> 1 -> 3, 0 -> 2 -> 3, and 4 off on its own. */
const edges = [
  { from: 0, to: 1 }, { from: 0, to: 2 },
  { from: 1, to: 3 }, { from: 2, to: 3 },
];
const adj = adjacency(5, edges);

test('adjacency records both directions', () => {
  assert.deepEqual(adj.out[0], [1, 2]);
  assert.deepEqual(adj.inn[3], [1, 2]);
  assert.deepEqual(adj.out[4], []);
});

test('depth is the shortest hop count, and unreachable nodes are absent', () => {
  const depth = bfsDepth(adj.out, 0);
  assert.equal(depth.get(0), 0);
  assert.equal(depth.get(3), 2);
  assert.ok(!depth.has(4));
});

test('a diamond reports the shorter of two paths', () => {
  // 0 -> 4 directly as well; 4 must become depth 1, not depth 3 by the long way.
  const long = adjacency(5, [...edges, { from: 3, to: 4 }, { from: 0, to: 4 }]);
  assert.equal(bfsDepth(long.out, 0).get(4), 1);
});

test('reachable includes the start and nothing unconnected', () => {
  assert.deepEqual([...reachable(adj.out, 0)].sort(), [0, 1, 2, 3]);
  assert.deepEqual([...reachable(adj.out, 4)], [4]);
});

test('an acyclic graph reports no cycles', () => {
  assert.deepEqual(cycles(5, adj.out), []);
});

test('a cycle is reported once, with every member', () => {
  const looped = adjacency(3, [{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 0 }]);
  const found = cycles(3, looped.out);
  assert.equal(found.length, 1);
  assert.deepEqual([...found[0]].sort(), [0, 1, 2]);
});

test('a self-edge counts as a cycle, though it is a component of one', () => {
  // Worth asserting: the component-size test alone would miss this, and a
  // package depending on itself is the same class of problem as a loop.
  const looped = adjacency(2, [{ from: 0, to: 0 }, { from: 0, to: 1 }]);
  assert.deepEqual(cycles(2, looped.out), [[0]]);
});

test('two separate cycles are two components, not one', () => {
  const looped = adjacency(4, [
    { from: 0, to: 1 }, { from: 1, to: 0 },
    { from: 2, to: 3 }, { from: 3, to: 2 },
  ]);
  assert.equal(cycles(4, looped.out).length, 2);
});

test('bfs terminates on a cyclic graph', () => {
  const looped = adjacency(3, [{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 0 }]);
  assert.equal(bfsDepth(looped.out, 0).get(2), 2);
});
