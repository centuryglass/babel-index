import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientError } from './client-errors.ts';

test('a well-formed report keeps its known fields', () => {
  assert.deepEqual(
    parseClientError({ kind: 'render', message: 'boom', stack: 'at x', url: 'https://example.com/babel-index/', renderer: 'gl' }),
    { kind: 'render', message: 'boom', stack: 'at x', url: 'https://example.com/babel-index/', renderer: 'gl' }
  );
});

test('anything that is not an object with a non-empty string message is rejected', () => {
  for (const body of [null, undefined, 'boom', 42, [], {}, { message: '' }, { message: 7 }]) assert.equal(parseClientError(body), null);
});

test('unknown fields are dropped, and an unknown kind or renderer is not trusted', () => {
  assert.deepEqual(parseClientError({ message: 'm', kind: 'nonsense', renderer: 'webgpu', ip: '1.2.3.4', extra: { a: 1 } }), {
    kind: 'other',
    message: 'm',
  });
});

test('the url loses its query string and fragment, which can carry a search', () => {
  assert.equal(parseClientError({ message: 'm', url: 'https://example.com/map/room?q=secret#frag' })?.url, 'https://example.com/map/room');
});

test('every string field is truncated', () => {
  const long = 'x'.repeat(100_000);
  const report = parseClientError({ message: long, stack: long, url: long });
  assert.ok(report);
  assert.ok(report.message.length <= 1000);
  assert.ok((report.stack ?? '').length <= 4000);
  assert.ok((report.url ?? '').length <= 500);
});
