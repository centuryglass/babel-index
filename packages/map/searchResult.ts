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
  /** how many terms `tagPartialSum` is a sum OVER - a count, not a fraction */
  tagPartialCount: Int32Array;
  /** `storyRatio` - query-relative, the ranking's short-story term */
  story: Float32Array;
  /** longest contiguous matched run, in characters - the long-story term */
  storyLongChars: Float32Array;
  /** `clipNorm` - min-max normalised across the corpus for this query */
  clip: Float32Array;
  /** the positive half of the signed CLIP certainty curve, in [0, 1] */
  clipCertaintyGate: Float32Array;
  /** the full signed CLIP certainty curve, in [-1, 1] - what the CLIP row's reported percentage reads */
  clipSigned: Float32Array;
  cosine: Float32Array;
}

/**
 * One signal's own ranking over the corpus, independent of the composite
 * `order` - `rankAxis` in `scoring.js`. Both parallel to `order` (by rank, not
 * id), same as `ScoreBreakdown`. `ranks` is 1-based competition ranking
 * (`1, 2, 2, 4`, not `1, 2, 2, 3`); `ties` is how many OTHER rooms share it -
 * together, "this room ranks #4 by tag, tied with 2 others"
 * (docs/search_rules.md "Reporting").
 */
export interface SignalRanks {
  tag: Int32Array;
  story: Int32Array;
  clip: Int32Array;
}

/** `rankHybrid()`'s return value: a completed ranking over the whole corpus. */
export interface RankHybridResult {
  /** Room ids, best first. */
  order: number[];
  /** Parallel to `order` (by rank, not id) - what the density gradient reads. */
  certainty: Float32Array;
  breakdown: ScoreBreakdown;
  ranks: SignalRanks;
  ties: SignalRanks;
  signals: RankSignals;
}

/**
 * `useSearch.js`'s `result` state: a ranking bound to the term it was run
 * for, or the no-signal stub (`certainty`/`breakdown`/`signals`/`ranks`/`ties`
 * all `null`) when the corpus has neither embeddings nor keywords to rank
 * with.
 */
export interface SearchResult {
  order: number[];
  certainty: Float32Array | null;
  breakdown: ScoreBreakdown | null;
  ranks: SignalRanks | null;
  ties: SignalRanks | null;
  signals: RankSignals | null;
  term: string;
}

/** A [start, end) span into a string, for highlighting. */
export interface MatchRange {
  start: number;
  end: number;
}

/**
 * One axis's SHARE of the total weighted score (docs/search_rules.md
 * "Reporting" - "a percentage of the total score contributed by each signal
 * that actually contributed something"), not a percentage of anything
 * absolute - `RankingExplanation.contributions` sorts these greatest first
 * and omits any axis that contributed nothing.
 */
export interface ContributionShare {
  key: 'clip' | 'tag' | 'story';
  label: string;
  /** this axis's weighted term as a share of `breakdown.score`, 0-100 */
  percent: number;
}

/** The tag axis's own rank/tie count (`SignalRanks.tag`), plus what actually matched. */
export interface TagRankingSummary {
  rank: number;
  ties: number;
  /** count of terms that matched a keyword exactly */
  exact: number;
  /** count of terms that matched a keyword as a substring, not exactly */
  partial: number;
}

/** The story axis's own rank/tie count (`SignalRanks.story`), plus the run length that earned it. */
export interface StoryRankingSummary {
  rank: number;
  ties: number;
  /** longest contiguous matched run, in characters (`breakdown.storyLongChars`) */
  length: number;
}

/** The clip axis's own rank/tie count (`SignalRanks.clip`), plus the reading behind it. */
export interface ClipRankingSummary {
  rank: number;
  ties: number;
  /** the raw cosine - absolute, not relative to this query's corpus */
  cosine: number;
  /**
   * the signed certainty curve as a clamped percentage (docs/search_rules.md
   * "Reporting") - positive is confidence the image matches, negative is
   * confidence it does not.
   */
  percent: number;
}

/**
 * `explainRanking()`'s return value: one room's ranking as a reader reads it
 * - a composite line, then one summary per axis that found something. `null`
 * fields are axes with nothing to report, same convention `explainRanking`'s
 * own `null` return uses for a room nothing matched at all.
 */
export interface RankingExplanation {
  /** 1-based - "#4 of 2048" */
  rank: number;
  /** corpus size - "#4 OF 2048" */
  total: number;
  /** the composite `certainty`, as a signed clamped percentage */
  percent: number;
  contributions: ContributionShare[];
  tag: TagRankingSummary | null;
  story: StoryRankingSummary | null;
  clip: ClipRankingSummary | null;
}
