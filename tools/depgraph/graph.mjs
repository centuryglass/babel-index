/**
 * The graph maths both scans need, kept apart from either of them: distance
 * from a root, what a node can reach, and whether anything is circular.
 *
 * Nothing here knows what a node is, so the npm tree and the repo's own import
 * graph share one implementation rather than growing two that drift. No fs, no
 * imports - which is what makes it testable against hand-written adjacency.
 *
 * Graphs are passed as an adjacency array: `adj[i]` is the list of indices `i`
 * points at.
 */

/** Adjacency in both directions, from an edge list of `{ from, to }` indices. */
export function adjacency(count, edges) {
  const out = Array.from({ length: count }, () => []);
  const inn = Array.from({ length: count }, () => []);
  for (const e of edges) {
    out[e.from].push(e.to);
    inn[e.to].push(e.from);
  }
  return { out, inn };
}

/**
 * Hops from `root` to every node it can reach, breadth first. Measuring a
 * runtime-only depth is a matter of passing an adjacency built from the runtime
 * edges alone, rather than teaching this a second time about edge kinds.
 */
export function bfsDepth(adj, root) {
  const depth = new Map([[root, 0]]);
  const queue = [root];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    for (const next of adj[node]) {
      if (depth.has(next)) continue;
      depth.set(next, depth.get(node) + 1);
      queue.push(next);
    }
  }
  return depth;
}

/** Every node reachable from `start`, including `start` itself. */
export function reachable(adj, start) {
  const seen = new Set([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    for (const next of adj[queue[head]]) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * Tarjan's strongly connected components, returning only the components with
 * more than one member - i.e. the cycles. A self-edge is reported too, since a
 * package depending on itself is the same class of problem.
 *
 * Recursion depth is bounded by the node count, which for a dependency graph is
 * thousands at the very worst - far inside the default stack.
 */
export function cycles(count, adj) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const found = [];
  let next = 0;

  const strong = (v) => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj[v]) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const component = [];
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    const selfLooped = component.length === 1 && adj[v].includes(v);
    if (component.length > 1 || selfLooped) found.push(component);
  };

  for (let v = 0; v < count; v++) if (!index.has(v)) strong(v);
  return found;
}
