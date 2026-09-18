// Flat config, kept small on purpose: recommended JS/TS rules plus just enough
// environment/JSX wiring to stop false-positive no-undef on real globals.
// The lint pass is a required CI check (see .github/workflows/ci.yml's
// `lint` job), so rule tuning beyond `recommended` should stay deliberate -
// a new error-level rule needs the existing tree triaged against it first,
// not just enabled and left to fail CI.
//
// typescript-eslint's `recommended` config is the non-type-checked variant
// (no `parserOptions.project`) on purpose: `npm run typecheck` (`tsc
// --noEmit`) already owns type correctness, so lint stays syntax-only and
// fast - a type-checked config would need a full TS program build on every
// lint run and would just re-report what typecheck already catches.
import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const UNUSED_VARS_OPTIONS = {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
};

export default defineConfig([
  globalIgnores(['node_modules/**', 'assets/**']),
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', UNUSED_VARS_OPTIONS],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', UNUSED_VARS_OPTIONS],
      // The codebase leans on `any` in a few deliberately loose spots
      // (AGENTS.md's TypeScript convention: "a strict type that fights the
      // code's actual tolerance is worse than an honest `object`/JSDoc") -
      // not worth an error-level rule the existing tree hasn't been triaged
      // against.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Every .ts file outside packages/web/src and the two evaluate-in-browser
    // tool scripts below runs in Node: the server, the pure packages/map and
    // packages/config logic, the pipeline, and the offline tools.
    files: [
      'build/**/*.ts',
      'packages/config/**/*.ts',
      'packages/map/**/*.ts',
      'packages/pipeline/**/*.ts',
      'packages/server/**/*.ts',
      'tools/**/*.ts',
    ],
    ignores: ['tools/font-lab/render.ts', 'tools/perf-capture/capture.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // render.ts composites variants onto the center tile via Playwright
    // Chromium, and capture.ts drives a real page over CDP - both run in
    // Node but reference document/window directly (render.ts's own DOM
    // building, capture.ts's page.evaluate callbacks), the same case the
    // pre-TypeScript config carved out for render.mjs.
    files: ['tools/font-lab/render.ts', 'tools/perf-capture/capture.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // e2e specs run under Node (`node --test`) but every spec's page.evaluate
    // callback references document/window directly, not as a separate
    // browser-only file - same shape as render.ts/capture.ts above.
    files: ['packages/web/e2e/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    // Only the two classic hook-correctness rules, not the newer React
    // Compiler rules (immutability, refs, purity, ...) bundled into
    // `recommended` as of v7 - this codebase leans on mutable refs as a
    // deliberate escape hatch (see useMapRenderer.ts), which those rules
    // flag wholesale.
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]);
