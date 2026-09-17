/**
 * Contract tests for the comment-refactor code-preservation gate.
 *
 * `strip()` must be *sound* (a comment-only edit is invisible) and *complete*
 * (any real code change, including type-only, is caught). These fixtures are
 * the whole point of the tool, so they are asserted here rather than eyeballed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strip } from './strip.mjs';

const eq = (a, b, path = 'x.ts') => strip(a, path) === strip(b, path);

test('comment-only edits are invisible', () => {
  assert.ok(eq('/** doc\n * multi */\nfunction f(){ /* mid */ return 1 } // tail', 'function f(){return 1}'));
  assert.ok(eq('const x = 1; // why\nconst y = 2;', 'const x = 1;\n\n// why\nconst y = 2;'));
});

test('code changes are caught', () => {
  assert.ok(!eq('const x = 1', 'const x = 2'));
  assert.ok(!eq('function f(){return 1}', 'function f(){return -1}'));
});

test('type-only changes are caught (the esbuild trick misses these)', () => {
  assert.ok(!eq('function f(a: number){return String(a)}', 'function f(a: string){return String(a)}'));
  assert.ok(!eq('const x: Foo = y', 'const x: Bar = y'));
});

test('regex and URL content are not eaten as comments', () => {
  // `/` division after an operand must not swallow the rest of the line.
  assert.ok(!eq('const r = a / b;', 'const r = a;'));
  // A URL's `//` inside a string is content.
  assert.ok(!eq('const u = "http://x";', 'const u = "x";'));
  assert.ok(eq('const u = "http://x"; // trailing', 'const u = "http://x";'));
});

test('JSX text with // is preserved and edits to it are caught', () => {
  const p1 = 'export const V = <p>go to http://example.com now</p>;';
  const p2 = 'export const V = <p>go to http://example.com EDIT</p>;';
  assert.ok(!eq(p1, p2, 'v.tsx'));
});

test('template substitutions are handled, comments inside them invisible', () => {
  assert.ok(eq('const t = `a ${/* c */ b + 1} c`', 'const t = `a ${ b + 1} c`'));
  assert.ok(!eq('const t = `a ${ b + 1} c`', 'const t = `a ${ b + 2} c`'));
});

test('malformed input throws rather than comparing falsely', () => {
  assert.throws(() => strip('function f( {', 'bad.ts'), /does not parse/);
});
