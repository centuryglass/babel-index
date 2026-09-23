import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CLIP_CACHE_DIR, withClipCache } from './clip-cache.ts';

test('the CLIP cache sits at the repo root, outside node_modules', () => {
  assert.equal(basename(CLIP_CACHE_DIR), '.clip_model_cache');
  assert.ok(existsSync(join(dirname(CLIP_CACHE_DIR), 'package.json')), CLIP_CACHE_DIR);
  assert.ok(!CLIP_CACHE_DIR.includes('node_modules'));
});

test('withClipCache points the module at the cache and hands it back', () => {
  const transformers = { env: { cacheDir: null as string | null } };
  assert.equal(withClipCache(transformers), transformers);
  assert.equal(transformers.env.cacheDir, CLIP_CACHE_DIR);
});
