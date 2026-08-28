/**
 * Search's own data protocols: what `rankHybrid()` (`scoring.js`) returns,
 * what `useSearch.js` stores as `result`, and the match ranges/explanation
 * rows built from either.
 *
 * Type-only, imported through JSDoc (`@type {import('./searchResult.ts').X}`)
 * the same way `manifest.ts` is - see AGENTS.md's TypeScript bullet. `scoring.js`
 * is one of the deliberately-loose files the migration plan defers (heavy
 * duck-typing, computed almost entirely from arrays keyed by rank rather than
 * a fixed record shape), so this file types the shapes that cross its
 * boundary rather than converting the module itself.
 */

/** One room's precomputed search text, or `null` for a room with no metadata. */
export interface SearchIndexEntry {
  /** Folded (not tokenised) keyword strings - matched whole as well as by token. */
  keywords: string[];
  /** The story, tokenised and lemmatised once at build time. */
  story: Set<string>;
}

/** `buildSearchIndex()`'s output: parallel to the manifest's `rooms`, by id. */
export type SearchIndex = (SearchIndexEntry | null)[];

/** Which of the three signals found anything for this query. */
export interface RankSignals {
  clip: boolean;
  keyword: boolean;
  story: boolean;
}

/** Per-signal scores, one array per rank - see `rankHybrid`'s doc comment. */
export interface ScoreBreakdown {
  score: Float32Array;
  keyword: Float32Array;
  story: Float32Array;
  clip: Float32Array;
  cosine: Float32Array;
}

/** `rankHybrid()`'s return value: a completed ranking over the whole corpus. */
export interface RankHybridResult {
  /** Room ids, best first. */
  order: number[];
  /** Parallel to `order` (by rank, not id) - what the density gradient reads. */
  certainty: Float32Array;
  breakdown: ScoreBreakdown;
  signals: RankSignals;
}

/**
 * `useSearch.js`'s `result` state: a ranking bound to the term it was run
 * for, or the no-signal stub (`certainty`/`breakdown`/`signals` all `null`)
 * when the corpus has neither embeddings nor keywords to rank with.
 */
export interface SearchResult {
  order: number[];
  certainty: Float32Array | null;
  breakdown: ScoreBreakdown | null;
  signals: RankSignals | null;
  term: string;
}

/** A [start, end) span into a string, for highlighting. */
export interface MatchRange {
  start: number;
  end: number;
}

/** One row of `explainScore()`'s breakdown, as the room card/catalog print it. */
export interface ScoreExplanationRow {
  key: string;
  label: string;
  weighted: number;
  raw: number;
  note: string | null;
}

/** `explainScore()`'s return value: the rows a reader can check the sort against. */
export interface ScoreExplanation {
  rows: ScoreExplanationRow[];
  total: number;
  certainty: number;
}
