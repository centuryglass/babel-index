import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, requireAdminAuth, verifyPassword } from './admin-auth.ts';

test('verifyPassword accepts the password hashPassword hashed', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
});

test('verifyPassword rejects a wrong password', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('wrong', hash), false);
});

test('verifyPassword rejects a malformed stored hash rather than throwing', () => {
  assert.equal(verifyPassword('anything', 'not-a-valid-stored-hash'), false);
  assert.equal(verifyPassword('anything', ''), false);
  assert.equal(verifyPassword('anything', ':'), false);
});

function fakeReqRes(authorizationHeader?: string, ip = '127.0.0.1') {
  const req = { ip, get: (name: string) => (name === 'Authorization' ? authorizationHeader : undefined) } as any;
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

test('requireAdminAuth calls next() for a matching Basic Auth password', () => {
  const hash = hashPassword('sesame');
  const middleware = requireAdminAuth(hash);
  const encoded = Buffer.from('anyuser:sesame').toString('base64');
  const { req, res } = fakeReqRes(`Basic ${encoded}`);
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test('requireAdminAuth 401s with a WWW-Authenticate challenge when the password is wrong', () => {
  const hash = hashPassword('sesame');
  const middleware = requireAdminAuth(hash);
  const encoded = Buffer.from('anyuser:wrong').toString('base64');
  const state = fakeReqRes(`Basic ${encoded}`);
  let nextCalled = false;
  middleware(state.req, state.res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
  assert.ok(state.headers['WWW-Authenticate'].startsWith('Basic '));
});

test('requireAdminAuth 401s with no Authorization header at all', () => {
  const hash = hashPassword('sesame');
  const middleware = requireAdminAuth(hash);
  const state = fakeReqRes(undefined);
  let nextCalled = false;
  middleware(state.req, state.res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
});

test('requireAdminAuth 429s a burst of attempts from one address, right or wrong password', () => {
  const hash = hashPassword('sesame');
  const middleware = requireAdminAuth(hash);
  const rightAuth = `Basic ${Buffer.from('anyuser:sesame').toString('base64')}`;
  // Spend the whole default burst (rate-buckets.ts) from one address - every
  // one of these succeeds, since the token spend happens before the
  // password check.
  for (let i = 0; i < 20; i++) {
    const state = fakeReqRes(rightAuth, '10.0.0.1');
    middleware(state.req, state.res, () => {});
  }
  const overBudget = fakeReqRes(rightAuth, '10.0.0.1');
  let nextCalled = false;
  middleware(overBudget.req, overBudget.res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(overBudget.statusCode, 429);

  const other = fakeReqRes(rightAuth, '10.0.0.2');
  nextCalled = false;
  middleware(other.req, other.res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, 'a different address has its own budget');
});
