/**
 * A type-only stand-in for `wink-lemmatizer`, which ships no types itself -
 * `jsconfig.json`'s `paths` maps the bare specifier here so `tsc` resolves
 * to this file instead of the real package. Resolving to the real one
 * doesn't work: `allowJs` prefers an actual JS implementation over a
 * same-named ambient `declare module` (see git history for the attempt),
 * and that implementation's own `require('wink-lexicon')` pulls in a data
 * file with two duplicate property assignments (harmless, same value
 * written twice) that `checkJs` under TypeScript 6 - pinned for
 * typescript-eslint, see AGENTS.md's *Commands* - reports as
 * `TS2323`, and TypeScript 7 didn't. `paths` is a type-only redirect: the
 * Node loader hook (`build/ts-loader.mjs`) still resolves the real package
 * at runtime, unaffected by this file.
 */
export function noun(word: string): string;
export function verb(word: string): string;
export function adjective(word: string): string;
