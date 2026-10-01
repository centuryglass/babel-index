/**
 * Text matching for search, and the one calculation that turns it and CLIP
 * into each room's match strength.
 *
 * The rules this implements are docs/search_rules.md; its "Overview: one
 * number" is the design. Three invariants the code below relies on:
 *
 * - One number places a room and sets the density around it. `rankHybrid`
 *   sorts by `strength`, so the map's position and its reported strength
 *   cannot disagree (docs/search_requirements.md SR-22).
 * - Every pull is absolute. Each axis reads the room's own evidence against
 *   fixed bounds, never against the rest of the collection, so a query nothing
 *   answers leaves every room near 0. CLIP reads its raw cosine, which is
 *   why `embeddingScores` dequantises.
 * - Precedence between signals comes from the weights and is checked by
 *   tests, not by an algebraic guarantee: `scoring.test.ts` asserts each
 *   ordering requirement on queries built to test it.
 *
 * No DOM. Imports: `ordering.ts`'s dot products, `any-ascii` for `fold`, and
 * `wink-lemmatizer`. The lemmatizer looks a word up per part of speech; a
 * suffix-collapsing stemmer would fold `animation` and `animal` together.
 * See `lemmatise` for the lookup order.
 */
// Default import only: wink-lemmatizer is CommonJS, and Node's ESM interop
// does not statically discover its named exports.
import winkLemmatizer from 'wink-lemmatizer';
import anyAscii from 'any-ascii';
import { embeddingScores } from './ordering.ts';
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

/** The anchor band `clipCurveStrength` reads a raw cosine against. */
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
 * Both are measured against a real collection via
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
 * are the same word, which matters for a collection whose vocabulary is full of art
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
 * collection with an accent in it lands slightly wrong.
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
  /** tokens shorter than this are dropped, or `a` matches most keywords in the collection by substring */
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
 * per word for scoring (`rankHybrid`'s `tokenise` call).
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

/**
 * How one term matches a room's keywords: exact, partial, or neither.
 *
 * The one substring rule every tag and title match is read through. A term
 * matches a keyword exactly when it equals it, and partially by the fraction
 * of the keyword it covers. A term is tested as its whole `folded` text,
 * whether it is one word, a quoted phrase, or the whole-query term
 * `rankHybrid` builds (docs/search_rules.md "Tag matching"). Quoting a single
 * word therefore changes nothing (docs/search_rules.md "Quoted phrases").
 *
 * @param keywords folded room keywords
 * @returns `partial` is the best substring fraction found, 0 when there is no
 *   match at all (exact implies `partial` is meaningless and left at 0)
 */
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

/** One token from `tokeniseWithPositions`, with its [start, end) span into the folded text. */
interface WordSpan {
  word: string;
  start: number;
  end: number;
}

/**
 * Fold and tokenise, keeping each surviving token's span into the folded text.
 *
 * `storyLongChars` (docs/search_rules.md "Story matching") needs how many
 * characters a run of story words spans, which `tokenise`'s bag of words
 * cannot give. It walks the same word-boundary regex as `storyMatchRanges`,
 * so the two agree on what counts as a word.
 */
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
 * bag - `storyWordMatches` only needs membership (`set`, kept alongside so
 * that stays an O(1) lookup), but the longest-contiguous-run measurement a
 * long story match needs (`longestMatchRun`, `storyPhraseRun`) has to know
 * which words sit next to which. Positions are into the folded story, not
 * the original - good enough for a character-count threshold, and
 * `storyMatchRanges` (which does need the original for highlighting)
 * re-walks the source text itself rather than reading this index.
 *
 * @param joined output of `joinMetadata()`
 * @param opts.minLength must match the `minTokenLength` `rankHybrid` filters
 *   the query with, or a query word shorter than this never matches a story
 */
export function buildSearchIndex(
  joined: (SearchIndexSource | null)[] | null | undefined,
  { minLength = 3 }: { minLength?: number } = {}
): SearchIndex {
  return (joined ?? []).map((entry) => {
    if (!entry) return null;
    // Lemmatised, not just tokenised: a search matches a story word by base
    // form, so `cats` finds `cat` but `catalogue` does not. See `storyWordMatches`.
    const sequence = tokeniseWithPositions(entry.story ?? '', { minLength }).map(({ word, start, end }) => ({
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
      // room has at most one title (docs/search_rules.md "Title matching").
      title: entry.title ? fold(entry.title) : null,
      story: { sequence, set: new Set(sequence.map((t) => t.lemma)) },
    };
  });
}

/**
 * How many of the query's distinct words appear in a room's story.
 *
 * A count, not a share of the story or of the query: the same hit is worth
 * the same in a long story as in a short one, and a word the query adds
 * that the story lacks takes nothing away. Two tokens with one lemma count
 * once.
 *
 * Matching is by lemma, so `room` finds `rooms`, `survey` finds `surveyed`,
 * and the reverse; `cat` does not match `catalogue`, nor `animation`
 * `animal`. The story index is lemmatised once at build time
 * (`buildSearchIndex`); the query's few tokens are lemmatised here.
 *
 * @param queryTokens folded, tokenised query words
 * @param storyIndex the room's story
 */
export function storyWordMatches(queryTokens: string[], storyIndex: StoryIndex | null | undefined): number {
  const set = storyIndex?.set;
  if (!set?.size) return 0;

  let matched = 0;
  for (const lemma of new Set(queryTokens.map(lemmatise))) if (set.has(lemma)) matched++;
  return matched;
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
// and miss text `storyWordMatches` credited. They live here rather than in a component
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
 * Where a query matched a story, mirroring `storyWordMatches`'s lemma rule.
 *
 * Walks the text on the same word boundary `tokenise` splits on, and marks a
 * word whose lemma is one of the query's. That is the same test `storyWordMatches`
 * makes against the pre-lemmatised index `buildSearchIndex` holds -
 * lemmatising here rather than reusing that set because this needs to know
 * which word in the original text matched, and the index has thrown the
 * positions away.
 *
 * Two details keep it faithful to what actually scored:
 *
 *   - words `tokenise` would have dropped are skipped, so a query token that
 *     lemmatises onto a stopword marks nothing - `storyWordMatches` tests against
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
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * A soft OR over pulls in [0, 1]: `1 - (1-a)(1-b)...`.
 *
 * Any one pull can carry the result alone, each extra pull only raises it,
 * and a zero changes nothing. That last property is what keeps a room's
 * strength from dropping when a query gains words it has nothing to do with
 * (docs/search_requirements.md SR-17).
 */
function softOr(pulls: Iterable<number>): number {
  let miss = 1;
  for (const p of pulls) miss *= 1 - clamp01(p);
  return 1 - miss;
}

/** How strongly each kind of evidence pulls a room, each in [0, 1]; see `SEARCH_WEIGHTS`. */
export interface SearchWeights {
  tagExact: number;
  tagPartial: number;
  titleExact: number;
  titlePartial: number;
  story: number;
  storyLong: number;
  clip: number;
}

/**
 * How strongly each kind of evidence pulls a room toward the center, each in
 * [0, 1] (docs/search_rules.md "Signal weights"). An exact match pulls at its
 * full weight, a partial match at its weight times the fraction of the keyword
 * or title it covers, a matched story word at `story` and a full story run at
 * `storyLong`, and CLIP at `clip` times its curve.
 *
 * Code, not config: the ordering requirements between signals (an exact match
 * ahead of a CLIP-only room, a long story run ahead of CLIP) hold because of
 * these numbers, and `scoring.test.ts` checks each one on a built query. A
 * re-tune that breaks one fails a test instead of quietly changing the map.
 *
 * `config.ts`'s `search.density.peakAt` defaults to `clip`; raising `clip`
 * past it packs the top of CLIP's range at one density.
 */
export const SEARCH_WEIGHTS: Readonly<SearchWeights> = Object.freeze({
  tagExact: 1,
  tagPartial: 0.6,
  titleExact: 1,
  titlePartial: 0.6,
  story: 0.35,
  storyLong: 0.95,
  clip: 0.85,
});

/**
 * The character band a story run's pull ramps across: zero below `low`
 * (about one long word, which `weights.story` already credits), full at
 * `high` (about a full clause).
 *
 * A formula constant, not a weight: `weights.storyLong` sets how strongly a
 * full run pulls, and this sets what counts as full.
 */
export const STORY_LONG_RANGE = { low: 16, high: 40 };

/** The ramp `STORY_LONG_RANGE` describes, in [0, 1]. */
function storyRunCurve(chars: number): number {
  const { low, high } = STORY_LONG_RANGE;
  return clamp01((chars - low) / (high - low));
}

/**
 * CLIP's raw cosine placed against the anchor band, in [0, 1]
 * (docs/search_rules.md "Image-content (CLIP) matching"): 0 at or below
 * `band.centre` (the no-opinion point), rising linearly to 1 at
 * `band.high` (a genuine match's typical confidence). `weights.clip` scales
 * it into CLIP's pull.
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
 * A `[0, 1]` strength as a percentage, clamped to 0-100. This covers both
 * CLIP's own curve and the composite `strength` `explainRanking` reports up
 * top (docs/search_rules.md "Reporting").
 *
 * @param strength in [0, 1]
 * @returns in [0, 100]
 */
export function strengthPercent(strength: number): number {
  return Math.min(100, Math.max(0, strength * 100));
}

/** One room's pull on each axis, already weighted and in [0, 1] - what `matchStrength` combines. */
export interface AxisPulls {
  tag?: number;
  title?: number;
  story?: number;
  clip?: number;
}

/**
 * How strongly one room matches the search: one number in [0, 1] that both
 * places the room and sets the map's density around it (docs/search_rules.md
 * "Computing strength"). 0 is no evidence; nothing reads as a mismatch.
 *
 * A soft OR of the four axes' pulls (see `softOr`). Every pull is an
 * absolute reading of the room's own evidence, never normalised across the
 * collection, so a query the collection has no answer to leaves every room near 0
 * (docs/search_requirements.md SR-19).
 *
 * @returns in [0, 1]
 */
export function matchStrength({ tag = 0, title = 0, story = 0, clip = 0 }: AxisPulls = {}): number {
  return softOr([tag, title, story, clip]);
}

/** One room's row in `rankHybrid`'s working set, before the placement sort reorders it. */
interface ScoredRow {
  id: number;
  strength: number;
  tag: number;
  title: number;
  story: number;
  clip: number;
  tagExact: number;
  tagPartialCount: number;
  /** 0 or 1 - see docs/search_rules.md "Title matching" */
  titleExact: number;
  /** the largest substring fraction over every term, not a combination - there is only one title */
  titlePartial: number;
  storyWords: number;
  storyLongChars: number;
  clipStrength: number;
  cosine: number | null;
}

/**
 * Placement order: strength, then two tiebreaks among rooms that matched at
 * all, then id.
 *
 * - More exact term matches first. Exact matches pull at `weights.tagExact`
 *   and `weights.titleExact`, which are 1 and saturate strength, so
 *   this is where "more exact matches beat fewer" (SR-13) is decided.
 * - Then the higher raw cosine.
 * - Rooms at strength 0 skip both and keep id order, so a query nothing
 *   matched does not reorder the map (SR-15, SR-19).
 */
function comparePlacement(a: ScoredRow, b: ScoredRow): number {
  if (b.strength !== a.strength) return b.strength - a.strength;
  if (a.strength > 0) {
    const exact = b.tagExact + b.titleExact - (a.tagExact + a.titleExact);
    if (exact) return exact;
    const cosine = (b.cosine ?? -Infinity) - (a.cosine ?? -Infinity);
    if (cosine) return cosine;
  }
  return a.id - b.id;
}

/** Ascending per-room comparators `rankAxis` sorts by - one per independent axis. */
function compareTagAxis(x: ScoredRow, y: ScoredRow): number {
  return x.tag - y.tag || x.tagExact - y.tagExact;
}
function compareTitleAxis(x: ScoredRow, y: ScoredRow): number {
  return x.title - y.title;
}
function compareStoryAxis(x: ScoredRow, y: ScoredRow): number {
  return x.story - y.story || x.storyLongChars - y.storyLongChars;
}
function compareClipAxis(x: ScoredRow, y: ScoredRow): number {
  return (x.cosine ?? -Infinity) - (y.cosine ?? -Infinity);
}

/**
 * One signal's own ranking over `byId` (id-indexed, same shape `scored` has
 * when `rankHybrid` passes it in) - "this room ranks #4 by tag, tied with 2
 * others" (docs/search_rules.md "Reporting"), independent of the placement
 * order. Competition ranking (`1, 2, 2, 4`, not `1, 2, 2, 3`): a tie shares
 * the rank the group's best position would have gotten, so "#4" always
 * means "3 rooms score higher", tie or no tie.
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

/** `rankHybrid`'s options, documented on the function. */
export interface RankHybridOpts {
  query: string;
  count: number;
  weights?: SearchWeights;
  minTokenLength?: number;
  embeddings?: Int8Array | null;
  dim?: number;
  /** The int8 half-range `embeddings` was quantised at (`manifest.embeddings.scale`) - see `embeddingScores`. */
  scale?: number;
  vector?: Float32Array | number[] | null;
  index?: SearchIndex | null;
  clipStrength?: ClipBand;
}

/**
 * Evaluate the whole collection against a query: one `strength` per room, and
 * the order that places rooms by it.
 *
 * Each axis turns the room's evidence into a pull in [0, 1], scaled by its
 * `SEARCH_WEIGHTS` entry (docs/search_rules.md "Signal weights"), and
 * `matchStrength` combines the four. Per axis:
 *
 *   - tag: a soft OR over the query's terms, each exact match pulling at
 *     `tagExact` and each partial at `tagPartial` times the fraction of the
 *     keyword it covers. The whole-query reading competes with it, and the
 *     better one stands.
 *   - title: the best single reading over every term and the whole query,
 *     since a room has one title.
 *   - story: a soft OR of `story` per matched query word and `storyLong`
 *     times the run curve (`STORY_LONG_RANGE`).
 *   - clip: `clip` times `clipCurveStrength` of the raw cosine.
 *
 * A missing signal is omitted, not substituted: no embedding blob gives a
 * text-only ranking, and no metadata a CLIP-only one. Only a collection with
 * neither needs the server's stub.
 *
 * @param opts.query          the raw query string
 * @param opts.count          rooms in the collection
 * @param opts.weights        `SEARCH_WEIGHTS` unless a test swaps one out
 * @param opts.embeddings the blob, roomCount * dim row-major
 * @param opts.vector the query vector, L2-normalised
 * @param opts.clipStrength raw-cosine anchors for CLIP's curve
 * @returns `order` sorts by `comparePlacement`, so `strength` (parallel to
 *   `order`, by rank) is non-increasing. `breakdown` follows the same
 *   by-rank convention; it is what the catalog shows under a room and what
 *   `explainRanking` formats.
 *
 *   `ranks`/`ties` are independent per-axis sorts (tag: pull, then exact
 *   count; title: pull; story: pull, then `storyLongChars`; clip: cosine),
 *   each parallel to `order` - see `rankAxis` for what the per-axis rank and
 *   tie counts mean.
 */
export function rankHybrid({
  query,
  count,
  weights = SEARCH_WEIGHTS,
  minTokenLength = 3,
  embeddings = null,
  dim = 0,
  scale = 0,
  vector = null,
  index = null,
  clipStrength: clipBand = CLIP_STRENGTH,
}: RankHybridOpts): RankHybridResult {
  const parsed = parseQuery(query);
  const queryTokens = tokenise(query, { minLength: minTokenLength });
  const queryLemmas = new Set(queryTokens.map(lemmatise));
  // Quoted multi-word phrases get an ordered story run of their own, on top
  // of the unordered scattered-word run every query gets - see
  // `storyPhraseRun`.
  const phraseLemmas = parsed.terms.filter((t) => t.quoted && t.words.length > 1).map((t) => t.words.map(lemmatise));

  const { terms: tagTerms, whole: wholeQueryTerm } = tagTermsOf(parsed, queryTokens, minTokenLength);

  const cosines =
    embeddings && dim > 0 && scale > 0 && vector
      ? embeddingScores(embeddings, dim, scale, Float32Array.from(vector))
      : null;

  const hasText = Boolean(index?.some(Boolean)) && (tagTerms.length > 0 || queryTokens.length > 0);
  const storyWordPull = clamp01(weights.story);

  const scored: ScoredRow[] = new Array(count);
  let sawKeyword = false;
  let sawTitle = false;
  let sawStory = false;

  for (let id = 0; id < count; id++) {
    let tag = 0;
    let title = 0;
    let story = 0;
    let tagExact = 0;
    let tagPartialCount = 0;
    let titleExact = 0;
    let titlePartial = 0;
    let storyWords = 0;
    let storyLongChars = 0;

    const entry = hasText ? index?.[id] : null;
    if (entry) {
      const titleKeywords = entry.title ? [entry.title] : null;
      const tagPulls: number[] = [];
      for (const term of tagTerms) {
        const { exact, partial } = classifyTagTerm(term, entry.keywords);
        if (exact) {
          tagExact++;
          tagPulls.push(weights.tagExact);
        } else if (partial > 0) {
          tagPartialCount++;
          tagPulls.push(weights.tagPartial * partial);
        }

        if (titleKeywords) {
          const t = classifyTagTerm(term, titleKeywords);
          if (t.exact) titleExact = 1;
          else if (t.partial > titlePartial) titlePartial = t.partial;
        }
      }
      tag = softOr(tagPulls);

      // Two readings, and the better one wins - the whole query against one
      // whole keyword, beside the per-term pass above. An exact whole match
      // counts as one exact match, never more: `brutalism mezzotint` hitting
      // two separate keywords already counted 2 up there, and this must not
      // pull that down.
      if (wholeQueryTerm) {
        const whole = classifyTagTerm(wholeQueryTerm, entry.keywords);
        const wholePull = whole.exact ? weights.tagExact : weights.tagPartial * whole.partial;
        if (whole.exact) tagExact = Math.max(tagExact, 1);
        else if (whole.partial > 0 && tagExact === 0 && tagPartialCount === 0) tagPartialCount = 1;
        tag = Math.max(tag, wholePull);

        if (titleKeywords) {
          const t = classifyTagTerm(wholeQueryTerm, titleKeywords);
          if (t.exact) titleExact = 1;
          else if (t.partial > titlePartial) titlePartial = t.partial;
        }
      }
      title = titleExact ? weights.titleExact : weights.titlePartial * titlePartial;

      storyWords = storyWordMatches(queryTokens, entry.story);
      storyLongChars = longestMatchRun(entry.story.sequence, queryLemmas);
      for (const phrase of phraseLemmas)
        storyLongChars = Math.max(storyLongChars, storyPhraseRun(entry.story.sequence, phrase));
      story = softOr([1 - (1 - storyWordPull) ** storyWords, weights.storyLong * storyRunCurve(storyLongChars)]);

      if (tagExact > 0 || tagPartialCount > 0) sawKeyword = true;
      if (titleExact > 0 || titlePartial > 0) sawTitle = true;
      if (storyWords > 0 || storyLongChars > 0) sawStory = true;
    }

    const cosine = cosines ? (cosines[id] ?? null) : null;
    const clipCurve = clipCurveStrength(cosine, clipBand);
    const clip = weights.clip * clipCurve;

    scored[id] = {
      id,
      strength: matchStrength({ tag, title, story, clip }),
      tag,
      title,
      story,
      clip,
      tagExact,
      tagPartialCount,
      titleExact,
      titlePartial,
      storyWords,
      storyLongChars,
      clipStrength: clipCurve,
      cosine,
    };
  }

  // Independent per-signal sorts of the numbers just computed, run before
  // the placement sort below while `scored` is still id-indexed - so
  // `rank`/`ties` come back indexed by room id, same as `scored` itself
  // (docs/search_rules.md "The collection-wide result", "Reporting").
  const tagRanking = rankAxis(scored, compareTagAxis);
  const titleRanking = rankAxis(scored, compareTitleAxis);
  const storyRanking = rankAxis(scored, compareStoryAxis);
  const clipRanking = rankAxis(scored, compareClipAxis);

  scored.sort(comparePlacement);

  const strength = new Float32Array(count);
  const breakdown: ScoreBreakdown = {
    tag: new Float32Array(count),
    title: new Float32Array(count),
    story: new Float32Array(count),
    clip: new Float32Array(count),
    tagExact: new Float32Array(count),
    tagPartialCount: new Int32Array(count),
    titleExact: new Float32Array(count),
    titlePartial: new Float32Array(count),
    storyWords: new Int32Array(count),
    storyLongChars: new Float32Array(count),
    clipStrength: new Float32Array(count),
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
    breakdown.tag[rank] = row.tag;
    breakdown.title[rank] = row.title;
    breakdown.story[rank] = row.story;
    breakdown.clip[rank] = row.clip;
    breakdown.tagExact[rank] = row.tagExact;
    breakdown.tagPartialCount[rank] = row.tagPartialCount;
    breakdown.titleExact[rank] = row.titleExact;
    breakdown.titlePartial[rank] = row.titlePartial;
    breakdown.storyWords[rank] = row.storyWords;
    breakdown.storyLongChars[rank] = row.storyLongChars;
    breakdown.clipStrength[rank] = row.clipStrength;
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
    signals: { clip: Boolean(cosines), keyword: sawKeyword, title: sawTitle, story: sawStory },
  };
}

/** `explainRanking`'s four axes, in the order shown when every one contributed. */
const CONTRIBUTION_LABELS = { clip: 'image content', tag: 'tag matches', title: 'title match', story: 'story content' };

/** `explainRanking`'s options, documented on the function. */
export interface ExplainRankingOpts {
  breakdown: ScoreBreakdown;
  strength: Float32Array;
  ranks: SignalRanks;
  ties: SignalRanks;
  total: number;
}

/**
 * One room's ranking, as a reader reads it: one composite line ("#4 of
 * 2,048, 73% match strength"), and one line per axis that actually found
 * something for this room - tag, title, story, and CLIP whenever the collection
 * has embeddings at all - each carrying its own independent rank/tie count
 * from `rankHybrid`'s `ranks`/`ties`, not the placement order's.
 *
 * `contributions` answers "why": each axis's pull as a share of the four
 * pulls added together, sorted greatest first, an axis that pulled nothing
 * omitted rather than shown as `0%` (docs/search_rules.md "Reporting"). The
 * soft OR that makes `strength` does not split into additive parts, so a
 * share is of the pulls, not of `strength`.
 *
 * @param rank position in `order`
 * @param opts.breakdown from `rankHybrid`
 * @param opts.strength from `rankHybrid`
 * @param opts.ranks from `rankHybrid`
 * @param opts.ties from `rankHybrid`
 * @param opts.total rooms in the collection (`result.order.length`)
 * @returns `null` when nothing at all matched this room - no tag, no title, no story, no CLIP data.
 */
export function explainRanking(
  rank: number,
  { breakdown, strength, ranks, ties, total }: ExplainRankingOpts
): RankingExplanation | null {
  const at = (arr: ArrayLike<number> | null | undefined): number => (arr && rank < arr.length ? arr[rank] : 0);

  const tagExact = at(breakdown?.tagExact);
  const tagPartialCount = at(breakdown?.tagPartialCount);
  const titleExact = at(breakdown?.titleExact);
  const titlePartial = at(breakdown?.titlePartial);
  const storyWords = at(breakdown?.storyWords);
  const storyLongChars = at(breakdown?.storyLongChars);
  const cosine = at(breakdown?.cosine);

  const hasTag = tagExact > 0 || tagPartialCount > 0;
  const hasTitle = titleExact > 0 || titlePartial > 0;
  const hasStory = storyWords > 0 || storyLongChars > 0;
  const hasClip = Number.isFinite(cosine);
  if (!hasTag && !hasTitle && !hasStory && !hasClip) return null;

  const pulls: { key: 'clip' | 'tag' | 'title' | 'story'; pull: number }[] = [
    { key: 'clip', pull: hasClip ? at(breakdown?.clip) : 0 },
    { key: 'tag', pull: at(breakdown?.tag) },
    { key: 'title', pull: at(breakdown?.title) },
    { key: 'story', pull: at(breakdown?.story) },
  ];
  const pullSum = pulls.reduce((sum, p) => sum + p.pull, 0);
  const contributions = pulls
    .filter((p) => p.pull > 0 && pullSum > 0)
    .map((p) => ({ key: p.key, label: CONTRIBUTION_LABELS[p.key], percent: Math.round((p.pull / pullSum) * 100) }))
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
      ? { rank: ranks.clip[rank], ties: ties.clip[rank], cosine, percent: strengthPercent(at(breakdown?.clipStrength)) }
      : null,
  };
}
