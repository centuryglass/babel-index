import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagLink } from './tagLinks.ts';

test('tagLink returns the recorded url for a known keyword', () => {
  assert.equal(tagLink('city'), 'https://www.google.com/search?q=city');
});

test('tagLink returns null for a keyword with no entry', () => {
  assert.equal(tagLink('not a real keyword'), null);
});
