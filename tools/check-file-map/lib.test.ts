import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFileMap } from './lib.ts';

test('resolves a flat directory of files', () => {
  const md = [
    "- `packages/server`: the demo server",
    '  * `index.ts`: CLI',
    '  * `app.ts`: Express setup',
  ].join('\n');
  const leaves = parseFileMap(md);
  assert.deepEqual(
    leaves.map((l) => l.path),
    ['packages/server/index.ts', 'packages/server/app.ts'],
  );
  assert.equal(leaves.every((l) => !l.looksLikeDirectory), true);
});

test('a directory bullet with no children is a single opaque leaf', () => {
  const md = "- `infra`: Terraform for the R2 bucket";
  const leaves = parseFileMap(md);
  assert.deepEqual(leaves, [{ path: 'infra', looksLikeDirectory: true }]);
});

test('nested subdirectories resolve two levels deep', () => {
  const md = [
    "- `packages/web`: browser-side code",
    '  * `index.html`: entry point',
    '  - `src/components/`: presentational React components',
    '    * `MapView.tsx`: the map canvas view',
  ].join('\n');
  const leaves = parseFileMap(md);
  assert.deepEqual(
    leaves.map((l) => l.path),
    ['packages/web/index.html', 'packages/web/src/components/MapView.tsx'],
  );
});

test('a file-shaped parent is documented itself, and its child resolves beside it', () => {
  const md = [
    '- `tools/embed/cosine-range.ts`: measure raw cosine range',
    '  * `cosine-stats.ts`: percentile math',
  ].join('\n');
  const leaves = parseFileMap(md);
  assert.deepEqual(
    leaves.map((l) => l.path),
    ['tools/embed/cosine-range.ts', 'tools/embed/cosine-stats.ts'],
  );
});

test('a bullet with two backtick paths documents both', () => {
  const md =
    '- `release-please-config.json` / `.release-please-manifest.json`: release-please state';
  const leaves = parseFileMap(md);
  assert.deepEqual(
    leaves.map((l) => l.path),
    ['release-please-config.json', '.release-please-manifest.json'],
  );
});

test('continuation prose lines are not mistaken for bullets', () => {
  const md = [
    "- `packages/pipeline`: Generates the pyramid of tile images at smaller",
    '  resolutions for use when zoomed-out, packing the coarse levels into',
    '  shared sheets - not a `- ` at the start, just wrapped text.',
    '  * `index.ts`: CLI',
  ].join('\n');
  const leaves = parseFileMap(md);
  assert.deepEqual(
    leaves.map((l) => l.path),
    ['packages/pipeline/index.ts'],
  );
});

test('a category header between sections does not affect nesting', () => {
  const md = [
    '### Build:',
    "- `build`: the Node-side TypeScript hook",
    '  * `register.mjs`: the loader entry point',
    '### Docs:',
    "- `docs/concept.md`: original project concept",
  ].join('\n');
  const leaves = parseFileMap(md);
  assert.deepEqual(
    leaves.map((l) => l.path),
    ['build/register.mjs', 'docs/concept.md'],
  );
});

test('a trailing-slash directory strips the slash before joining', () => {
  const md = [
    "- `packages/web`: browser-side code",
    '  - `src/components/`: presentational React components',
    '    * `MapView.tsx`: the map canvas view',
  ].join('\n');
  const leaves = parseFileMap(md);
  assert.deepEqual(
    leaves.map((l) => l.path),
    ['packages/web/src/components/MapView.tsx'],
  );
});
