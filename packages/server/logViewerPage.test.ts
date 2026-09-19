import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEntryList, renderLogViewerPage } from './logViewerPage.ts';

test('renderEntryList renders newest entry first', () => {
  const html = renderEntryList([
    { time: 1, level: 30, msg: 'first' },
    { time: 2, level: 30, msg: 'second' },
  ]);
  assert.ok(html.indexOf('second') < html.indexOf('first'));
});

test('renderEntryList escapes msg content', () => {
  const html = renderEntryList([{ time: 1, level: 30, msg: '<script>alert(1)</script>' }]);
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderEntryList renders a raw (unparseable) entry without a level', () => {
  const html = renderEntryList([{ raw: 'not json & <weird>' }]);
  assert.ok(html.includes('level-unknown'));
  assert.ok(html.includes('not json &amp; &lt;weird&gt;'));
});

test('renderEntryList includes extra structured fields', () => {
  const html = renderEntryList([{ time: 1, level: 30, msg: 'search', query: 'foo' }]);
  assert.ok(html.includes('query=foo'));
});

test('renderLogViewerPage marks the requested minLevel as selected', () => {
  const html = renderLogViewerPage({ entries: [], minLevel: 50, limit: 100 });
  assert.ok(html.includes('value="50" selected'));
});
