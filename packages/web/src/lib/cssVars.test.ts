import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOVER_GLOW_RGB, HOVER_GLOW_FILL, HOVER_GLOW_STROKE, applyCssVars } from './cssVars.ts';

test('HOVER_GLOW_FILL/STROKE are HOVER_GLOW_RGB at the fill/stroke alpha', () => {
  const [r, g, b] = HOVER_GLOW_RGB;
  assert.equal(HOVER_GLOW_FILL, `rgba(${r},${g},${b},0.28)`);
  assert.equal(HOVER_GLOW_STROKE, `rgba(${r},${g},${b},0.55)`);
});

test('applyCssVars writes HOVER_GLOW_RGB to --hover-glow-rgb on document.documentElement', () => {
  const style = new Map<string, string>();
  const originalDocument = globalThis.document;
  const stub = {
    documentElement: { style: { setProperty: (name: string, value: string) => style.set(name, value) } },
  };
  globalThis.document = stub as unknown as Document;
  try {
    applyCssVars();
  } finally {
    globalThis.document = originalDocument;
  }
  assert.equal(style.get('--hover-glow-rgb'), HOVER_GLOW_RGB.join(', '));
});
