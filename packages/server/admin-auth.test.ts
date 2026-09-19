import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, requireAdminAuth, verifyPassword } from './admin-auth.ts';
import { createRateBuckets } from './rate-buckets.ts';
import { logger } from './logger.ts';

/** Replaces logger.warn/info for the duration of `run`, returning every call made through either. Restores both afterward even if `run` throws. */
async function capturingLogs(run: () => Promise<void>): Promise<{ level: string; obj: unknown; msg: string }[]> {
  const calls: { level: string; obj: unknown; msg: string }[] = [];
  const originalWarn = logger.warn.bind(logger);
  const originalInfo = logger.info.bind(logger);
  (logger as any).warn = (obj: unknown, msg: string) => calls.push({ level: 'warn', obj, msg });
  (logger as any).info = (obj: unknown, msg: string) => calls.push({ level: 'info', obj, msg });
  try {
    await run();
  } finally {
    logger.warn = originalWarn;
    logger.info = originalInfo;
  }
  return calls;
}

test('verifyPassword accepts the password hashPassword hashed', async () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
});

test('verifyPassword rejects a wrong password', async () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('wrong', hash), false);
});

test('verifyPassword rejects a malformed stored hash rather than throwing', async () => {
  assert.equal(await verifyPassword('anything', 'not-a-valid-stored-hash'), false);
  assert.equal(await verifyPassword('anything', ''), false);
  assert.equal(await verifyPassword('anything', ':'), false);
});

function fakeReqRes(authorizationHeader?: string, ip = '127.0.0.1') {
  const req = { ip, path: '/api/logs', get: (name: string) => (name === 'Authorization' ? authorizationHeader : undefined) } as any;
  const headers: Record<string, string> = {};
  let statusCode: number | null = null;
  let body: unknown = null;
  const res = {
    set(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
  } as any;
  return { req, res, headers, get statusCode() { return statusCode; }, get body() { return body; } };
}

test('requireAdminAuth calls next() for a matching Basic Auth password', async () => {
  const hash = hashPassword('sesame');
  const middleware = requireAdminAuth(hash);
  const encoded = Buffer.from('anyuser:sesame').toString('base64');
  const { req, res } = fakeReqRes(`Basic ${encoded}`);
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test('requireAdminAuth 401s with a WWW-Authenticate challenge when the password is wrong', async () => {
  const hash = hashPassword('sesame');
  const middleware = requireAdminAuth(hash);
  const encoded = Buffer.from('anyuser:wrong').toString('base64');
  const state = fakeReqRes(`Basic ${encoded}`);
  let nextCalled = false;
  await middleware(state.req, state.res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
  assert.ok(state.headers['WWW-Authenticate'].startsWith('Basic '));
});

test('requireAdminAuth 401s with no Authorization header at all', async () => {
  const hash = hashPassword('sesame');
  const middleware = requireAdminAuth(hash);
  const state = fakeReqRes(undefined);
  let nextCalled = false;
  await middleware(state.req, state.res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
});

test('requireAdminAuth 429s a burst of attempts from one address, right or wrong password', async () => {
  const hash = hashPassword('sesame');
  // A tiny burst and a refill window far longer than a handful of real
  // scrypt calls could ever take, injected rather than relying on the
  // production default (rate-buckets.ts): each of these requests runs a
  // real password check, and with the default's 1-second refill window,
  // ~20 sequential scrypt calls' own wall-clock cost was enough to refill a
  // token before the "over budget" request arrived - flaky (and
  // CI-load-dependent) rather than reliably 429ing.
  const buckets = createRateBuckets({ burst: 2, refillMs: 60_000 });
  const middleware = requireAdminAuth(hash, buckets);
  const rightAuth = `Basic ${Buffer.from('anyuser:sesame').toString('base64')}`;
  // Spend the whole burst from one address - both of these succeed, since
  // the token spend happens before the password check.
  for (let i = 0; i < 2; i++) {
    const state = fakeReqRes(rightAuth, '10.0.0.1');
    await middleware(state.req, state.res, () => {});
  }
  const overBudget = fakeReqRes(rightAuth, '10.0.0.1');
  let nextCalled = false;
  await middleware(overBudget.req, overBudget.res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(overBudget.statusCode, 429);

  const other = fakeReqRes(rightAuth, '10.0.0.2');
  nextCalled = false;
  await middleware(other.req, other.res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, 'a different address has its own budget');
});

test('requireAdminAuth logs the ip and path for every outcome, and never the attempted password', async () => {
  const hash = hashPassword('sesame');
  const middleware = requireAdminAuth(hash);
  const wrongPassword = 'definitely-not-sesame';
  const wrongEncoded = Buffer.from(`anyuser:${wrongPassword}`).toString('base64');
  const rightEncoded = Buffer.from('anyuser:sesame').toString('base64');

  const calls = await capturingLogs(async () => {
    const succeeded = fakeReqRes(`Basic ${rightEncoded}`, '10.0.0.5');
    await middleware(succeeded.req, succeeded.res, () => {});

    const failed = fakeReqRes(`Basic ${wrongEncoded}`, '10.0.0.6');
    await middleware(failed.req, failed.res, () => {});
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.level),
    ['info', 'warn'],
    'a real login logs info, a wrong password logs warn'
  );
  for (const call of calls) {
    assert.equal((call.obj as { path?: string }).path, '/api/logs');
    const serialized = JSON.stringify(call);
    assert.ok(!serialized.includes(wrongPassword), 'the attempted password never appears in a log call');
    assert.ok(!serialized.includes('sesame'), 'not even the real password appears in a log call');
  }
  assert.equal((calls[0].obj as { ip?: string }).ip, '10.0.0.5');
  assert.equal((calls[1].obj as { ip?: string }).ip, '10.0.0.6');
});

test('requireAdminAuth logs rate-limited attempts at warn', async () => {
  const hash = hashPassword('sesame');
  const buckets = createRateBuckets({ burst: 1, refillMs: 60_000 });
  const middleware = requireAdminAuth(hash, buckets);
  const rightAuth = `Basic ${Buffer.from('anyuser:sesame').toString('base64')}`;

  const calls = await capturingLogs(async () => {
    const first = fakeReqRes(rightAuth, '10.0.0.7');
    await middleware(first.req, first.res, () => {}); // spends the one token
    const second = fakeReqRes(rightAuth, '10.0.0.7');
    await middleware(second.req, second.res, () => {}); // rate-limited
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].level, 'info');
  assert.equal(calls[1].level, 'warn');
  assert.match(calls[1].msg, /rate-limited/);
  assert.equal((calls[1].obj as { ip?: string }).ip, '10.0.0.7');
});
