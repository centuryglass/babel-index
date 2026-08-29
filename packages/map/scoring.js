/**
 * Text scoring for search: keywords and story against a query.
 *
 * Separate from `ordering.js` because it is the only meaty string code in the
 * package - folding, tokenising, stopwords - and that file is worth keeping as
 * arithmetic. The blend that combines these with CLIP lives here too, since the
 * normalisation it depends on is the whole reason the weights mean anything.
 *
 * ### Why every signal is normalised before it is weighted
 *
 * The three signals are not remotely on the same scale. Keyword and story scores
 * are ratios and land in [0, 1] by construction. A CLIP cosine is nominally
 * [-1, 1], but on a corpus of near-identical library walls the scores for one
 * query cluster into a narrow band - the images differ far less than CLIP's
 * range allows - so the raw number is a poor thing to weight. Blend it as-is and
 * there is no weight that works: large enough to matter and any keyword bonus
 * still swamps it, small enough to balance one and it is lost inside its own
 * spread.
 *
 * So the CLIP term is min-max normalised across the corpus *for that query*: one
 * extra pass over an array that has just been scored anyway, after which a
 * weight of 0.25 really does mean "a quarter of what a perfect keyword match is
 * worth". See `packages/config` for the weights themselves.
 *
 * ### One sort, not tiers
 *
 * Everything is ranked by the blended score. Bucketing - exact matches first,
 * then CLIP within the remainder - would let a room with one weak partial
 * keyword beat a room CLIP is certain about, and would break the thing the map
 * is for: the whole library rearranging, best in the middle and worst at the
 * edge, rather than a few results spliced to the front of an unchanged order.
 *
 * ### Ranking is relative; certainty is not
 *
 * The blend answers "which room is most like the query". The map's density
 * gradient (`ordering.js`) asks a different question - "how sure are we at all"
 * - and the blended score cannot answer it, because min-max normalisation
 * destroys exactly the information required: some room always scores 1, whether
 * the query was `art nouveau` or `cghjj`. Certainty is therefore computed from
 * the *absolute* form of each signal, alongside the ranking and from the same
 * pass:
 *
 *   - keyword and story ratios are already absolute. An exact keyword match is
 *     1 because it is a match, not because it beat the corpus.
 *   - CLIP contributes its raw cosine against a pair of thresholds. This is the
 *     only place the raw number is used rather than the normalised one, and it
 *     is the reason `embeddingScores` dequantises: a nonsense string still
 *     produces a valid text vector, and what marks it as nonsense is that its
 *     cosine against every image is low in absolute terms, not that the spread
 *     between images vanished.
 *
 * The thresholds are the one part of this that genuinely wants calibrating
 * against a real corpus, which is the argument for them living in config.
 *
 * No DOM. Two imports: the dot products it would otherwise duplicate, and a
 * lemmatizer - reducing free text to a base form is exactly the kind of thing
 * that is unwise to reimplement. A Porter stemmer (`stemmer`, the previous
 * choice) collapses purely by suffix stripping and doesn't know a noun from a
 * verb, which is how `animation` and `animal` end up sharing the stem `anim` -
 * a real false positive, not a hypothetical one. `wink-lemmatizer` looks a
 * word up (falling back to suffix rules only for the unknown) separately per
 * part of speech, so `lemmatise` below tries noun, then verb, then adjective
 * and keeps the first one that actually changed the word - the cheap stand-in
 * for POS tagging the header above already accepts for story matching.
 */
// Default import only: wink-lemmatizer is CommonJS, and Node's ESM interop
// does not statically discover its named exports.
import winkLemmatizer from 'wink-lemmatizer';
import anyAscii from 'any-ascii';
import { embeddingScores } from './ordering.ts';

const { noun, verb, adjective } = winkLemmatizer;

/**
 * A word's base form, trying noun then verb then adjective rules and keeping
 * the first that changes it. Unknown words come back unchanged - matching
 * still falls through to whole-word equality, it just doesn't stem.
 */
export function lemmatise(word) {
  const n = noun(word);
  if (n !== word) return n;
  const v = verb(word);
  if (v !== word) return v;
  const a = adjective(word);
  if (a !== word) return a;
  return word;
}

/**
 * The three anchors of CLIP's signed certainty curve (docs/search_rules.md
 * "Image-content (CLIP) matching" + "Computing certainty"): `centre` is the
 * no-opinion point (0), `high` is a genuine match's typical confidence (+1),
 * `low` is a genuinely-irrelevant query's typical confidence (-1). Continuous
 * and monotone between them - see `signedClipCertainty`.
 *
 * `centre` and `high` are read straight off `cosine-range-report.json`
 * (2048 rooms x 2149 generation keywords, CLIP ViT-B/32, via
 * `tools/embed/cosine-range.ts`): `centre` is the *median* of the overall
 * keyword x room distribution (mostly-unrelated pairs - `overall.p50`), `high`
 * is the *median* ceiling across near-universal keywords true of nearly every
 * room (`bookshelf`, `book`, `library`, ... - `universal.ceiling`), chosen over
 * the raw distribution max because a single outlier pair should not define
 * "as sure as it gets".
 *
 * `low` is still provisional: docs/search-plan.md §5 calls for measuring it
 * from known-irrelevant strong concepts (a query CLIP should recognise but
 * that has nothing to do with this corpus - "swimming pool", "race car" -
 * expected to land low-positive, not negative, per the spec). That measurement
 * needs a real corpus and network access to the CLIP text tower, neither
 * available in every environment this runs in, so until it lands `low` is the
 * mirror of `high` across `centre` (`centre - (high - centre)`) - a
 * data-grounded placeholder, not a guess pulled from nowhere, that keeps the
 * curve continuous and gives a reasonable negative reading rather than none at
 * all. `tools/embed/cosine-range.ts --irrelevant <file>` computes the real
 * anchor the same way `--universal` computes `high`; swap it in here once run.
 */
export const CLIP_CERTAINTY = { centre: 0.205, high: 0.279, low: 0.131 };

/**
 * Words carrying no retrieval signal, dropped from queries.
 *
 * Short and ASCII on purpose. This is not a linguistic resource, it is a guard
 * against a query like "the room of glass" spending two thirds of its weight on
 * "the" and "of" - and, for keywords, against `the` scoring a partial match
 * against `theatrical`.
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
 * fallback for exactly that remainder: a per-code-point transliteration table,
 * so `Zdzisław` and `Zdzislaw` fold to the same string.
 */
export function fold(text) {
  return foldWithMap(text).folded.trim();
}

/** Combining marks, stripped after NFD has exposed them. */
const COMBINING = /[\u0300-\u036f]/g;

/**
 * `fold`, but keeping track of where every folded character came from.
 *
 * Highlighting needs this and nothing else does. Matching happens on folded
 * text; the `<mark>` has to land on the ORIGINAL, and a folded index is not an
 * original index - every step of folding can change length. Decomposed
 * `cafe\u0301` is five characters and folds to four; `\u0130` lowercases to two
 * from one. Use one as the other and every highlight on a corpus with an accent
 * in it lands slightly wrong, which is the kind of bug nobody reports because it
 * looks like sloppy rendering rather than a defect.
 *
 * So this folds one CODE POINT at a time and records, for each UTF-16 unit of
 * the output, the index of the source unit that produced it. `map.length` is
 * always `folded.length`, and `map[i] <= map[i + 1]`, which is what lets a range
 * in folded space be read straight back as a range in the original.
 *
 * Per code point rather than over the whole string is a small, deliberate change
 * of meaning that `fold` inherits: whole-string lowercasing is context
 * sensitive in a couple of places (Greek sigma takes its final form at the end
 * of a word), and an index wants folding to be position independent, so the
 * same word folds the same way wherever it appears. Canonical reordering across
 * a combining sequence is likewise moot here, because every combining mark is
 * stripped a line later. `any-ascii` is called per code point for the same
 * reason - it accepts a whole string, but feeding it one code point at a time
 * keeps its output attributable to a single source index like everything else
 * in this loop, even though nothing in this corpus's vocabulary actually
 * produces its multi-character transliterations (CJK, emoji).
 *
 * Deliberately does NOT trim: `fold` trims its own result, and trimming inside
 * this would shift every recorded index off the text it describes.
 *
 * @param {string} text
 * @returns {{folded: string, map: number[]}}
 */
export function foldWithMap(text) {
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

/**
 * Fold and split into searchable tokens.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.minLength] tokens shorter than this are dropped, or `a`
 *   matches most keywords in the corpus by substring
 * @param {boolean} [opts.stopwords] drop stopwords (true by default)
 */
export function tokenise(text, { minLength = 3, stopwords = true } = {}) {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= minLength && !(stopwords && STOPWORDS.has(t)));
}

/**
 * Parse a raw query into an ordered list of terms - one word, or one quoted
 * phrase treated as a single unit (docs/search_rules.md, "The parsed query").
 *
 * Quotes are found FIRST, before folding removes anything meaningful: every
 * `"..."` span becomes one term with `quoted: true`, and everything outside
 * quotes is split on whitespace into single-word terms the same way
 * `tokenise()` already splits. An unterminated quote (`art "nouveau`) is not a
 * parse error - the dangling `"` is just a character with nothing either side
 * of it to pair with, so the rest of the query reads as ordinary words.
 *
 * Deliberately does not apply the stopword/`minTokenLength` floor here -
 * that still happens per word for SCORING (`tokenise` inside `keywordScore`/
 * `storyScore` and friends), same as before quoting existed. Quoting changes
 * how a term is matched, not the vocabulary floor.
 *
 * @param {string} raw
 * @returns {import('./searchResult.ts').ParsedQuery}
 */
export function parseQuery(raw) {
  const text = String(raw ?? '');
  const terms = [];

  const pushWords = (chunk) => {
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
 * ONE classification, whether the term is a single word or a quoted phrase.
 *
 * This is `keywordScore`'s substring rule, read per term rather than blended
 * across the whole query: a quoted phrase is tested as its whole `folded` text
 * against each keyword, exactly like an unquoted single-word term already is,
 * which is what makes "quoting an unquoted-equivalent single word changes
 * nothing" (docs/search_rules.md, Feature additions) true for free - the two
 * cases share this one code path rather than being handled separately.
 *
 * @param {import('./searchResult.ts').Term} term
 * @param {string[]} keywords folded room keywords
 * @returns {{exact: boolean, partial: number}} `partial` is the best
 *   substring fraction found, 0 when there is no match at all (exact implies
 *   `partial` is meaningless and left at 0)
 */
export function classifyTagTerm(term, keywords) {
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
 * the FOLDED text rather than throwing position away.
 *
 * `tokenise()` is `fold(text).split(...)`, which is enough for a bag of words
 * but not for "how many characters does this run of the story span" - the
 * question `storyLongChars` (docs/search_rules.md "Story matching") asks.
 * Walking the same word-boundary regex `storyMatchRanges` already uses keeps
 * this in agreement with what counts as a word everywhere else in the file.
 */
function tokeniseWithPositions(text, { minLength = 3, stopwords = true } = {}) {
  const folded = fold(text);
  const out = [];
  for (const m of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0];
    if (word.length < minLength || (stopwords && STOPWORDS.has(word))) continue;
    out.push({ word, start: m.index, end: m.index + word.length });
  }
  return out;
}

/**
 * Build the per-room search index once, when metadata arrives.
 *
 * Folding and tokenising 5,000 stories on every query would be a megabyte and a
 * half of string work per search; doing it once at load leaves each query as set
 * lookups. Rooms without metadata stay null, so the array is still indexed by
 * room id.
 *
 * The story is kept as an ordered SEQUENCE of `{lemma, start, end}`, not a bag -
 * `storyScore`'s ratio only needs membership (`set`, kept alongside so that stays
 * an O(1) lookup), but the longest-contiguous-run measurement a long story match
 * needs (`longestMatchRun`, `storyPhraseRun`) has to know which words sit next to
 * which. Positions are into the FOLDED story, not the original - good enough for
 * a character-count threshold, and `storyMatchRanges` (which does need the
 * original for highlighting) re-walks the source text itself rather than reading
 * this index.
 *
 * @param {(import('./metadata.ts').RoomMeta|null)[]} joined output of `joinMetadata()`
 * @returns {import('./searchResult.ts').SearchIndex}
 */
export function buildSearchIndex(joined) {
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
      // Folded but NOT tokenised: a keyword is matched whole as well as by
      // token, so that a query of "art nouveau" scores 1 against the keyword
      // "art nouveau" rather than the 0.45 its two tokens would average to.
      keywords: (entry.keywords ?? []).map((k) => fold(k.text)),
      story: { sequence, set: new Set(sequence.map((t) => t.lemma)) },
    };
  });
}

/**
 * How well a query matches a room's keywords, in [0, 1].
 *
 * Two readings, and the better one wins:
 *
 *   - the whole query against the whole keyword, which is what makes an exact
 *     match score exactly 1 even when the keyword is two words long;
 *   - the mean over query tokens of each token's best keyword match, which is
 *     what lets a partial or reordered query score at all.
 *
 * A partial match is `matched length / keyword length`, so `art` against
 * `art nouveau` scores 3/11 and against `art` scores 1. Dividing by the KEYWORD
 * is deliberate: a short query matching a long keyword has matched less of it,
 * and should say so.
 *
 * The mean rather than the sum keeps the result in [0, 1] without clamping, and
 * rewards matching more *of the query* rather than rewarding longer queries.
 */
export function keywordScore(foldedQuery, queryTokens, keywords) {
  if (!keywords?.length) return 0;

  let whole = 0;
  if (foldedQuery)
    for (const k of keywords) {
      if (!k) continue;
      if (k === foldedQuery) {
        whole = 1;
        break;
      }
      if (k.includes(foldedQuery)) whole = Math.max(whole, foldedQuery.length / k.length);
    }

  let sum = 0;
  for (const token of queryTokens) {
    let best = 0;
    for (const k of keywords) {
      if (!k) continue;
      if (k === token) {
        best = 1;
        break;
      }
      if (k.includes(token)) best = Math.max(best, token.length / k.length);
    }
    sum += best;
  }
  const byToken = queryTokens.length ? sum / queryTokens.length : 0;

  return Math.max(whole, byToken);
}

/**
 * How well a query matches a room's story, in [0, 1].
 *
 * Normalised by the QUERY, not by the text - the opposite of the keyword rule,
 * and for a reason. Dividing a match by the length of the story would mean a
 * longer story scores lower for the same hit, which is backwards; what is being
 * asked is "how much of what you asked for is in here".
 *
 * Each token is weighted by its own length, so `cartographer` counts for more
 * than `oil`. Matching is by lemma, so `room` finds `rooms` and `survey` finds
 * `surveyed` - and, unlike the prefix rule it replaces, the reverse too -
 * while `cat` no longer matches `catalogue` the way a prefix test would, and
 * `animation` no longer matches `animal` the way a Porter stem did. The story
 * index is lemmatised once at build time (`buildSearchIndex`); the query's few
 * tokens are lemmatised here, and weighting stays keyed to the ORIGINAL token
 * length so the query-normalisation above still holds.
 *
 * @param {string[]} queryTokens raw (folded, untokenised-past-splitting) tokens
 * @param {import('./searchResult.ts').StoryIndex} storyIndex the room's story
 */
export function storyScore(queryTokens, storyIndex) {
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
 * The character span of the longest CONTIGUOUS run of story words whose lemma
 * is one of `matchLemmas` - what tells "cat" (one word, moderate certainty)
 * from "a room walled in glass" (a whole matched clause, saturating).
 *
 * "Contiguous" means adjacent in the story's own filtered token SEQUENCE, not
 * in the raw text - a stopword or a too-short word between two matches (`a
 * room OF glass`) does not break the run, because it was never part of the
 * index either. `matchLemmas` is unordered on purpose: this measures "most of
 * a sentence matched", not "matched in the order the query gave it" - that
 * stricter, ordered test is `storyPhraseRun`, for a quoted phrase.
 *
 * @param {import('./searchResult.ts').StorySequenceEntry[]} sequence
 * @param {Set<string>} matchLemmas
 * @returns {number} characters spanned by the longest run, 0 if none
 */
export function longestMatchRun(sequence, matchLemmas) {
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
 * Whether a quoted phrase's words appear in the story CONSECUTIVELY, by lemma,
 * in the order the phrase gave them - the story-side half of "a quoted phrase
 * is one contiguous story match" (docs/search_rules.md, Feature additions).
 * Unlike `longestMatchRun`, order matters: `"glass room"` must not match a
 * story where only `room glass` appears.
 *
 * @param {import('./searchResult.ts').StorySequenceEntry[]} sequence
 * @param {string[]} phraseLemmas the phrase's own words, lemmatised, in order
 * @returns {number} characters spanned by the match, 0 if the phrase is not found
 */
export function storyPhraseRun(sequence, phraseLemmas) {
  if (!sequence?.length || !phraseLemmas?.length) return 0;

  outer: for (let i = 0; i + phraseLemmas.length <= sequence.length; i++) {
    for (let j = 0; j < phraseLemmas.length; j++) {
      if (sequence[i + j].lemma !== phraseLemmas[j]) continue outer;
    }
    return sequence[i + phraseLemmas.length - 1].end - sequence[i].start;
  }
  return 0;
}

/**
 * ## Where the query matched, for highlighting
 *
 * Two functions, one per match rule, sitting under the two scorers they shadow
 * so that a change to either is visibly a change to a pair.
 *
 * They exist here rather than in a component for one reason: a view that
 * re-derives "what matched" will drift from the thing that ranked, and it will
 * drift silently - marked text that scored nothing, or a room in the cluster
 * with nothing marked at all. Both take the SAME `foldedQuery` and `queryTokens`
 * the ranking was computed from, so a token dropped for being a stopword or for
 * being under `minTokenLength` cannot highlight. It did not score, so it does
 * not mark.
 *
 * The asymmetry between them is the asymmetry between the scorers, and it is
 * not incidental: a keyword matches by SUBSTRING (`k.includes(token)`), a story
 * word by PREFIX (`word.startsWith(token)`, the cheap stand-in for stemming).
 * One highlighter over both would mark text `keywordScore` never looked at and
 * miss text `storyScore` credited.
 *
 * Both return ranges into the ORIGINAL string - sorted, merged, non-overlapping
 * - which is what `<Highlight>` renders and what makes them assertable without
 * a DOM.
 */

/**
 * Merge sorted-by-start ranges, dropping empties and collapsing overlaps.
 *
 * Two query tokens routinely hit the same span (`art` and `artist` against
 * `artists`), and nested or duplicated `<mark>` elements are not what anyone
 * wants to render or to read out.
 *
 * @param {import('./searchResult.ts').MatchRange[]} ranges
 * @returns {import('./searchResult.ts').MatchRange[]}
 */
function mergeRanges(ranges) {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Turn a [start, end) span of FOLDED text into one of the original.
 *
 * The end is exclusive, so it is the source index of the character *after* the
 * span - `map[end]` when there is one, and the string's length when the span
 * runs to the end.
 */
function toSource(map, srcLength, start, end) {
  return {
    start: map[start] ?? srcLength,
    end: end < map.length ? map[end] : srcLength,
  };
}

/** Every occurrence of `needle` in `hay`, as folded-space ranges. */
function occurrences(hay, needle) {
  const found = [];
  if (!needle) return found;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1))
    found.push({ start: i, end: i + needle.length });
  return found;
}

/**
 * Where a query matched one keyword, mirroring `keywordScore`'s substring rule.
 *
 * The union of both of that function's readings - the whole query as a
 * substring, and each query token as a substring - rather than only whichever
 * of the two won the score. They almost always overlap into one range anyway,
 * since a query contains its own tokens, and the union is the honest answer to
 * the question the reader is asking ("why is this chip here?") rather than to
 * the narrower "which arithmetic produced the number".
 *
 * @param {string} text the keyword as written, unfolded
 * @param {string} foldedQuery
 * @param {string[]} queryTokens
 * @returns {import('./searchResult.ts').MatchRange[]} ranges into `text`
 */
export function keywordMatchRanges(text, foldedQuery, queryTokens = []) {
  const src = String(text ?? '');
  if (!src) return [];
  const { folded, map } = foldWithMap(src);
  if (!folded) return [];

  const hits = occurrences(folded, foldedQuery);
  for (const token of queryTokens) hits.push(...occurrences(folded, token));

  return mergeRanges(hits.map((h) => toSource(map, src.length, h.start, h.end)));
}

/**
 * Where a query matched a story, mirroring `storyScore`'s STEM rule.
 *
 * Walks the text on the same word boundary `tokenise` splits on, and marks a
 * word whose lemma is one of the query's. That is the same test `storyScore`
 * makes against the pre-lemmatised index `buildSearchIndex` holds - lemmatising
 * here rather than reusing that set because this needs to know WHICH word in
 * the original text matched, and the index has thrown the positions away.
 *
 * Two details keep it faithful to what actually scored:
 *
 *   - words `tokenise` would have dropped are skipped, so a query token that
 *     lemmatises onto a stopword marks nothing - `storyScore` tests against
 *     the tokenised story, where that word is not present.
 *   - the WHOLE matched word is marked, not the lemma. `survey` marks all of
 *     `surveyed`. Marking three quarters of a word reads as a rendering bug;
 *     marking the word reads as "this is why this room is here", which is the
 *     question being asked.
 *
 * @param {string} text the story as written, unfolded
 * @param {string[]} queryTokens
 * @param {object} [opts]
 * @param {number} [opts.minLength] must match what built the story index
 * @returns {import('./searchResult.ts').MatchRange[]} ranges into `text`
 */
export function storyMatchRanges(text, queryTokens = [], { minLength = 3 } = {}) {
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
 *
 * @param {ArrayLike<number>} scores
 * @returns {Float32Array}
 */
export function normaliseScores(scores) {
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

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * Formula constants that are not user-tunable weights - unlike
 * `config.search.weights`, moving these means re-checking every cross-signal
 * inequality in docs/search_rules.md ("Balancing signals") they were chosen
 * to satisfy, not retuning by feel.
 *
 * `TAG_PARTIAL_SATURATION` caps how much a query can inflate `tagPartialSum`
 * by adding more partially-matching terms - without it, a long enough query
 * could add up to more than the `P` budget the exact-tag margin (`E > P + S +
 * L + C`) assumes. `STORY_LONG_RANGE` is the char-length band the "long story
 * match" bonus ramps across: below `low` (roughly one or two words) it is
 * exactly zero, by `high` (roughly a full clause) it has saturated.
 */
export const TAG_PARTIAL_SATURATION = 2;
export const STORY_LONG_RANGE = { low: 16, high: 40 };

/** The saturating curve `storyLongChars` feeds, shared by the ranking bonus and certainty's `S` term. */
function storyLongBonus01(chars) {
  const { low, high } = STORY_LONG_RANGE;
  return clamp01((chars - low) / (high - low));
}

/**
 * Certainty floor for a single matched story word - "cat" found once in a
 * story is real evidence, but not the near-certainty a whole matched clause
 * is. Unlike `CLIP_CERTAINTY`, there is no corpus distribution to measure this
 * against; it is a judgement call, same as `map.contentRatio` or the slide
 * timings in `packages/config/config.ts`.
 */
export const STORY_FLOOR = 0.5;

/**
 * CLIP's raw cosine placed against the three-anchor band, as a SIGNED
 * certainty in [-1, 1] (`docs/search_rules.md` "Computing certainty" and
 * "Image-content (CLIP) matching"): 0 at `band.centre` (the no-opinion point),
 * rising to +1 at `band.high` (a genuine match's typical confidence), falling
 * to -1 at `band.low` (a genuinely-irrelevant query's typical confidence).
 * Two linear segments, continuous at the centre - not one band either side of
 * a single hand-set floor.
 *
 * `clipCertaintyGate` - the ranking term docs/search_rules.md calls for - is
 * this function's output clamped to its positive half: `Math.max(0, ...)`,
 * done by the caller (`rankHybrid`), not here, because certainty's negative
 * half (`Cneg` in `matchCertainty`) needs the same call's negative half too.
 *
 * @param {number|null} cosine
 * @param {{centre: number, high: number, low: number}} band
 * @returns {number} in [-1, 1]
 */
export function signedClipCertainty(cosine, band = CLIP_CERTAINTY) {
  if (cosine === null || cosine === undefined || !Number.isFinite(cosine)) return 0;
  const { centre, high, low } = band;
  if (cosine >= centre) {
    const span = high - centre;
    if (!(span > 0)) return 0;
    return clamp01((cosine - centre) / span);
  }
  const span = centre - low;
  if (!(span > 0)) return 0;
  return -clamp01((centre - cosine) / span);
}

/**
 * `signedClipCertainty`'s output as the signed percentage docs/search_rules.md
 * "Reporting" wants: same sign, magnitude clamped to `0.01`-`99.99` so CLIP
 * never reads as completely certain in either direction - not even for the
 * anchor cosines themselves.
 *
 * @param {number} signed in [-1, 1]
 * @returns {number} in [-99.99, -0.01] union [0.01, 99.99]
 */
function clipCertaintyPercent(signed) {
  const magnitude = Math.min(99.99, Math.max(0.01, Math.abs(signed) * 100));
  return signed < 0 ? -magnitude : magnitude;
}

/**
 * How sure the search is that one room is a match - one signed number in
 * [-1, 1], positive is confidence the room matches, 0 is no opinion, negative
 * is confidence it does NOT (docs/search_rules.md, "Computing certainty").
 *
 * A signed soft-OR of three absolute readings, each computed from the room's
 * RAW evidence rather than anything normalised across the corpus - certainty
 * answers "would this hold up on its own", which a query nothing in the
 * corpus can answer honestly still needs a real answer to (this is what
 * `ordering.ts`'s density gradient reads, not the ranking score):
 *
 *   - `K` (tags): coverage-scaled - the mean, over every query term, of 1 for
 *     an exact match, the substring fraction for a partial one, 0 for none.
 *     Already computed by the caller (mean of `classifyTagTerm` over the
 *     query's terms), since certainty and ranking read the same per-term
 *     classification.
 *   - `S` (story): from ABSOLUTE matched length, not the query-relative ratio
 *     ranking uses - a single matched word sits at the moderate `STORY_FLOOR`,
 *     a full matched clause reaches 1. Using the ratio here would make a
 *     one-word query that matches read as 100% certain, which this exists to
 *     avoid.
 *   - `Cpos`/`Cneg`: the positive and negative halves of the signed CLIP curve.
 *
 * Positive certainty is `1 - (1-K)(1-S)(1-Cpos)` - any one signal can carry it
 * alone, and two weak agreeing signals count for more than either alone. The
 * signed result is that value when any positive signal fired, else `-Cneg`: a
 * room with real text evidence is never reported as a mismatch just because
 * CLIP is cool on its picture.
 *
 * @param {object} parts
 * @param {number} [parts.tagCoverage] K, already in [0, 1]
 * @param {number} [parts.storyLongChars] longest contiguous matched run, chars
 * @param {boolean} [parts.storyMatched] did any story word match at all - a
 *   single matched word's `storyLongChars` can sit under the ramp's floor and
 *   read as the same "zero" a non-match would, so this is passed explicitly
 * @param {number|null} [parts.cosine] raw CLIP cosine, or null/undefined
 * @param {{centre: number, high: number, low: number}} [clip] raw-cosine anchors
 * @returns {number} signed, in [-1, 1]
 */
export function matchCertainty(
  { tagCoverage = 0, storyLongChars = 0, storyMatched = false, cosine = null } = {},
  clip = CLIP_CERTAINTY
) {
  const K = clamp01(tagCoverage);
  const S = storyMatched ? STORY_FLOOR + (1 - STORY_FLOOR) * storyLongBonus01(storyLongChars) : 0;
  const signed = signedClipCertainty(cosine, clip);
  const Cpos = Math.max(0, signed);
  const Cneg = Math.max(0, -signed);

  const pos = 1 - (1 - K) * (1 - S) * (1 - Cpos);
  // `-0` is technically correct when nothing at all fired, but reads as a
  // surprising sign flip on an otherwise-zero certainty - `Cneg` itself is
  // already 0 in that case, so this is just avoiding IEEE 754's negative zero.
  return pos > 0 ? pos : Cneg > 0 ? -Cneg : 0;
}

/**
 * Rank the whole corpus by the blend of whatever signals are available.
 *
 * The weighted sum is the five constants docs/search_rules.md "Balancing
 * signals" names: `E` per exact tag, `P` for the saturating partial-tag
 * budget, `S` for a short story match, `L` for the saturating long-story
 * bonus, `C` for CLIP (`clipNorm * clipCertaintyGate` - the relative rank
 * position times the absolute confidence, so a query CLIP has no opinion
 * about cannot look confident just because it produced *some* top result).
 * Missing signals are omitted rather than substituted: no embedding blob means
 * the ranking is text-only and honest about it, and no metadata means it is
 * CLIP-only. Both are real rankings. Only the case where neither exists needs
 * the server's stub.
 *
 * @param {object} opts
 * @param {string} opts.query          the raw query string
 * @param {number} opts.count          rooms in the corpus
 * @param {object} opts.weights        `config.search.weights` - the five-constant shape
 * @param {number} [opts.minTokenLength]
 * @param {Int8Array} [opts.embeddings] the blob, roomCount * dim row-major
 * @param {number} [opts.dim]
 * @param {Float32Array|number[]} [opts.vector] the query vector, L2-normalised
 * @param {import('./searchResult.ts').SearchIndex} [opts.index]
 * @param {{centre: number, high: number, low: number}} [opts.clipCertainty]
 *   raw-cosine anchors for CLIP's share of certainty
 * @returns {import('./searchResult.ts').RankHybridResult}
 *   `certainty` is parallel to `order`, i.e. by rank, which is how the map's
 *   density gradient wants it - and `breakdown` follows the same convention,
 *   every array indexed by rank rather than by room id.
 *
 *   `breakdown` is what the catalog shows under a room and what `explainScore`
 *   formats. It is returned always rather than behind a flag: a second pass
 *   that recomputed these for display could disagree with the one that sorted,
 *   and a scoring explanation that does not match the scoring is worse than
 *   none.
 */
export function rankHybrid({
  query,
  count,
  weights,
  minTokenLength = 3,
  embeddings = null,
  dim = 0,
  vector = null,
  index = null,
  clipCertainty = CLIP_CERTAINTY,
}) {
  const parsed = parseQuery(query);
  const queryTokens = tokenise(query, { minLength: minTokenLength });
  const queryLemmas = new Set(queryTokens.map(lemmatise));
  // Quoted multi-word phrases get an ORDERED story run of their own, on top of
  // the unordered scattered-word run every query gets - see storyPhraseRun.
  const phraseLemmas = parsed.terms.filter((t) => t.quoted && t.words.length > 1).map((t) => t.words.map(lemmatise));

  // Stopwords and the minTokenLength floor still apply per word for tag
  // scoring, same as they always have for `queryTokens` above - quoting
  // changes how a term is MATCHED, not the vocabulary floor (docs/search_rules.md
  // "The parsed query"). A quoted phrase is one already-formed unit rather
  // than "a word", so it is always eligible regardless of its own length.
  const tagTerms = parsed.terms.filter(
    (t) => t.quoted || (t.folded.length >= minTokenLength && !STOPWORDS.has(t.folded))
  );

  // CLIP twice over, from one pass of dot products: raw cosines for certainty,
  // and the same column min-maxed for the blend. Two questions, two scalings -
  // see the header.
  let cosines = null;
  let clipNormAll = null;
  if (embeddings && dim > 0 && vector) {
    cosines = embeddingScores(embeddings, dim, Float32Array.from(vector));
    clipNormAll = normaliseScores(cosines);
  }

  const hasTerms = tagTerms.length > 0;
  const hasText = Boolean(index?.some(Boolean)) && (hasTerms || queryTokens.length > 0);

  const scored = new Array(count);
  let sawKeyword = false;
  let sawStory = false;

  for (let id = 0; id < count; id++) {
    let tagExact = 0;
    let tagPartialSum = 0;
    let tagCoverageSum = 0;
    let storyRatio = 0;
    let storyLongChars = 0;
    let storyMatched = false;

    if (hasText) {
      const entry = index[id];
      if (entry) {
        for (const term of tagTerms) {
          const { exact, partial } = classifyTagTerm(term, entry.keywords);
          tagCoverageSum += exact ? 1 : partial;
          if (exact) tagExact++;
          else tagPartialSum += partial;
        }

        storyRatio = storyScore(queryTokens, entry.story);
        storyMatched = storyRatio > 0;
        storyLongChars = longestMatchRun(entry.story.sequence, queryLemmas);
        for (const phrase of phraseLemmas)
          storyLongChars = Math.max(storyLongChars, storyPhraseRun(entry.story.sequence, phrase));

        if (tagExact > 0 || tagPartialSum > 0) sawKeyword = true;
        if (storyMatched) sawStory = true;
      }
    }

    const cosine = cosines ? (cosines[id] ?? null) : null;
    const clipNorm = clipNormAll ? (clipNormAll[id] ?? 0) : 0;
    const clipSigned = signedClipCertainty(cosine, clipCertainty);
    const clipCertaintyGate = Math.max(0, clipSigned);
    const storyLongBonus = storyLongBonus01(storyLongChars);
    const tagCoverage = hasTerms ? tagCoverageSum / tagTerms.length : 0;

    const score =
      weights.tagExact * tagExact +
      weights.tagPartial * clamp01(tagPartialSum / TAG_PARTIAL_SATURATION) +
      weights.story * storyRatio +
      weights.storyLong * storyLongBonus +
      weights.clip * clipNorm * clipCertaintyGate;

    scored[id] = {
      id,
      score,
      tagExact,
      tagPartialSum,
      storyRatio,
      storyLongChars,
      clipNorm,
      clipCertaintyGate,
      clipSigned,
      cosine,
      certainty: matchCertainty({ tagCoverage, storyLongChars, storyMatched, cosine }, clipCertainty),
    };
  }

  // Stable sort, so rooms that every signal is silent about keep their id order
  // rather than shuffling for no reason the reader can see.
  scored.sort((a, b) => b.score - a.score);

  const certainty = new Float32Array(count);
  const breakdown = {
    score: new Float32Array(count),
    tagExact: new Float32Array(count),
    tagPartialSum: new Float32Array(count),
    story: new Float32Array(count),
    storyLongChars: new Float32Array(count),
    clip: new Float32Array(count),
    clipCertaintyGate: new Float32Array(count),
    clipSigned: new Float32Array(count),
    cosine: new Float32Array(count),
  };
  for (let rank = 0; rank < count; rank++) {
    const row = scored[rank];
    certainty[rank] = row.certainty;
    breakdown.score[rank] = row.score;
    breakdown.tagExact[rank] = row.tagExact;
    breakdown.tagPartialSum[rank] = row.tagPartialSum;
    breakdown.story[rank] = row.storyRatio;
    breakdown.storyLongChars[rank] = row.storyLongChars;
    breakdown.clip[rank] = row.clipNorm;
    breakdown.clipCertaintyGate[rank] = row.clipCertaintyGate;
    breakdown.clipSigned[rank] = row.clipSigned;
    breakdown.cosine[rank] = row.cosine ?? NaN;
  }

  return {
    order: scored.map((s) => s.id),
    certainty,
    breakdown,
    signals: { clip: Boolean(clipNormAll), keyword: sawKeyword, story: sawStory },
  };
}

/**
 * One room's ranking, as rows a reader can check the sort against.
 *
 * The catalog shows this under every room while a search is running, and the
 * room card shows the same rows. It is the first place the distinction this
 * file's header spends a section on becomes something a reader can SEE rather
 * than something written down:
 *
 * > Ranking is relative; certainty is not.
 *
 * `breakdown.clip` is min-maxed across the corpus for this query, so SOME room
 * scores 1.00 for `art nouveau` and some room scores 1.00 for `cghjj`. Printing
 * that number alone would tell a reader the library was certain about a room it
 * has nothing to say about. So the CLIP row carries its RAW cosine alongside,
 * and `certainty` is its own row rather than being folded into the total - it
 * is the only number here computed against absolute bounds.
 *
 * A signal that contributed nothing is omitted rather than shown as zero: a row
 * of 0.00 tells a reader less than its absence does, and the ranking of a room
 * no text touched genuinely is "CLIP alone". Tag and story each get up to two
 * rows (exact/partial, short/long) since they are two independent terms in the
 * sum, not one - see docs/search_rules.md "Reporting".
 *
 * @param {number} rank position in `order`
 * @param {object} opts
 * @param {object} opts.breakdown from `rankHybrid`
 * @param {Float32Array} opts.certainty from `rankHybrid`
 * @param {object} opts.weights the five-constant `config.search.weights` shape
 * @returns {import('./searchResult.ts').ScoreExplanation}
 */
export function explainScore(rank, { breakdown, certainty, weights }) {
  const at = (arr) => (arr && rank < arr.length ? arr[rank] : 0);
  const rows = [];

  const tagExact = at(breakdown?.tagExact);
  if (tagExact > 0)
    rows.push({
      key: 'tagExact',
      label: 'exact tag',
      weighted: weights.tagExact * tagExact,
      raw: tagExact,
      note: 'count of exactly matched terms',
    });

  const tagPartialSum = at(breakdown?.tagPartialSum);
  if (tagPartialSum > 0)
    rows.push({
      key: 'tagPartial',
      label: 'partial tag',
      weighted: weights.tagPartial * clamp01(tagPartialSum / TAG_PARTIAL_SATURATION),
      raw: tagPartialSum,
      note: 'summed substring coverage across terms, saturating',
    });

  const storyRatio = at(breakdown?.story);
  if (storyRatio > 0)
    rows.push({
      key: 'story',
      label: 'story',
      weighted: weights.story * storyRatio,
      raw: storyRatio,
      note: 'share of the query found',
    });

  const storyLongChars = at(breakdown?.storyLongChars);
  const storyLongBonus = storyLongBonus01(storyLongChars);
  if (storyLongBonus > 0)
    rows.push({
      key: 'storyLong',
      label: 'long story match',
      weighted: weights.storyLong * storyLongBonus,
      raw: storyLongChars,
      note: 'characters in the longest contiguous run',
    });

  const cosine = at(breakdown?.cosine);
  if (Number.isFinite(cosine))
    rows.push({
      key: 'clip',
      label: 'CLIP',
      weighted: weights.clip * at(breakdown?.clip) * at(breakdown?.clipCertaintyGate),
      raw: cosine,
      note: 'relative to this query’s best and worst; the raw cosine is absolute',
      signedPercent: clipCertaintyPercent(at(breakdown?.clipSigned)),
    });

  return { rows, total: at(breakdown?.score), certainty: at(certainty) };
}
