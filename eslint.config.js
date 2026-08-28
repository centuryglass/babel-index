// Flat config, kept small on purpose: recommended JS rules plus just enough
// environment/JSX wiring to stop false-positive no-undef on real globals.
// The lint pass is a required CI check (see .github/workflows/ci.yml's
// `lint` job), so rule tuning beyond `recommended` should stay deliberate -
// a new error-level rule needs the existing tree triaged against it first,
// not just enabled and left to fail CI.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['node_modules/**', 'assets/**', 'docs/figures/**'],
  },
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
      'no-unused-vars': [
        'error',
        {
          'argsIgnorePattern': '^_',
          'varsIgnorePattern': '^_',
          'caughtErrorsIgnorePattern': '^_',
        }
      ]
    }
  },
  {
    files: ['packages/web/src/**/*.{js,jsx}'],
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
    // deliberate escape hatch (see useMapRenderer.js), which those rules
    // flag wholesale.
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
