/**
 * Search's own data protocols: what `rankHybrid()` (`scoring.ts`) returns,
 * what `useSearch.ts` stores as `result`, and the match ranges/explanation
 * rows built from either.
 *
 * Types only, reached through `import type`, like `manifest.ts`.
 */

/** One story word, lemmatised, keeping its span into the folded story text. */
export interface StorySequenceEntry {
  lemma: string;
  start: number;
  end: number;
}

/**
 * A room's story, folded, tokenised and lemmatised once at build time, held
 * three ways.
 *
 * - `sequence` keeps story order, which the contiguous-run measurement
 *   (`scoring.ts`'s `longestMatchRun`) needs.
 * - `set` holds the same lemmas for `storyWordMatches`' O(1) membership test,
 *   built once so no query rebuilds it.
 * - `text` is the whole folded story, padded by `phraseHaystack`, which
 *   `storyPhraseMatches` searches for quoted phrases.
 */
export interface StoryIndex {
  sequence: StorySequenceEntry[];
  set: Set<string>;
  text: string;
}

/** One room's precomputed search text, or `null` for a room with no metadata. */
export interface SearchIndexEntry {
  /** Folded (not tokenised) keyword strings - matched whole as well as by token. */
  keywords: string[];
  /** Folded room title, or `null` - one string, not a list; a room has at most one. */
  title: string | null;
  story: StoryIndex;
}

/**
 * One word, or one quoted phrase treated as a single unit - see `parseQuery`
 * in `scoring.ts` and docs/search_rules.md, "The parsed query".
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
  /** the query as typed */
  raw: string;
  /** fold(raw) */
  folded: string;
  terms: Term[];
}

/** `buildSearchIndex()`'s output: parallel to the manifest's `rooms`, by id. */
export type SearchIndex = (SearchIndexEntry | null)[];

/** Which of the four signals found anything for this query. */
export interface RankSignals {
  clip: boolean;
  keyword: boolean;
  title: boolean;
  story: boolean;
}

/**
 * What each room's strength was built from, one array per rank - see
 * `rankHybrid`'s doc comment. `tag`/`title`/`story`/`clip` are the axes'
 * weighted pulls `matchStrength` combines; the rest are the raw evidence
 * behind them, for display.
 */
export interface ScoreBreakdown {
  tag: Float32Array;
  title: Float32Array;
  story: Float32Array;
  clip: Float32Array;
  /** how many query terms were exact keyword matches (an exact multi-word run counts as one) */
  tagExact: Float32Array;
  /** how many terms matched a keyword as a substring only - a count, not a fraction */
  tagPartialCount: Int32Array;
  /** 0 or 1 - did some term match the room's whole title (docs/search_rules.md "Title matching") */
  titleExact: Float32Array;
  /** the largest substring fraction over every term tested against the title, not a combination - there is only one title */
  titlePartial: Float32Array;
  /** how many of the query's distinct unquoted words and quoted phrases the story contains (`storyWordMatches`, `storyPhraseMatches`) */
  storyWords: Int32Array;
  /** longest contiguous matched run, in characters */
  storyLongChars: Float32Array;
  /** CLIP's curve (`clipCurveStrength`), in [0, 1], before `weights.clip` - what the CLIP row's reported percentage reads */
  clipStrength: Float32Array;
  cosine: Float32Array;
}

/**
 * One signal's own ranking over the collection, independent of the composite
 * `order`, and - like `ScoreBreakdown` - parallel to `order` by rank, not by
 * id. 1-based competition ranking with a per-rank tie count; see `rankAxis`
 * in `scoring.ts` for the rule, and docs/search_rules.md "Reporting" for how
 * it is shown.
 */
export interface SignalRanks {
  tag: Int32Array;
  title: Int32Array;
  story: Int32Array;
  clip: Int32Array;
}

/** `rankHybrid()`'s return value: a completed ranking over the whole collection. */
export interface RankHybridResult {
  /** Room ids, best first. */
  order: number[];
  /** Parallel to `order` (by rank, not id), and non-increasing - what the density gradient reads. */
  strength: Float32Array;
  breakdown: ScoreBreakdown;
  ranks: SignalRanks;
  ties: SignalRanks;
  signals: RankSignals;
}

/**
 * `useSearch.ts`'s `result` state: a ranking bound to the term it was run
 * for, or the no-signal stub (`strength`/`breakdown`/`signals`/`ranks`/`ties`
 * all `null`) when the collection has neither embeddings nor keywords to rank
 * with.
 */
export interface SearchResult {
  order: number[];
  strength: Float32Array | null;
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
 * One axis's pull as a share of the four axes' pulls added together, per
 * docs/search_rules.md "Reporting" - a percentage of the pulls, not of
 * `strength`, which a soft OR does not split into parts.
 * `RankingExplanation.contributions` sorts these greatest first and omits
 * any axis that pulled nothing.
 */
export interface ContributionShare {
  key: 'clip' | 'tag' | 'title' | 'story';
  label: string;
  /** this axis's pull as a share of all four pulls, 0-100 */
  percent: number;
}

/** The tag axis's own rank/tie count (`SignalRanks.tag`), plus what actually matched. */
export interface TagRankingSummary {
  rank: number;
  ties: number;
  /** count of terms that were exact keyword matches */
  exact: number;
  /** count of terms that matched a keyword as a substring only */
  partial: number;
}

/**
 * The title axis's own rank/tie count (`SignalRanks.title`), plus what
 * actually matched. Unlike `TagRankingSummary`, `exact` is a bool and
 * `partial` a single fraction - a room has one title, not a list of them
 * (docs/search_rules.md "Title matching").
 */
export interface TitleRankingSummary {
  rank: number;
  ties: number;
  /** did some term match the whole title */
  exact: boolean;
  /** the best substring fraction over every term, 0 when nothing matched */
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
  /** the raw cosine - absolute, not relative to this query's collection */
  cosine: number;
  /** the strength curve as a clamped percentage (docs/search_rules.md "Reporting") */
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
  /** collection size - the "of 2048" in "#4 of 2048" */
  total: number;
  /** the composite `strength`, as a clamped percentage */
  percent: number;
  contributions: ContributionShare[];
  tag: TagRankingSummary | null;
  title: TitleRankingSummary | null;
  story: StoryRankingSummary | null;
  clip: ClipRankingSummary | null;
}
