/**
 * Types for `wink-lemmatizer`, which ships none.
 *
 * `jsconfig.json`'s `paths` redirects the specifier here for `tsc` only; the
 * loader hook (`build/ts-loader.mjs`) still resolves the real package at
 * runtime. The redirect is type-only because TypeScript 6 (pinned, see
 * AGENTS.md "Commands") reports TS2323 in the real package's `wink-lexicon`
 * data file. An ambient `declare module` does not help: `allowJs` prefers the
 * real JS implementation over it.
 */
export function noun(word: string): string;
export function verb(word: string): string;
export function adjective(word: string): string;
