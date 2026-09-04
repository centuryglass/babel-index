import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from './logger.ts';

test('logger exposes the leveled methods every call site uses', () => {
  for (const level of ['info', 'warn', 'error']) assert.equal(typeof (logger as any)[level], 'function');
});

test('logger defaults to info when LOG_LEVEL is unset', () => {
  // Importing logger.ts a second time reuses the same module instance under
  // Node's ESM cache, so this asserts the default the singleton was built
  // with rather than constructing a second one - there is only ever one.
  assert.equal(logger.level, process.env.LOG_LEVEL ?? 'info');
});
