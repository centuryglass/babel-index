import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBasePath } from './base-path.ts';

test('normalizeBasePath defaults to root', () => {
  assert.equal(normalizeBasePath(undefined), '/');
  assert.equal(normalizeBasePath(null), '/');
  assert.equal(normalizeBasePath(''), '/');
});

test('normalizeBasePath adds whatever slash is missing', () => {
  assert.equal(normalizeBasePath('babel-index'), '/babel-index/');
  assert.equal(normalizeBasePath('/babel-index'), '/babel-index/');
  assert.equal(normalizeBasePath('babel-index/'), '/babel-index/');
  assert.equal(normalizeBasePath('/babel-index/'), '/babel-index/');
});

test('normalizeBasePath trims surrounding whitespace', () => {
  assert.equal(normalizeBasePath('  /babel-index/  '), '/babel-index/');
});
