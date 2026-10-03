import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createErrorReporter, describe, MAX_REPORTS } from './errorReport.ts';

const capture = () => {
  const sent: Record<string, unknown>[] = [];
  return { sent, send: (body: string) => sent.push(JSON.parse(body)) };
};

test('a report carries kind, message, stack and renderer', () => {
  const { sent, send } = capture();
  const reporter = createErrorReporter({ send, renderer: 'gl' });
  const err = new Error('boom');
  reporter.report('error', err);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'error');
  assert.equal(sent[0].message, 'boom');
  assert.equal(sent[0].stack, err.stack);
  assert.equal(sent[0].renderer, 'gl');
});

test('the same failure is sent once per page load, so a render loop cannot flood the server', () => {
  const { sent, send } = capture();
  const reporter = createErrorReporter({ send });
  for (let i = 0; i < 60; i++) reporter.report('error', new Error('every frame'));
  reporter.report('unhandledrejection', new Error('every frame'));
  assert.deepEqual(
    sent.map((r) => r.kind),
    ['error', 'unhandledrejection']
  );
});

test('distinct failures stop being sent after MAX_REPORTS', () => {
  const { sent, send } = capture();
  const reporter = createErrorReporter({ send });
  for (let i = 0; i < MAX_REPORTS + 5; i++) reporter.report('error', `failure ${i}`);
  assert.equal(sent.length, MAX_REPORTS);
});

test('setRenderer applies to later reports', () => {
  const { sent, send } = capture();
  const reporter = createErrorReporter({ send });
  reporter.setRenderer('canvas2d');
  reporter.report('render', 'x');
  assert.equal(sent[0].renderer, 'canvas2d');
});

test('a send that throws is swallowed, never thrown into the page', () => {
  const reporter = createErrorReporter({
    send: () => {
      throw new Error('offline');
    },
  });
  assert.doesNotThrow(() => reporter.report('error', 'x'));
});

test('describe handles whatever was thrown, Error or not', () => {
  assert.deepEqual(describe('plain'), { message: 'plain' });
  assert.deepEqual(describe({ code: 7 }), { message: '{"code":7}' });
  assert.deepEqual(describe(undefined), { message: 'undefined' });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(describe(circular).message, '[object Object]');
  assert.equal(describe(new TypeError('')).message, 'TypeError');
});
