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

function fakeReqRes(authorizationHeader?: string) {
  const req = { get: (name: string) => (name === 'Authorization' ? authorizationHeader : undefined) } as any;
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
