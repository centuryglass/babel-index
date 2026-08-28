import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSampleText, paginateText } from './PagedTextOverlay.tsx';

test('generateSampleText produces the requested number of lines, plus paragraph breaks', () => {
  const text = generateSampleText(9, 5, 3);
  const lines = text.split('\n');
  // 9 lines of content, plus one blank line after every 3rd (indices 2, 5, 8) = 12
  assert.equal(lines.length, 12);
  assert.equal(lines[3], '');
  assert.equal(lines[7], '');
  assert.equal(lines[11], '');
  for (const line of [lines[0], lines[1], lines[2], lines[4], lines[5], lines[6], lines[8], lines[9], lines[10]]) {
    assert.equal(line.length, 5);
  }
});

test('paginateText splits into fixed-size chunks of lines', () => {
  const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
  const pages = paginateText(text, 4);
  assert.equal(pages.length, 3);
  assert.equal(pages[0], 'line0\nline1\nline2\nline3');
  assert.equal(pages[1], 'line4\nline5\nline6\nline7');
  assert.equal(pages[2], 'line8\nline9');
});

test('paginateText never returns zero pages', () => {
  assert.deepEqual(paginateText(''), ['']);
});
