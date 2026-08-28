# Search rules

This is the full specification of what a search does: what a query is parsed into,
what one room's evaluation against that query looks like, how that evaluation
becomes an order and a set of displayed numbers, and every assertion about
behavior that the implementation (`packages/map/scoring.js`, `packages/map/ordering.ts`,
`packages/config/config.ts`) has to satisfy. It supersedes every earlier draft of
this file.

## Overview: one evaluation, two questions

A search asks each room in the corpus the same three questions - does the query
match your tags, does it match your story, does it match your picture - and folds
the answers into one number per room. That one number is used for two different
purposes, and the difference between them is the single most important thing to
hold onto while reading the rest of this document:

- **Ranking** answers "which rooms are the best matches, relative to each other,
  for this query on this corpus". It sorts the whole corpus into one order. A
  weighted sum, not a tiered bucket sort - see "One sort, not tiers" below.
- **Certainty** answers "how sure are we that this is a real match, in absolute
  terms, independent of what anything else in the corpus scored". It drives the
  map's density gradient (rooms the search is sure about cluster near the
  center; rooms it isn't stay scattered at the baseline) and the percentages the
  UI reports.

These can't be answered from the same number, because ranking is *relative* -
some room is always the best match for any query, including a nonsense one - and
certainty needs to be able to say "none of these are good" when that's true. A
raw CLIP cosine that is merely the best of a bad lot must not read as certain.
Both computations happen in the same pass over the corpus (there's no reason to
score twice), but they read different halves of the data: ranking reads scores
normalised *within this query's results*, certainty reads raw scores against
*fixed, corpus-measured bounds*. Whenever a rule below says "reasonably certain"
or "highly certain", it means the absolute reading, never the relative one.

### One sort, not tiers

Every rule below - "an exact tag match should outrank a CLIP match", "a long
story match should outrank a partial tag match" - reads like a rule for sorting
into buckets: tags first, then story, then image content. That is not how this
is built, on purpose. A tiered sort lets one weak signal in a high tier beat a
strong signal in a low one - a room with one throwaway partial tag match would
permanently outrank a room CLIP is completely certain about, just for being in
a higher bucket - which breaks the reason a hybrid search exists at all.

Instead, everything is one weighted sum, and the assertions below hold because
the *constants* in that sum are chosen so the inequality is true by construction
- not because of case-by-case bucket logic. "An exact tag match always outranks
a CLIP match" is true because one exact tag match's score contribution is
larger than the maximum every other signal could possibly add up to, not
because tag matches are sorted into a bucket ahead of CLIP matches. See each
assertion's enforcement for the arithmetic.

## Data structures

### 1. The parsed query

A query is parsed into an ordered list of **terms**, not a flat list of words.
This is what makes quoted-phrase matching (see Feature additions) possible
without disturbing anything else: everywhere the rest of this document says
"term", read "one word, or one quoted phrase treated as a single unit".

```
Term = {
  text: string,       // as typed, one word or the contents of one "quoted phrase"
  folded: string,      // fold(text) - lowercased, accent-stripped, ASCII
  quoted: boolean,      // was this a "quoted phrase" in the original query?
  words: string[],      // folded, tokenised sub-words - always [folded] for an
}                       // unquoted term, the phrase's own words for a quoted one

ParsedQuery = {
  raw: string,          // the query exactly as typed
  folded: string,        // fold(raw) - the whole query, still used for the
  terms: Term[],         // existing "whole query against one keyword" reading
}
```

Splitting happens before folding removes anything meaningful: quotes are found
first, everything inside one pair becomes one term with `quoted: true`, and
everything outside quotes is split on whitespace into single-word terms the
same way `tokenise()` already works. Stopwords and the `minTokenLength` floor
still apply per word for scoring purposes, same as today - quoting changes how
a term is matched, not the vocabulary floor.

### 2. The per-room index

Unchanged by any of the above - this is the existing shape `buildSearchIndex`
already produces, and quoted-phrase matching (keyword-only, see Feature
additions) needs no new fields here, since a keyword is already stored as one
folded string and a phrase is tested as a substring the same way a word is:

```
RoomIndex = {
  keywords: string[],      // folded, one entry per tag, NOT tokenised further
  story: Set<string>,       // lemmatised story words - order and adjacency are
}                           // already gone; this is why story can't see phrases
```

### 3. One room's evaluation against one query

This is what the scoring pass computes for every room, and what `explainScore`
reads to build the display. Ranking, certainty, and every reporting number in
this document all come out of this one structure - nothing downstream
recomputes any of it independently.

```
RoomMatch = {
  tagExact: number,          // n - count of terms that exactly equal a keyword
  tagPartialSum: number,      // sum of best-substring fractions over every term
                               // that matched partially (not exactly) - a SUM,
                               // not an average; see the tag assertions for why
  storyRatio: number,          // matched story chars / query chars, in [0, 1]
  storyMatchedChars: number,    // absolute count - what tells "cat" apart from
                                 // a whole matched sentence, which storyRatio can't
  clipCosine: number | null,     // raw cosine against this room's image, or null
  clipNorm: number,                // clipCosine min-max normalised across every
                                     // room FOR THIS QUERY - always 1 for the
                                     // best-matching room, whatever the query was
  clipCertaintyGate: number,        // clipCosine placed against CLIP_MATCH_BAND,
                                     // in [0, 1] - see "Calibrating CLIP" below
  score: number,                     // the one weighted sum ranking sorts by
  certainty: number,                  // the one absolute [0, 1] the density
}                                      // gradient and the UI's "how sure" reads
```

### 4. The corpus-wide result

```
SearchResult = {
  order: number[],           // room ids, best RoomMatch.score first
  certainty: Float32Array,    // parallel to order: RoomMatch.certainty per rank
  breakdown: {                 // parallel to order, one array per RoomMatch field,
    ...RoomMatch fields          // so a display can read "rank 4's tagExact" etc.
  },
  ranks: {                       // this rank's position if sorted by ONE signal
    tag: number[],                 // alone, plus how many rooms tie with it -
    story: number[],                // what "Tag ranking" / "tied with N others"
    clip: number[],                  // in the reporting rules needs. Ties are
  },                                  // real for tag/story (integer-ish scores);
  ties: {                               // CLIP ties are only exact-float coincidences
    tag: number[],
    story: number[],
    clip: number[],
  },
  signals: { keyword: boolean, story: boolean, clip: boolean },
}
```

`ranks`/`ties` are independent per-signal sorts of the same `breakdown` arrays
already computed - no new scoring, just three more sorts of numbers the pass
already produced, kept out of the main `order` so re-sorting for a display
column never touches placement.

## Feature additions

- **Quoted-phrase matching, scoped to tags only.** `"art nouveau"` is tested as
  one term against a room's keywords - exact if some keyword equals the whole
  phrase, partial if some keyword contains it as a substring - and is NOT also
  broken into `art` and `nouveau` for separate credit. This is a deliberate
  precision-over-recall tradeoff, the same one phrase search always makes: a
  room tagged `art` and `nouveau` as two *separate* keywords gets zero tag
  credit from the quoted phrase, because the phrase never appears as a
  contiguous run in either one. Quoting an unquoted-equivalent single word
  (`"art"`) changes nothing.
- **Story text does not understand quotes yet.** `buildSearchIndex` keeps only
  a lemmatised `Set<string>` for a room's story - no order, no adjacency - so
  there is nothing in the index a phrase's word-order could be checked against.
  A quoted phrase's words still count toward story matching individually,
  exactly as if the query had been unquoted. Real phrase-in-story matching
  needs the index to keep something closer to the raw text and a substring
  search at query time (the same shape `storyMatchRanges` already builds for
  highlighting, generalised into a score) - a real architecture change, not a
  parsing change, and out of scope here.

## Assertions

Each assertion is a plain statement of behavior, followed by exactly how the
implementation makes it true.

### Text matching mechanics

**Matching ignores case, accents, and other diacritics.** `rosé` and `rose`,
`Café` and `cafe`, are the same query and the same keyword.
*Enforcement:* every string is run through `fold()` before comparison - NFD
decomposition strips combining marks, then `any-ascii` transliterates whatever
is left that isn't already ASCII (this covers letters like `ł` or `ø` that have
nothing for NFD to strip).

**A story match only counts a genuine form of the same word, not a lookalike.**
Searching `cat` must not match `category`; searching `room` should match
`rooms`; searching `animation` must not match `animal`.
*Enforcement:* story matching compares **lemmas** (`wink-lemmatizer`, trying
noun then verb then adjective rules), not prefixes or stems. A Porter-style
stemmer was tried and rejected specifically because it collapses `animation`
and `animal` onto the same stem - a real false positive, not hypothetical.

**Very short words and common filler words carry no search signal.**
Searching `a room of glass` should not spend meaningful weight on `a` or `of`.
*Enforcement:* `tokenise()` drops any token under `minTokenLength` (default 3 -
`a` would otherwise substring-match most keywords in the corpus) and drops a
fixed stopword list (`the`, `and`, `with`, ...) before scoring ever sees them. A
word this drops cannot score, and therefore cannot be highlighted either - the
same token list feeds both.

**A pasted wall of text can't be used to lock up the search.** A query is
capped at `maxQueryLength` (256) characters, enforced in `search()` itself so
a keyword chip, a history entry, or a shelf-book search - not only what's typed
into the box - all go through the same limit.

### Tag matching

**An exact tag match always outranks any non-exact-tag evidence.** A room with
one exact tag match beats a room with any combination of partial tags, story
matches, and CLIP confidence, no matter how strong.
*Enforcement:* `tagExact` (`n`) is worth a fixed `E = 5` points per match, and
`E` is set above the combined ceiling of every other signal
(`E > tagPartial + story + storyLong + clip`, i.e. `5 > 0.45 + 0.4 + 2 + 1 =
3.85`) - so a single additional exact tag match can never be caught up by
anything else in the sum, whatever those other signals are doing.

**More exact tag matches always beat fewer.** Searching `alien impasto` should
rank a room tagged with both `alien` and `impasto` above one tagged with only
one of them.
*Enforcement:* the same margin above applies to each additional exact match -
`n` exact matches are worth `n * E`, and `E` alone already exceeds everything
non-exact-tag could contribute, so `n+1` beats `n` unconditionally.

**A partial tag match is real evidence, but a confident image match beats a
lone one.** `art` partially matching the tag `art nouveau` should count for
something, but a room CLIP is genuinely confident about should still win.
*Enforcement:* the partial-tag budget is capped at `P = 0.45` regardless of how
many terms partially match or how strong any one fraction is (summed fractions
are clamped against a saturation constant, `TAG_PARTIAL_SATURATION = 2`, so it
can't be inflated by a long query). A "reasonably certain" CLIP match - defined
below as `clipCertaintyGate >= 0.5` on the room CLIP is most confident about -
contributes at least `0.5` points, which already clears `0.45`.

**More partial tag matches beat fewer, for the same number of exact matches.**
*Enforcement:* `tagPartialSum` is a running **sum**, not an average, over every
partially-matching term. A sum can only grow as matches are added; an average
can fall when a weaker match joins a stronger one, which would rank a room with
*more* evidence lower - backwards from what this rule asks for.

**A quoted phrase is one match, not one match per word it contains.**
Searching `"art nouveau"` credits at most one exact or one partial match for
that whole phrase, never two.
*Enforcement:* a quoted term is one entry in the parsed query's `terms` list
(see Data structures) and is classified exactly once, the same as any
single-word term - it simply tests the whole phrase as the substring/equality
candidate instead of one word.

### Story matching

**A short, exact story match is real evidence, and beats an ordinary or weak
image match - but a genuinely confident one can still win.** Searching `cat`
and finding it in a room's story should usually outrank CLIP, unless CLIP is
unusually sure of itself.
*Enforcement:* a single-term query that fully matches always reaches
`storyRatio = 1` (the ratio is against the *query's* length, not the story's),
contributing the full `S = 0.4`. Since a "highly certain" CLIP match
contributes at least `0.5` (`clip * clipCertaintyGate >= 1 * 0.5`), it still
wins - but nothing short of that threshold (roughly the top of the corpus's
ordinary cosine range, see "Calibrating CLIP" below) can beat the bare word
match. This is the same inequality as the partial-tag rule above, from the
story side.

**A long story match - most or all of a matched sentence - outranks every CLIP
match and every partial tag match, at once, unconditionally.**
*Enforcement:* `storyMatchedChars` (the absolute count of matched characters,
not the query-relative ratio) feeds a saturating bonus:
`storyLongBonus = clamp01((storyMatchedChars - 16) / (40 - 16))`. Below 16
matched characters (roughly one or two words) the bonus is exactly zero;
by 40 (roughly a full clause) it saturates at `L = 2`, and `L` is set above
`clip + tagPartial` (`2 > 1 + 0.45 = 1.45`) - so it wins even against a room
that is simultaneously CLIP's top, fully-confident pick AND has a maxed-out
partial tag match.

**Quoted phrases get no special story treatment (yet).** See Feature additions
- a quoted phrase's words score against the story exactly as if unquoted.

### Image-content (CLIP) matching

**A query CLIP has no real opinion about cannot look confident just because it
produced *some* top result.** Every query has a best-matching room by
construction of relative ranking (min-max normalisation always gives the top
result exactly `1.0`) - that must not read as a strong match for a query like
`cghjj`.
*Enforcement:* CLIP's contribution to the ranking sum is
`clip * clipNorm * clipCertaintyGate` - the *relative* rank position
(`clipNorm`) multiplied by the *absolute* confidence (`clipCertaintyGate`,
read off the raw cosine against fixed, corpus-measured bounds). A query with no
real signal has every raw cosine sitting low against those bounds, so
`clipCertaintyGate` is near zero and the whole term contributes almost nothing
- whatever `clipNorm` says.

**"Reasonably certain" and "highly certain" are calibrated against this
corpus, not guessed.** These phrases appear in the tag and story rules above
and need one precise meaning.
*Enforcement:* `clipCertaintyGate = clamp01((clipCosine - CLIP_MATCH_BAND.low)
/ (CLIP_MATCH_BAND.high - CLIP_MATCH_BAND.low))`, and "reasonably/highly
certain" means `clipCertaintyGate >= 0.5`. `CLIP_MATCH_BAND` is calibrated from
`tools/embed/cosine-range.ts` run against known-near-universal keywords for
this corpus (`bookshelf`, `book`, `library`, `shelf`, ... - words true of
nearly every room) rather than off percentiles of the whole keyword list: the
whole-list percentile approach silently assumed "most pairs are unrelated",
which turned out to be wrong for common, genuinely-true words (`book` scored
below the naive 90th-percentile "noise" cutoff on real, correct matches). The
measured band is `{ low: 0.217, high: 0.279 }` - the floor is the *weakest*
p10 across every universal keyword tried (conservative, since different
phrasings sit at different absolute cosines - see the cosine-stats.ts
docstring), the ceiling is the *median* p50 across them.

### Balancing signals against each other

**Nothing here is a hard tier - every guarantee above is one inequality inside
a single weighted sum.** See "One sort, not tiers" in the overview. Every
constant referenced above (`E=5, P=0.45, C=1, S=0.4, L=2`) was chosen
specifically so each rule's inequality holds with real margin, not just at the
boundary - re-tuning any one of them requires re-checking the others' margins,
not just eyeballing the new number in isolation.

### Certainty and reporting

**CLIP's reported certainty is a percentage that can reach either extreme.**
Unlike the internal "reasonably certain" band above, the number shown to a
reader spans the full range this model has ever produced on this corpus, so a
truly extreme match or mismatch can still read as close to 100%/-100%.
*Enforcement:* the displayed percentage uses a separate, wider band,
`CLIP_DISPLAY_RANGE = { low: -0.08, high: 0.37 }` - padded just past the
measured global extremes (`-0.060` to `0.346`, stable across two independently
measured corpora) rather than the tight `CLIP_MATCH_BAND` used for ranking
decisions. The two bands answer different questions (see the overview) and
must not be merged into one.

**CLIP is never reported as completely certain, in either direction.** The
percentage is clamped to `0.01%`-`99.99%` (and the same for the negative side)
- CLIP never gets the last word.

**A negative match reads as evidence of a mismatch, not as a negative number.**
A cosine below the display range's midpoint is shown as a compact phrase like
"73% certain this does not match", in a visually distinct style (a different
color, and either italics or bold - resolved during implementation) so it is
not confused with a positive, if weaker, match.

**Tags and story report counts, not percentages - certainty isn't the right
question for them.** A tag match is either exact, partial, or absent; a story
match is a run of characters. There's no meaningful "73% sure" reading for
either.
*Enforcement:* the tag row shows `tagExact` and however many terms matched
partially (derived from `tagPartialSum`'s contributing terms); the story row
shows `storyMatchedChars`. Neither reads from `CLIP_MATCH_BAND` or
`CLIP_DISPLAY_RANGE` - those exist only for the CLIP row.

**Every room can be read on each axis independently, including how it compares
only on that axis.** A reader should be able to see "this room ranks #4 by tag
match, tied with 2 others" separately from its overall position.
*Enforcement:* `SearchResult.ranks`/`ties` (see Data structures) are computed
by sorting `breakdown.tagExact`/`tagPartialSum`, `breakdown.storyRatio`/
`storyMatchedChars`, and `breakdown.clipCosine` independently of the composite
`order` - three extra sorts of already-computed numbers, not three extra
scoring passes.

**The composite view shows one ranking and explains itself on demand.** The
main display is just the overall rank (`x / unique_tile_count`); a tooltip
breaks down what earned it, as a percentage of the total score contributed by
each signal that actually contributed something.
*Enforcement:* `explainScore` already omits a signal entirely when it
contributed zero (a room no text touched shows only a CLIP row) rather than
printing a false `0%` - the tooltip's percentages are `weighted signal
contribution / RoomMatch.score`, read off the same `breakdown` structure
everything else in this document reads from.
