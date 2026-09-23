/**
 * Text scoring for search: keywords and story against a query.
 *
 * Separate from `ordering.ts` because it is the only meaty string code in the
 * package - folding, tokenising, stopwords. The blend that combines these
 * with CLIP lives here too, because the normalisation its weights depend on
 * is defined in this file.
 *
 * ### Why every signal is normalised before it is weighted
 *
 * The four signals are not on the same scale. Keyword, title and story scores
 * are ratios and land in [0, 1] by construction. A CLIP cosine is nominally
 * [-1, 1], but on a corpus of near-identical library walls the scores for one
 * query cluster into a narrow band - the images differ far less than CLIP's
 * range allows - so no single weight balances it against the other three: large
 * enough to matter and it swamps keyword bonuses, small enough to balance one
 * and it is lost inside its own spread.
 *
 * So the CLIP term is min-max normalised across the corpus *for that query*:
 * one extra pass over an array that has just been scored anyway, after which
 * a weight of 0.25 means "a quarter of what a perfect keyword match is
 * worth". See `packages/config` for the weights themselves.
 *
 * ### One sort, not tiers
 *
 * Everything is ranked by the blended score. Bucketing - exact matches first,
 * then CLIP within the remainder - would let a room with one weak partial
 * keyword beat a room CLIP is certain about, and would splice a few results
 * onto the front of an unchanged order instead of rearranging the whole
 * library, best in the middle and worst at the edge.
 *
 * ### Ranking is relative; strength is not
 *
 * The blend answers "which room is most like the query". The map's density
 * gradient (`ordering.ts`) asks a different question - "how good is this
 * room's match, on its own terms" - and the blended score cannot answer it:
 * min-max normalisation destroys the very information required, since some
 * room always scores 1 whether the query was `art nouveau` or `cghjj`.
 * Strength is therefore computed from the *absolute* form of each signal,
 * alongside the ranking and from the same pass:
 *
 *   - keyword and story readings are already absolute. An exact keyword match
 *     is 1 because it is a match, not because it beat the corpus.
 *   - CLIP contributes its raw cosine against a pair of thresholds. This is
 *     the only place the raw number is used rather than the normalised one,
 *     and the reason `embeddingScores` dequantises: a nonsense string still
 *     produces a valid text vector, and what marks it as nonsense is that its
 *     cosine against every image is low in absolute terms.
 *
 * The thresholds want calibrating against a real corpus, which is why they
 * live in config (`search.density`).
 *
 * No DOM. Two imports: the dot products from `ordering.ts` so they have one
 * implementation, and a lemmatizer. `wink-lemmatizer` looks a word up per
 * part of speech rather than collapsing by suffix like a stemmer would; a
 * suffix-collapsing stem folds `animation` and `animal` together, which is a
 * false positive. See `lemmatise` for the lookup order.
 */
// Default import only: wink-lemmatizer is CommonJS, and Node's ESM interop
// does not statically discover its named exports.
import winkLemmatizer from 'wink-lemmatizer';
import anyAscii from 'any-ascii';
import { embeddingScores } from './ordering.ts';
import type { Config } from '../config/config.ts';
import type {
  MatchRange,
  ParsedQuery,
  RankHybridResult,
  RankingExplanation,
  ScoreBreakdown,
  SearchIndex,
  SignalRanks,
  StoryIndex,
  StorySequenceEntry,
  Term,
} from './searchResult.ts';

const { noun, verb, adjective } = winkLemmatizer;

/** The anchor band `clipCurveStrength`/`matchStrength` read a raw cosine against. */
export interface ClipBand {
  centre: number;
  high: number;
}

/**
 * A word's base form, trying noun then verb then adjective rules and keeping
 * the first that changes it. Unknown words come back unchanged - matching
 * still falls through to whole-word equality, it just doesn't stem.
 */
export function lemmatise(word: string): string {
  const n = noun(word);
  if (n !== word) return n;
  const v = verb(word);
  if (v !== word) return v;
  const a = adjective(word);
  if (a !== word) return a;
  return word;
}

/**
 * The measured anchors of CLIP's strength curve (docs/search_rules.md
 * "Image-content (CLIP) matching" + "Computing strength"): `centre` is the
 * no-opinion point (0), `high` is a genuine match's typical confidence (1).
 * Linear between them, 0 below `centre` - see `clipCurveStrength`.
 *
 * Both are measured against a real corpus via
 * `tools/embed/cosine-range.ts` (CLIP ViT-B/32), read off
 * `cosine-range-report.json`:
 *   - `centre` is the median of the overall keyword x room distribution
 *     (mostly-unrelated pairs - `overall.p50`), cross-checked by a
 *     `--nonsense` keysmash probe that lands on the same point.
 *   - `high` (`--universal`, `universal.ceiling`) is the median ceiling
 *     across near-universal keywords true of nearly every room (`bookshelf`,
 *     `book`, `library`, ...), preferred over the raw max so one outlier pair
 *     does not define "as sure as it gets".
 *
 * `centre` is a conservative zero. The `--irrelevant` probe
 * (`irrelevant.ceiling`, the median best match of ten strong concepts CLIP
 * recognises but that share no visual structure with library walls: `race
 * car`, `swimming pool`, `sandy beach`, ...) measured `0.171`, below
 * `centre`, so a room at `centre` is noise rather than a weak match. Re-run
 * that probe when recalibrating `centre`.
 *
 * A cosine below `centre` is absence of evidence, not evidence of a
 * mismatch - CLIP's joint space has no meaningful antipode - so it reads as
 * 0, never as a negative claim.
 */
export const CLIP_STRENGTH: ClipBand = { centre: 0.205, high: 0.279 };

/**
 * Words carrying no retrieval signal, dropped from queries.
 *
 * A short hand-maintained list, not a linguistic resource. It guards two
 * things: a query like "the room of glass" spending two thirds of its weight
 * on "the" and "of", and, for keywords, `the` scoring a partial match against
 * `theatrical`.
 */
export const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'was', 'are', 'its',
  'into', 'onto', 'their', 'them', 'they', 'has', 'had', 'have', 'been', 'were',
  'but', 'not', 'all', 'any', 'some', 'more', 'most', 'such', 'than', 'then',
  'there', 'here', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where',
]);

/**
 * Lowercase, strip diacritics, transliterate to ASCII, collapse whitespace.
 *
 * Decomposing to NFD and dropping the combining marks means `rosé` and `rose`
 * are the same word, which matters for a corpus whose vocabulary is full of art
 * terms borrowed from French and German. NFD only exposes marks riding on a
 * base letter, though - `ł`, `ø`, `đ` are letters in their own right with
 * nothing to strip, so `Zdzisław` survives NFD unchanged. `any-ascii` is the
 * fallback for that remainder: a per-code-point transliteration table, so
 * `Zdzisław` and `Zdzislaw` fold to the same string.
 */
export function fold(text: unknown): string {
  return foldWithMap(text).folded.trim();
}

/** Combining marks, stripped after NFD has exposed them. */
const COMBINING = /[\u0300-\u036f]/g;

/**
 * `fold`, but keeping track of where every folded character came from.
 *
 * Highlighting needs this and nothing else does. Matching happens on folded
 * text; the `<mark>` has to land on the original text, and a folded index is
 * not an original index - every step of folding can change length.
 * Decomposed `cafe\u0301` is five characters and folds to four; `\u0130`
 * lowercases to two from one. Used as one another, every highlight on a
 * corpus with an accent in it lands slightly wrong.
 *
 * So this folds one code point at a time and records, for each UTF-16 unit
 * of the output, the index of the source unit that produced it. `map.length`
 * is always `folded.length`, and `map[i] <= map[i + 1]`, which is what lets a
 * range in folded space be read straight back as a range in the original.
 *
 * Per code point rather than over the whole string makes folding position
 * independent, which is what an index wants - the same word folds the same
 * way wherever it appears. Whole-string lowercasing is context sensitive in a
 * couple of places (Greek sigma takes its final form at the end of a word);
 * canonical reordering across a combining sequence is moot here, since every
 * combining mark is stripped a line later. `any-ascii` is called per code
 * point for the same reason: it accepts a whole string, but feeding it one
 * code point at a time keeps its output attributable to a single source
 * index, even though only CJK and emoji produce its multi-character
 * transliterations.
 *
 * Does not trim: `fold` trims its own result, and trimming inside this would
 * shift every recorded index off the text it describes.
 */
export function foldWithMap(text: unknown): { folded: string; map: number[] } {
  const src = String(text ?? '');
  const map = [];
  let folded = '';

  for (let i = 0; i < src.length; ) {
    const cp = String.fromCodePoint(src.codePointAt(i));
    let out = cp.normalize('NFD').replace(COMBINING, '').toLowerCase();
    if ([...out].some((c) => c.codePointAt(0) > 0x7f)) out = anyAscii(out).toLowerCase();
    for (let k = 0; k < out.length; k++) map.push(i);
    folded += out;
    i += cp.length;
  }

  return { folded, map };
}

/** Options shared by `tokenise` and `tokeniseWithPositions`. */
export interface TokeniseOpts {
  /** tokens shorter than this are dropped, or `a` matches most keywords in the corpus by substring */
  minLength?: number;
  /** drop stopwords (true by default) */
  stopwords?: boolean;
}

/** Fold and split into searchable tokens. */
export function tokenise(text: unknown, { minLength = 3, stopwords = true }: TokeniseOpts = {}): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= minLength && !(stopwords && STOPWORDS.has(t)));
}

/**
 * Parse a raw query into an ordered list of terms - one word, or one quoted
 * phrase treated as a single unit (docs/search_rules.md, "The parsed query").
 *
 * Quotes are found before folding removes anything meaningful: every
 * `"..."` span becomes one term with `quoted: true`, and everything outside
 * quotes is split on whitespace into single-word terms. An unterminated quote (`art "nouveau`) is not
 * a parse error - the dangling `"` is just a character with nothing either
 * side of it to pair with, so the rest of the query reads as ordinary words.
 *
 * The stopword/`minTokenLength` floor is not applied here - it still happens
 * per word for scoring (`tokenise` inside `storyScore`).
 * Quoting changes how a term is matched, not the vocabulary floor.
 */
export function parseQuery(raw: unknown): ParsedQuery {
  const text = String(raw ?? '');
  const terms: Term[] = [];

  const pushWords = (chunk: string) => {
    for (const word of chunk.split(/\s+/)) {
      if (!word) continue;
      const folded = fold(word);
      if (!folded) continue;
      terms.push({ text: word, folded, quoted: false, words: [folded] });
    }
  };

  let last = 0;
  for (const m of text.matchAll(/"([^"]*)"/g)) {
    pushWords(text.slice(last, m.index));
    const phrase = m[1];
    const folded = fold(phrase);
    if (folded) {
      const words = tokenise(phrase, { stopwords: false, minLength: 1 });
      terms.push({ text: phrase, folded, quoted: true, words: words.length ? words : [folded] });
    }
    last = m.index + m[0].length;
  }
  pushWords(text.slice(last));

  return { raw: text, folded: fold(text), terms };
}

/**
 * How one term matches a room's keywords - exact, partial, or neither - as
 * one classification, whether the term is a single word or a quoted phrase.
 *
 * The one substring rule every tag and title match is read through: a term
 * matches a keyword exactly when it equals it, partially by the fraction of
 * the keyword it covers. A quoted phrase is tested as its whole `folded`
 * text against each keyword, the same way an unquoted single-word term
 * already is - and so is the whole query, which `rankHybrid` passes here as
 * one synthetic term (docs/search_rules.md "Tag matching"). So "quoting an unquoted-equivalent single word changes nothing"
 * (docs/search_rules.md, "Quoted phrases") holds by construction - the two
 * cases share this one code path.
 *
 * @param keywords folded room keywords
 * @returns `partial` is the best substring fraction found, 0 when there is no
 *   match at all (exact implies `partial` is meaningless and left at 0)
 */
/**
 * The terms the tag and title rules classify for one query, and the
 * whole-query reading that sits beside them.
 *
 * One home for "what does this query offer a keyword", because two of them
 * drift silently: `rankHybrid` scores from this, and `useSearch`'s
 * highlighter marks from it, so a term that cannot score cannot mark
 * (docs/search_requirements.md SR-35).
 *
 * Stopwords and the `minTokenLength` floor apply per word, as they do for
 * `queryTokens`. Quoting changes how a term is matched, not the vocabulary
 * floor (docs/search_rules.md "The parsed query"), so a quoted phrase is
 * always eligible regardless of its own length.
 *
 * `whole` is the entire folded query as one candidate against one whole
 * keyword - what makes a multi-word tag typed plainly an exact match
 * (docs/search_rules.md "Tag matching"). It exists only for a query of more
 * than one eligible term; with one, it would be that term.
 */
export function tagTermsOf(
  parsed: ParsedQuery,
  queryTokens: string[] = [],
  minTokenLength = 3
): { terms: Term[]; whole: Term | null } {
  const terms = parsed.terms.filter(
    (t) => t.quoted || (t.folded.length >= minTokenLength && !STOPWORDS.has(t.folded))
  );
  const whole =
    terms.length > 1 && parsed.folded
      ? { text: parsed.raw, folded: parsed.folded, quoted: true, words: queryTokens }
      : null;
  return { terms, whole };
}

export function classifyTagTerm(
  term: Term | null | undefined,
  keywords: string[] | null | undefined
): { exact: boolean; partial: number } {
  if (!term?.folded || !keywords?.length) return { exact: false, partial: 0 };

  let partial = 0;
  for (const k of keywords) {
    if (!k) continue;
    if (k === term.folded) return { exact: true, partial: 0 };
    if (k.includes(term.folded)) partial = Math.max(partial, term.folded.length / k.length);
  }
  return { exact: false, partial };
}

/**
 * Fold and tokenise, but keep each surviving token's [start, end) span into
 * the folded text rather than throwing position away.
 *
 * `tokenise()` is `fold(text).split(...)`, which is enough for a bag of words
 * but not for "how many characters does this run of the story span" - the
 * question `storyLongChars` (docs/search_rules.md "Story matching") asks.
 * Walking the same word-boundary regex `storyMatchRanges` already uses keeps
 * this in agreement with what counts as a word everywhere else in the file.
 */
interface WordSpan {
  word: string;
  start: number;
  end: number;
}

function tokeniseWithPositions(text: unknown, { minLength = 3, stopwords = true }: TokeniseOpts = {}): WordSpan[] {
  const folded = fold(text);
  const out: WordSpan[] = [];
  for (const m of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0];
    if (word.length < minLength || (stopwords && STOPWORDS.has(word))) continue;
    out.push({ word, start: m.index, end: m.index + word.length });
  }
  return out;
}

/** The slice of a room's metadata `buildSearchIndex` actually reads - `RoomMeta` satisfies it. */
export interface SearchIndexSource {
  keywords?: { text: string }[] | null;
  title?: string | null;
  story?: string | null;
}

/**
 * Build the per-room search index once, when metadata arrives.
 *
 * Folding and tokenising 5,000 stories on every query would be a megabyte and a
 * half of string work per search; doing it once at load leaves each query as set
 * lookups. Rooms without metadata stay null, so the array is still indexed by
 * room id.
 *
 * Stories are kept as an ordered *sequence* of `{lemma, start, end}`, not a
 * bag - `storyScore`'s ratio only needs membership (`set`, kept alongside so
 * that stays an O(1) lookup), but the longest-contiguous-run measurement a
 * long story match needs (`longestMatchRun`, `storyPhraseRun`) has to know
 * which words sit next to which. Positions are into the folded story, not
 * the original - good enough for a character-count threshold, and
 * `storyMatchRanges` (which does need the original for highlighting)
 * re-walks the source text itself rather than reading this index.
 *
 * @param joined output of `joinMetadata()`
 */
export function buildSearchIndex(joined: (SearchIndexSource | null)[] | null | undefined): SearchIndex {
  return (joined ?? []).map((entry) => {
    if (!entry) return null;
    // Lemmatised, not just tokenised: a search matches a story word by base
    // form, so `cats` finds `cat` but `catalogue` does not. See `storyScore`.
    const sequence = tokeniseWithPositions(entry.story ?? '').map(({ word, start, end }) => ({
      lemma: lemmatise(word),
      start,
      end,
    }));
    return {
      // Folded but not tokenised: a keyword is matched whole as well as by
      // token, so that a query of "art nouveau" scores 1 against the keyword
      // "art nouveau" rather than the 0.45 its two tokens would average to.
      keywords: (entry.keywords ?? []).map((k) => fold(k.text)),
      // Folded, same as a keyword - one string rather than a list, since a
      // room has at most one title. See "Title matching".
      title: entry.title ? fold(entry.title) : null,
      story: { sequence, set: new Set(sequence.map((t) => t.lemma)) },
    };
  });
}

/**
 * How well a query matches a room's story, in [0, 1].
 *
 * Normalised by the query, not by the text - the opposite of the keyword
 * rule. Dividing a match by the length of the story would score the same hit
 * lower in a longer story; the question being asked is "how much of what you
 * asked for is in here".
 *
 * Each token is weighted by its own length, so `cartographer` counts for more
 * than `oil`. Matching is by lemma, so `room` finds `rooms`, `survey` finds
 * `surveyed`, and the reverse; `cat` does not match `catalogue`, nor
 * `animation` `animal`. The story index is lemmatised once at build time
 * (`buildSearchIndex`); the query's few tokens are lemmatised here, and
 * weighting stays keyed to the original token length so the query-
 * normalisation above still holds.
 *
 * @param queryTokens raw (folded, untokenised-past-splitting) tokens
 * @param storyIndex the room's story
 */
export function storyScore(queryTokens: string[], storyIndex: StoryIndex | null | undefined): number {
  const set = storyIndex?.set;
  if (!set?.size || !queryTokens.length) return 0;

  let matched = 0;
  let total = 0;
  for (const token of queryTokens) {
    total += token.length;
    if (set.has(lemmatise(token))) matched += token.length;
  }
  return total ? matched / total : 0;
}

/**
 * The character span of the longest *contiguous* run of story words whose
 * lemma is one of `matchLemmas` - what tells "cat" (one word, moderate
 * strength) from "a room walled in glass" (a whole matched clause,
 * saturating).
 *
 * "Contiguous" means adjacent in the story's own filtered token sequence,
 * not in the raw text - a stopword or a too-short word between two matches
 * (`a room of glass`) does not break the run, because it was never part of
 * the index either. `matchLemmas` is unordered: this measures "most of a
 * sentence matched", not "matched in the order the query gave it" - that
 * stricter, ordered test is `storyPhraseRun`, for a quoted phrase.
 *
 * @returns characters spanned by the longest run, 0 if none
 */
export function longestMatchRun(
  sequence: StorySequenceEntry[] | null | undefined,
  matchLemmas: Set<string> | null | undefined
): number {
  if (!sequence?.length || !matchLemmas?.size) return 0;

  let best = 0;
  let runStart = -1;
  for (let i = 0; i <= sequence.length; i++) {
    const hit = i < sequence.length && matchLemmas.has(sequence[i].lemma);
    if (hit) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      best = Math.max(best, sequence[i - 1].end - sequence[runStart].start);
      runStart = -1;
    }
  }
  return best;
}

/**
 * Whether a quoted phrase's words appear consecutively in the story, by
 * lemma, in the order the phrase gave them (docs/search_rules.md, "Quoted
 * phrases"). Unlike `longestMatchRun`, order matters: `"glass room"` must
 * not match a story where only `room glass` appears. `rankHybrid` takes the
 * longer of this and `longestMatchRun` as `storyLongChars`, so a quote does
 * not narrow story matching (issue #327).
 *
 * @param phraseLemmas the phrase's own words, lemmatised, in order
 * @returns characters spanned by the match, 0 if the phrase is not found
 */
export function storyPhraseRun(sequence: StorySequenceEntry[] | null | undefined, phraseLemmas: string[] | null | undefined): number {
  if (!sequence?.length || !phraseLemmas?.length) return 0;

  outer: for (let i = 0; i + phraseLemmas.length <= sequence.length; i++) {
    for (let j = 0; j < phraseLemmas.length; j++) {
      if (sequence[i + j].lemma !== phraseLemmas[j]) continue outer;
    }
    return sequence[i + phraseLemmas.length - 1].end - sequence[i].start;
  }
  return 0;
}

// --- Where the query matched, for highlighting --------------------------------
//
// Two range finders, one per match rule, shadowing the two scorers above
// them. A keyword matches by substring and a story word by lemma; one
// highlighter over both would mark text `classifyTagTerm` never looked at
// and miss text `storyScore` credited. They live here rather than in a component
// for one reason: a view that re-derives "what matched" drifts from the
// thing that ranked, silently - marked text that scored nothing, or a ranked
// room with nothing marked.
//
// Both take the same `foldedQuery` and `queryTokens` the ranking was
// computed from, so a token dropped as a stopword or under `minTokenLength`
// cannot highlight: it did not score, so it does not mark. Both return
// ranges into the original string - sorted, merged, non-overlapping - which
// is what `<Highlight>` renders and what makes them assertable without a DOM.

/**
 * Merge sorted-by-start ranges, dropping empties and collapsing overlaps.
 *
 * Two query tokens routinely hit the same span (`art` and `artist` against
 * `artists`), and nested or duplicated `<mark>` elements are not what anyone
 * wants to render or to read out.
 */
function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: MatchRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Turn a [start, end) span of folded text into one of the original.
 *
 * The end is exclusive, so it is the source index of the character *after* the
 * span - `map[end]` when there is one, and the string's length when the span
 * runs to the end.
 */
function toSource(map: number[], srcLength: number, start: number, end: number): MatchRange {
  return {
    start: map[start] ?? srcLength,
    end: end < map.length ? map[end] : srcLength,
  };
}

/** Every occurrence of `needle` in `hay`, as folded-space ranges. */
function occurrences(hay: string, needle: string): MatchRange[] {
  const found: MatchRange[] = [];
  if (!needle) return found;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1))
    found.push({ start: i, end: i + needle.length });
  return found;
}

/**
 * Where a query matched one keyword, mirroring `classifyTagTerm`'s substring rule.
 *
 * The union of both of that function's readings - the whole query as a
 * substring, and each query token as a substring - not only whichever won
 * the score. A query contains its own tokens, so the two almost always
 * overlap into one range anyway; and the reader's question is "why is this
 * chip here", not "which arithmetic produced the number".
 *
 * @param text the keyword as written, unfolded
 * @returns ranges into `text`
 */
export function keywordMatchRanges(text: unknown, foldedQuery: string, queryTokens: string[] = []): MatchRange[] {
  const src = String(text ?? '');
  if (!src) return [];
  const { folded, map } = foldWithMap(src);
  if (!folded) return [];

  const hits = occurrences(folded, foldedQuery);
  for (const token of queryTokens) hits.push(...occurrences(folded, token));

  return mergeRanges(hits.map((h) => toSource(map, src.length, h.start, h.end)));
}

/**
 * Where a query matched a story, mirroring `storyScore`'s lemma rule.
 *
 * Walks the text on the same word boundary `tokenise` splits on, and marks a
 * word whose lemma is one of the query's. That is the same test `storyScore`
 * makes against the pre-lemmatised index `buildSearchIndex` holds -
 * lemmatising here rather than reusing that set because this needs to know
 * which word in the original text matched, and the index has thrown the
 * positions away.
 *
 * Two details keep it faithful to what actually scored:
 *
 *   - words `tokenise` would have dropped are skipped, so a query token that
 *     lemmatises onto a stopword marks nothing - `storyScore` tests against
 *     the tokenised story, where that word is not present.
 *   - the whole matched word is marked, not the lemma. `survey` marks all of
 *     `surveyed`. Marking three quarters of a word reads as a rendering bug;
 *     marking the word reads as "this is why this room is here".
 *
 * @param text the story as written, unfolded
 * @param opts.minLength must match what built the story index
 * @returns ranges into `text`
 */
export function storyMatchRanges(
  text: unknown,
  queryTokens: string[] = [],
  { minLength = 3 }: { minLength?: number } = {}
): MatchRange[] {
  const src = String(text ?? '');
  if (!src || !queryTokens.length) return [];
  const { folded, map } = foldWithMap(src);
  if (!folded) return [];

  const lemmas = new Set(queryTokens.map(lemmatise));
  const hits = [];
  // The complement of `tokenise`'s split, so the two agree on what a word is.
  for (const m of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0];
    if (word.length < minLength || STOPWORDS.has(word)) continue;
    if (!lemmas.has(lemmatise(word))) continue;
    hits.push(toSource(map, src.length, m.index, m.index + word.length));
  }

  return mergeRanges(hits);
}

/**
 * Min-max a score array onto [0, 1].
 *
 * A flat array carries no information, so it normalises to all-zero rather than
 * to all-one or a divide by zero: a signal that cannot distinguish anything
 * should not contribute a constant that outweighs one that can.
 */
export function normaliseScores(scores: ArrayLike<number>): Float32Array {
  const out = new Float32Array(scores.length);
  if (!scores.length) return out;

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < min) min = scores[i];
    if (scores[i] > max) max = scores[i];
  }
  const span = max - min;
  if (!(span > 0)) return out;

  for (let i = 0; i < scores.length; i++) out[i] = (scores[i] - min) / span;
  return out;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * Formula constants that are not user-tunable weights - unlike
 * `config.search.weights`, moving these means re-checking every cross-signal
 * inequality in docs/search_rules.md ("Balancing signals against each other")
 * they were chosen to satisfy, not retuning by feel.
 *
 * `TAG_PARTIAL_SATURATION` caps how much a query can inflate `tagPartialSum`
 * by adding more partially-matching terms - without it, a long enough query
 * could add up to more than the `P` budget the exact-tag margin (`E > P + S +
 * L + C`) assumes. `STORY_LONG_RANGE` is the char-length band the "long story
 * match" bonus ramps across: below `low` (roughly one or two words) it is
 * zero, and by `high` (roughly a full clause) it has saturated.
 */
export const TAG_PARTIAL_SATURATION = 2;
export const STORY_LONG_RANGE = { low: 16, high: 40 };

/** The saturating curve `storyLongChars` feeds, shared by the ranking bonus and strength's `S` term. */
function storyLongBonus01(chars: number): number {
  const { low, high } = STORY_LONG_RANGE;
  return clamp01((chars - low) / (high - low));
}

/**
 * Strength floor for a single matched story word - "cat" found once in a
 * story is real evidence, but not the near-certain reading a whole matched
 * clause earns. Unlike `CLIP_STRENGTH`, there is no corpus distribution to measure this
 * against; it is a judgement call, same as `map.contentRatio` or the slide
 * timings in `packages/config/config.ts`.
 */
export const STORY_FLOOR = 0.5;

/** The named parts `matchStrength` combines into one reading. */
export interface StrengthParts {
  /** best per-term tag reading, in [0, 1] - `K` in docs/search_rules.md */
  tagStrength?: number;
  /** the same best reading against the room's one title - `Kt` in docs/search_rules.md */
  titleStrength?: number;
  storyLongChars?: number;
  storyMatched?: boolean;
  cosine?: number | null;
}

/**
 * CLIP's raw cosine placed against the anchor band, as a strength in [0, 1]
 * (docs/search_rules.md "Computing strength" and "Image-content (CLIP)
 * matching"): 0 at or below `band.centre` (the no-opinion point), rising
 * linearly to 1 at `band.high` (a genuine match's typical confidence).
 *
 * This is both `matchStrength`'s `C` and `rankHybrid`'s `clipStrengthGate`.
 *
 * @returns in [0, 1]
 */
export function clipCurveStrength(cosine: number | null | undefined, band: ClipBand = CLIP_STRENGTH): number {
  if (cosine === null || cosine === undefined || !Number.isFinite(cosine)) return 0;
  const { centre, high } = band;
  const span = high - centre;
  if (!(span > 0)) return 0;
  return clamp01((cosine - centre) / span);
}

/**
 * A `[0, 1]` strength as a percentage, clamped to 0.01-99.99. Nothing reads
 * as completely certain or completely absent, not even at the anchor cosines
 * themselves: this covers both CLIP's own curve and the composite `strength`
 * `explainRanking` reports up top (docs/search_rules.md "Reporting").
 *
 * @param strength in [0, 1]
 * @returns in [0.01, 99.99]
 */
export function strengthPercent(strength: number): number {
  return Math.min(99.99, Math.max(0.01, strength * 100));
}

/**
 * How strongly one room matches the search - one number in [0, 1], 0 for no
 * evidence (docs/search_rules.md, "Computing strength"). Nothing reads as a
 * mismatch: every signal can only find evidence for a room, never against it.
 *
 * A soft-OR of absolute readings, each computed from the room's raw
 * evidence rather than anything normalised across the corpus. This is the
 * number `ordering.ts`'s density gradient reads, not the ranking score:
 *
 *   - `K` (tags): the room's BEST reading over the query's terms - 1 for an
 *     exact match, the substring fraction for a partial one, 0 for none.
 *     Computed by the caller, since this and ranking read the same per-term
 *     classification. A maximum rather than a mean over the terms: a room
 *     whose tag the reader typed is a match whatever else the query asked
 *     about, and how much of the query a room explains is what ranking's
 *     `tagExact` count already decides (docs/search_requirements.md SR-17).
 *   - `Kt` (title): the same best reading as K, against the room's one
 *     title (a one-keyword index) - computed by the caller alongside K.
 *   - `S` (story): from absolute matched length, not the query-relative
 *     ratio the ranking uses. A single matched word sits at the moderate
 *     `STORY_FLOOR`, a full matched clause reaches 1; using the ratio here
 *     would make a one-word query that matches read as 100% certain.
 *   - `C` (CLIP): `clipCurveStrength` of the raw cosine.
 *
 * Strength is `1 - (1-K)(1-Kt)(1-S)(1-C)` - any one signal can carry it
 * alone, and two weak agreeing signals count for more than either alone.
 *
 * @param parts.tagStrength K, already in [0, 1]
 * @param parts.titleStrength Kt, already in [0, 1] - the same best reading as
 *   K, against the room's title instead of its keywords
 * @param parts.storyLongChars longest contiguous matched run, chars
 * @param parts.storyMatched did any story word match at all - a single
 *   matched word's `storyLongChars` can sit under the ramp's floor and read
 *   as the same "zero" a non-match would, so this is passed explicitly
 * @param parts.cosine raw CLIP cosine, or null/undefined
 * @param clip raw-cosine anchors
 * @returns in [0, 1]
 */
export function matchStrength(
  { tagStrength = 0, titleStrength = 0, storyLongChars = 0, storyMatched = false, cosine = null }: StrengthParts = {},
  clip: ClipBand = CLIP_STRENGTH
): number {
  const K = clamp01(tagStrength);
  const Kt = clamp01(titleStrength);
  const S = storyMatched ? STORY_FLOOR + (1 - STORY_FLOOR) * storyLongBonus01(storyLongChars) : 0;
  const C = clipCurveStrength(cosine, clip);
  return 1 - (1 - K) * (1 - Kt) * (1 - S) * (1 - C);
}

/** One room's row in `rankHybrid`'s working set, before the composite sort reorders it. */
interface ScoredRow {
  id: number;
  score: number;
  tagExact: number;
  tagPartialSum: number;
  tagPartialCount: number;
  /** 0 or 1 - see docs/search_rules.md "Title matching" */
  titleExact: number;
  /** MAX substring fraction over every term, not a sum - there is only one title */
  titlePartial: number;
  storyRatio: number;
  storyLongChars: number;
  clipNorm: number;
  clipStrengthGate: number;
  cosine: number | null;
  strength: number;
}

/** Ascending per-room comparators `rankAxis` sorts by - one per independent axis. */
function compareTagAxis(x: ScoredRow, y: ScoredRow): number {
  return x.tagExact - y.tagExact || x.tagPartialSum - y.tagPartialSum;
}
function compareTitleAxis(x: ScoredRow, y: ScoredRow): number {
  return x.titleExact - y.titleExact || x.titlePartial - y.titlePartial;
}
function compareStoryAxis(x: ScoredRow, y: ScoredRow): number {
  return x.storyRatio - y.storyRatio || x.storyLongChars - y.storyLongChars;
}
function compareClipAxis(x: ScoredRow, y: ScoredRow): number {
  return (x.cosine ?? -Infinity) - (y.cosine ?? -Infinity);
}

/**
 * One signal's own ranking over `byId` (id-indexed, same shape `scored` has
 * when `rankHybrid` passes it in) - "this room ranks #4 by tag, tied with 2
 * others" (docs/search_rules.md "Reporting"), independent of whatever the
 * weighted sum decides. Competition ranking (`1, 2, 2, 4`, not
 * `1, 2, 2, 3`): a tie shares the rank the group's best position would have
 * gotten, so "#4" always means "3 rooms score higher", tie or no tie.
 *
 * @param byId one row per room, indexed by id
 * @param compare ascending on this axis
 * @returns both indexed by id; `rank` is 1-based, `ties` is how many other
 *   rooms share it
 */
function rankAxis(byId: ScoredRow[], compare: (x: ScoredRow, y: ScoredRow) => number): { rank: Int32Array; ties: Int32Array } {
  const ids = byId.map((_, i) => i);
  ids.sort((a, b) => compare(byId[b], byId[a]));
  const rank = new Int32Array(byId.length);
  const ties = new Int32Array(byId.length);
  let i = 0;
  while (i < ids.length) {
    let j = i + 1;
    while (j < ids.length && compare(byId[ids[j]], byId[ids[i]]) === 0) j++;
    const size = j - i;
    for (let k = i; k < j; k++) {
      rank[ids[k]] = i + 1;
      ties[ids[k]] = size - 1;
    }
    i = j;
  }
  return { rank, ties };
}

/**
 * Rank the whole corpus by the blend of whatever signals are available.
 *
 * The weighted sum is the seven constants docs/search_rules.md "Balancing
 * signals against each other" names: `E` per exact tag, `P` for the
 * saturating partial-tag budget, `T` for an exact title match, `Pt` for the
 * partial-title budget, `S` for a short story match, `L` for the saturating
 * long-story bonus, `C` for CLIP (`clipNorm * clipStrengthGate` - relative
 * rank position times absolute confidence, so a query CLIP has no opinion
 * about cannot look confident just because it produced *some* top result).
 * Missing signals are omitted rather than substituted: no embedding blob
 * means the ranking is text-only and honest about it, and no metadata means
 * it is CLIP-only. Both are real rankings. Only the case where neither
 * exists needs the server's stub.
 *
 * @param opts.query          the raw query string
 * @param opts.count          rooms in the corpus
 * @param opts.weights        `config.search.weights`
 * @param opts.embeddings the blob, roomCount * dim row-major
 * @param opts.vector the query vector, L2-normalised
 * @param opts.clipStrength raw-cosine anchors for CLIP's share of strength
 * @returns `strength` is parallel to `order`, i.e. by rank, which is how the map's
 *   density gradient wants it - and `breakdown` follows the same convention,
 *   every array indexed by rank rather than by room id.
 *
 *   `breakdown` is what the catalog shows under a room and what
 *   `explainRanking` formats. It is returned always rather than behind a
 *   flag: a second pass that recomputed these for display could disagree
 *   with the one that sorted, and a scoring explanation that does not match
 *   the scoring is worse than none.
 *
 *   `ranks`/`ties` are independent per-axis sorts of `breakdown`'s own
 *   numbers (tag: `tagExact`/`tagPartialSum`; title: `titleExact`/
 *   `titlePartial`; story: `story`/`storyLongChars`; clip: `cosine`), each
 *   parallel to `order` like `breakdown` - see `rankAxis` for what the
 *   per-axis rank and tie counts mean.
 */
export interface RankHybridOpts {
  query: string;
  count: number;
  weights: Config['search']['weights'];
  minTokenLength?: number;
  embeddings?: Int8Array | null;
  dim?: number;
  /** The int8 half-range `embeddings` was quantised at (`manifest.embeddings.scale`) - see `embeddingScores`. */
  scale?: number;
  vector?: Float32Array | number[] | null;
  index?: SearchIndex | null;
  clipStrength?: ClipBand;
}

export function rankHybrid({
  query,
  count,
  weights,
  minTokenLength = 3,
  embeddings = null,
  dim = 0,
  scale = 0,
  vector = null,
  index = null,
  clipStrength = CLIP_STRENGTH,
}: RankHybridOpts): RankHybridResult {
  const parsed = parseQuery(query);
  const queryTokens = tokenise(query, { minLength: minTokenLength });
  const queryLemmas = new Set(queryTokens.map(lemmatise));
  // Quoted multi-word phrases get an ordered story run of their own, on top
  // of the unordered scattered-word run every query gets - see
  // `storyPhraseRun`.
  const phraseLemmas = parsed.terms.filter((t) => t.quoted && t.words.length > 1).map((t) => t.words.map(lemmatise));

  const { terms: tagTerms, whole: wholeQueryTerm } = tagTermsOf(parsed, queryTokens, minTokenLength);

  // CLIP twice over, from one pass of dot products: raw cosines for
  // strength, and the same column min-maxed for the blend. Two questions,
  // two scalings - see *Ranking is relative; strength is not* above.
  let cosines = null;
  let clipNormAll = null;
  if (embeddings && dim > 0 && scale > 0 && vector) {
    cosines = embeddingScores(embeddings, dim, scale, Float32Array.from(vector));
    clipNormAll = normaliseScores(cosines);
  }

  const hasTerms = tagTerms.length > 0;
  const hasText = Boolean(index?.some(Boolean)) && (hasTerms || queryTokens.length > 0);

  const scored: ScoredRow[] = new Array(count);
  let sawKeyword = false;
  let sawTitle = false;
  let sawStory = false;

  for (let id = 0; id < count; id++) {
    let tagExact = 0;
    let tagPartialSum = 0;
    let tagPartialCount = 0;
    let tagBest = 0;
    let titleExact = 0;
    let titlePartial = 0;
    let titleBest = 0;
    let storyRatio = 0;
    let storyLongChars = 0;
    let storyMatched = false;

    if (hasText) {
      const entry = index[id];
      if (entry) {
        const titleKeywords = entry.title ? [entry.title] : null;
        for (const term of tagTerms) {
          const { exact, partial } = classifyTagTerm(term, entry.keywords);
          tagBest = Math.max(tagBest, exact ? 1 : partial);
          if (exact) tagExact++;
          else if (partial > 0) {
            tagPartialSum += partial;
            tagPartialCount++;
          }

          if (titleKeywords) {
            const t = classifyTagTerm(term, titleKeywords);
            titleBest = Math.max(titleBest, t.exact ? 1 : t.partial);
            if (t.exact) titleExact = 1;
            else if (t.partial > titlePartial) titlePartial = t.partial;
          }
        }

        // Two readings, and the better one wins - the whole query against
        // one whole keyword, beside the per-term pass above. An exact whole
        // match is worth one exact match, never more: `brutalism mezzotint`
        // hitting two separate keywords already scored 2 up there, and this
        // must not pull that down.
        if (wholeQueryTerm) {
          const whole = classifyTagTerm(wholeQueryTerm, entry.keywords);
          tagBest = Math.max(tagBest, whole.exact ? 1 : whole.partial);
          if (whole.exact) tagExact = Math.max(tagExact, 1);
          else if (whole.partial > 0 && tagExact === 0 && tagPartialCount === 0) {
            tagPartialSum = whole.partial;
            tagPartialCount = 1;
          }

          if (titleKeywords) {
            const t = classifyTagTerm(wholeQueryTerm, titleKeywords);
            titleBest = Math.max(titleBest, t.exact ? 1 : t.partial);
            if (t.exact) titleExact = 1;
            else if (t.partial > titlePartial) titlePartial = t.partial;
          }
        }

        storyRatio = storyScore(queryTokens, entry.story);
        storyMatched = storyRatio > 0;
        storyLongChars = longestMatchRun(entry.story.sequence, queryLemmas);
        for (const phrase of phraseLemmas)
          storyLongChars = Math.max(storyLongChars, storyPhraseRun(entry.story.sequence, phrase));

        if (tagExact > 0 || tagPartialSum > 0) sawKeyword = true;
        if (titleExact > 0 || titlePartial > 0) sawTitle = true;
        if (storyMatched) sawStory = true;
      }
    }

    const cosine = cosines ? (cosines[id] ?? null) : null;
    const clipNorm = clipNormAll ? (clipNormAll[id] ?? 0) : 0;
    const clipStrengthGate = clipCurveStrength(cosine, clipStrength);
    const storyLongBonus = storyLongBonus01(storyLongChars);
    const tagStrength = hasTerms ? tagBest : 0;
    const titleStrength = hasTerms ? titleBest : 0;

    const score =
      weights.tagExact * tagExact +
      weights.tagPartial * clamp01(tagPartialSum / TAG_PARTIAL_SATURATION) +
      weights.titleExact * titleExact +
      weights.titlePartial * titlePartial +
      weights.story * storyRatio +
      weights.storyLong * storyLongBonus +
      weights.clip * clipNorm * clipStrengthGate;

    scored[id] = {
      id,
      score,
      tagExact,
      tagPartialSum,
      tagPartialCount,
      titleExact,
      titlePartial,
      storyRatio,
      storyLongChars,
      clipNorm,
      clipStrengthGate,
      cosine,
      strength: matchStrength(
        { tagStrength, titleStrength, storyLongChars, storyMatched, cosine },
        clipStrength
      ),
    };
  }

  // Independent per-signal sorts of the numbers just computed, run before
  // the composite sort below while `scored` is still id-indexed - so
  // `rank`/`ties` come back indexed by room id, same as `scored` itself, and
  // re-sorting for one display column never touches the composite `order`
  // (docs/search_rules.md "The corpus-wide result", "Reporting").
  const tagRanking = rankAxis(scored, compareTagAxis);
  const titleRanking = rankAxis(scored, compareTitleAxis);
  const storyRanking = rankAxis(scored, compareStoryAxis);
  const clipRanking = rankAxis(scored, compareClipAxis);

  // Stable sort, so rooms that every signal is silent about keep their id
  // order rather than shuffling.
  scored.sort((a, b) => b.score - a.score);

  const strength = new Float32Array(count);
  const breakdown: ScoreBreakdown = {
    score: new Float32Array(count),
    tagExact: new Float32Array(count),
    tagPartialSum: new Float32Array(count),
    tagPartialCount: new Int32Array(count),
    titleExact: new Float32Array(count),
    titlePartial: new Float32Array(count),
    story: new Float32Array(count),
    storyLongChars: new Float32Array(count),
    clip: new Float32Array(count),
    clipStrengthGate: new Float32Array(count),
    cosine: new Float32Array(count),
  };
  const ranks: SignalRanks = {
    tag: new Int32Array(count),
    title: new Int32Array(count),
    story: new Int32Array(count),
    clip: new Int32Array(count),
  };
  const ties: SignalRanks = {
    tag: new Int32Array(count),
    title: new Int32Array(count),
    story: new Int32Array(count),
    clip: new Int32Array(count),
  };
  for (let rank = 0; rank < count; rank++) {
    const row = scored[rank];
    strength[rank] = row.strength;
    breakdown.score[rank] = row.score;
    breakdown.tagExact[rank] = row.tagExact;
    breakdown.tagPartialSum[rank] = row.tagPartialSum;
    breakdown.tagPartialCount[rank] = row.tagPartialCount;
    breakdown.titleExact[rank] = row.titleExact;
    breakdown.titlePartial[rank] = row.titlePartial;
    breakdown.story[rank] = row.storyRatio;
    breakdown.storyLongChars[rank] = row.storyLongChars;
    breakdown.clip[rank] = row.clipNorm;
    breakdown.clipStrengthGate[rank] = row.clipStrengthGate;
    breakdown.cosine[rank] = row.cosine ?? NaN;
    ranks.tag[rank] = tagRanking.rank[row.id];
    ties.tag[rank] = tagRanking.ties[row.id];
    ranks.title[rank] = titleRanking.rank[row.id];
    ties.title[rank] = titleRanking.ties[row.id];
    ranks.story[rank] = storyRanking.rank[row.id];
    ties.story[rank] = storyRanking.ties[row.id];
    ranks.clip[rank] = clipRanking.rank[row.id];
    ties.clip[rank] = clipRanking.ties[row.id];
  }

  return {
    order: scored.map((s) => s.id),
    strength,
    breakdown,
    ranks,
    ties,
    signals: { clip: Boolean(clipNormAll), keyword: sawKeyword, title: sawTitle, story: sawStory },
  };
}

/** `explainRanking`'s four axes, in the order shown when every one contributed. */
const CONTRIBUTION_LABELS = { clip: 'image content', tag: 'tag matches', title: 'title match', story: 'story content' };

/**
 * One room's ranking, as a reader reads it rather than as the sum computed
 * it: one composite line ("#4 of 2,048, 73% match strength"), and one line
 * per axis that actually found something for this room - tag, title, story,
 * and CLIP whenever the corpus has embeddings at all - each carrying its own
 * independent rank/tie count from `rankHybrid`'s `ranks`/`ties`, not the
 * composite's.
 *
 * `strength` is the only number here computed against absolute bounds
 * (docs/search_rules.md "Computing strength") rather than read straight off
 * `breakdown.score`. `contributions` exists so a reader can still ask "why"
 * without confusing that absolute number for one of the terms that produced
 * it: each is that axis's weighted term as a share of `breakdown.score`,
 * sorted greatest first, an axis that contributed nothing omitted rather
 * than shown as `0%` (docs/search_rules.md "Reporting").
 *
 * @param rank position in `order`
 * @param opts.breakdown from `rankHybrid`
 * @param opts.strength from `rankHybrid`
 * @param opts.ranks from `rankHybrid`
 * @param opts.ties from `rankHybrid`
 * @param opts.weights `config.search.weights`
 * @param opts.total rooms in the corpus (`result.order.length`)
 * @returns `null` when nothing at all matched this room - no tag, no title, no story, no CLIP data.
 */
export interface ExplainRankingOpts {
  breakdown: ScoreBreakdown;
  strength: Float32Array;
  ranks: SignalRanks;
  ties: SignalRanks;
  weights: Config['search']['weights'];
  total: number;
}

export function explainRanking(
  rank: number,
  { breakdown, strength, ranks, ties, weights, total }: ExplainRankingOpts
): RankingExplanation | null {
  const at = (arr: ArrayLike<number> | null | undefined): number => (arr && rank < arr.length ? arr[rank] : 0);

  const tagExact = at(breakdown?.tagExact);
  const tagPartialSum = at(breakdown?.tagPartialSum);
  const tagPartialCount = at(breakdown?.tagPartialCount);
  const titleExact = at(breakdown?.titleExact);
  const titlePartial = at(breakdown?.titlePartial);
  const storyRatio = at(breakdown?.story);
  const storyLongChars = at(breakdown?.storyLongChars);
  const cosine = at(breakdown?.cosine);

  const hasTag = tagExact > 0 || tagPartialCount > 0;
  const hasTitle = titleExact > 0 || titlePartial > 0;
  const hasStory = storyRatio > 0 || storyLongChars > 0;
  const hasClip = Number.isFinite(cosine);
  if (!hasTag && !hasTitle && !hasStory && !hasClip) return null;

  const tagWeighted = weights.tagExact * tagExact + weights.tagPartial * clamp01(tagPartialSum / TAG_PARTIAL_SATURATION);
  const titleWeighted = weights.titleExact * titleExact + weights.titlePartial * titlePartial;
  const storyWeighted = weights.story * storyRatio + weights.storyLong * storyLongBonus01(storyLongChars);
  const clipWeighted = hasClip ? weights.clip * at(breakdown?.clip) * at(breakdown?.clipStrengthGate) : 0;
  const totalScore = at(breakdown?.score);

  const contributionTerms: { key: 'clip' | 'tag' | 'title' | 'story'; weighted: number }[] = [
    { key: 'clip', weighted: clipWeighted },
    { key: 'tag', weighted: tagWeighted },
    { key: 'title', weighted: titleWeighted },
    { key: 'story', weighted: storyWeighted },
  ];
  const contributions = contributionTerms
    .filter((c) => c.weighted > 0 && totalScore > 0)
    .map((c) => ({ key: c.key, label: CONTRIBUTION_LABELS[c.key], percent: Math.round((c.weighted / totalScore) * 100) }))
    .sort((a, b) => b.percent - a.percent);

  return {
    rank: rank + 1,
    total,
    percent: strengthPercent(at(strength)),
    contributions,
    tag: hasTag
      ? { rank: ranks.tag[rank], ties: ties.tag[rank], exact: tagExact, partial: tagPartialCount }
      : null,
    title: hasTitle
      ? { rank: ranks.title[rank], ties: ties.title[rank], exact: titleExact > 0, partial: titlePartial }
      : null,
    story: hasStory ? { rank: ranks.story[rank], ties: ties.story[rank], length: storyLongChars } : null,
    clip: hasClip
      ? { rank: ranks.clip[rank], ties: ties.clip[rank], cosine, percent: strengthPercent(at(breakdown?.clipStrengthGate)) }
      : null,
  };
}
