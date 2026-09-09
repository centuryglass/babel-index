/**
 * The dialog stack is what makes only the topmost overlay react to Escape and
 * Tab when two are open. The hook itself needs a DOM (covered by e2e); these
 * cover the pure ordering the hook leans on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushDialog, popDialog, isTopDialog, resetDialogStack } from './useDialog.ts';

const token = () => ({ id: Symbol('t') });

test('the last pushed dialog is the top one', () => {
  resetDialogStack();
  const a = token();
  const b = token();
  pushDialog(a);
  assert.equal(isTopDialog(a), true);
  pushDialog(b);
  assert.equal(isTopDialog(b), true);
  assert.equal(isTopDialog(a), false, 'a dialog under another is not the top');
});

test('popping the top restores the one beneath it', () => {
  resetDialogStack();
  const a = token();
  const b = token();
  pushDialog(a);
  pushDialog(b);
  popDialog(b);
  assert.equal(isTopDialog(a), true, 'closing the book returns the statement to the top');
});

test('a dialog can be removed from under the top without disturbing it', () => {
  resetDialogStack();
  const a = token();
  const b = token();
  pushDialog(a);
  pushDialog(b);
  popDialog(a);
  assert.equal(isTopDialog(b), true);
  assert.equal(isTopDialog(a), false);
});

test('nothing is the top of an empty stack', () => {
  resetDialogStack();
  assert.equal(isTopDialog(token()), false);
});

test('popping an absent token is a no-op', () => {
  resetDialogStack();
  const a = token();
  pushDialog(a);
  popDialog(token());
  assert.equal(isTopDialog(a), true);
});
