import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presenceRef } from './presenceRef.ts';

test('presenceRef reports only crossings between null and a value', () => {
  const seen: boolean[] = [];
  const ref = presenceRef<{ n: number }>((present) => seen.push(present));
  assert.equal(ref.current, null);

  const a = { n: 1 };
  ref.current = a;
  assert.equal(ref.current, a);
  ref.current = { n: 2 };
  ref.current = null;
  ref.current = null;
  assert.deepEqual(seen, [true, false]);
});
