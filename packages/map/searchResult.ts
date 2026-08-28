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

/** One story word, lemmatised, keeping its span into the FOLDED story text. */
export interface StorySequenceEntry {
  lemma: string;
  start: number;
  end: number;
}

/**
 * A room's story, tokenised and lemmatised once at build time - both as an
 * ORDERED sequence (what a contiguous-run measurement needs, see
 * `longestMatchRun`/`storyPhraseRun` in `scoring.js`) and as a `Set` of the
 * same lemmas for `storyScore`'s O(1) membership test. The set is derivable
 * from the sequence; kept alongside rather than rebuilt per query.
 */
export interface StoryIndex {
  sequence: StorySequenceEntry[];
  set: Set<string>;
}

/** One room's precomputed search text, or `null` for a room with no metadata. */
export interface SearchIndexEntry {
  /** Folded (not tokenised) keyword strings - matched whole as well as by token. */
  keywords: string[];
  story: StoryIndex;
}

/**
 * One word, or one quoted phrase treated as a single unit - see `parseQuery`
 * in `scoring.js` and docs/search_rules.md, "The parsed query".
 */
export interface Term {
  /** as typed, one word or the contents of one "quoted phrase" */
  text: string;
  /** fold(text) */
  folded: string;
  /** was this a "quoted phrase" in the original query? */
  quoted: boolean;
  /** folded, tokenised sub-words - always [folded] for an unquoted term */
  words: string[];
}

/** `parseQuery()`'s return value. */
export interface ParsedQuery {
  /** the query exactly as typed */
  raw: string;
  /** fold(raw) - the whole query, still used for the existing "whole query against one keyword" reading */
  folded: string;
  terms: Term[];
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
  tagExact: Float32Array;
  tagPartialSum: Float32Array;
  /** `storyRatio` - query-relative, the ranking's short-story term */
  story: Float32Array;
  /** longest contiguous matched run, in characters - the long-story term */
  storyLongChars: Float32Array;
  /** `clipNorm` - min-max normalised across the corpus for this query */
  clip: Float32Array;
  /** the positive half of the signed CLIP certainty curve, in [0, 1] */
  clipCertaintyGate: Float32Array;
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
