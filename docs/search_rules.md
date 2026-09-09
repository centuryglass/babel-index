# Search rules

This is the full specification of what a search does: what a query is parsed into,
what one room's evaluation against that query looks like, how that evaluation
becomes an order and a set of displayed numbers, and every assertion about
behavior that the implementation (`packages/map/scoring.ts`, `packages/map/ordering.ts`,
`packages/config/config.ts`) has to satisfy. It supersedes every earlier draft of
this file.

This describes the finished behavior, not the code as it stands today. Where the
two differ — and they do, in named ways — the gap and the steps to close it live
in [`docs/search-plan.md`](search-plan.md), so this file can stay a clean
statement of the target rather than a running diff against the present.

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
  terms, independent of what anything else in the corpus scored". One signed
  number in `[-1, 1]`: positive is confidence the room matches, `0` is no
  opinion, negative is confidence it does *not*. It drives the map's density
  gradient (rooms the search is sure about cluster near the center; rooms it
  isn't stay scattered at the baseline - only the positive side clusters) and
  the percentages the UI reports. Its full definition is "Computing certainty".

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
  title: string | null,     // folded room title, or null - one string, not a
                             // list, because a room has at most one
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
  titleExact: boolean,         // did some term match the room's title exactly -
                                 // a bool, not a count: a room has one title, so
                                 // there is only ever one to match - see "Title
                                 // matching" for why this isn't folded into tagExact
  titlePartial: number,         // best substring fraction over every term tested
                                  // against the title - a MAX, not a sum, because
                                  // every term is testing the SAME one string
  storyRatio: number,          // matched story chars / query chars, in [0, 1] -
                                // a RANKING input; certainty reads the length below
  storyLongChars: number,       // longest CONTIGUOUS run of matched query words,
                                 // in chars - what tells "cat" (short, moderate
                                 // certainty) from a whole matched clause (100%)
  clipCosine: number | null,     // raw cosine against this room's image, or null
  clipNorm: number,                // clipCosine min-max normalised across every
                                     // room FOR THIS QUERY - always 1 for the
                                     // best-matching room, whatever the query was
  clipCertaintyGate: number,        // clipCosine placed against the match band,
                                     // in [0, 1] - the positive half of the signed
                                     // certainty curve, see "Image-content" below
  score: number,                     // the one weighted sum ranking sorts by
  certainty: number,                  // the one absolute [-1, 1] the density
}                                      // gradient and the UI's "how sure" reads -
                                       // negative is "sure it does NOT match", see
                                       // "Computing certainty"
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
    title: number[],                 // what "Tag ranking" / "tied with N others"
    story: number[],                // in the reporting rules needs. Ties are
    clip: number[],                  // real for tag/title/story (integer-ish
  },                                  // scores); CLIP ties are only exact-float
  ties: {                              // coincidences
    tag: number[],
    title: number[],
    story: number[],
    clip: number[],
  },
  signals: { keyword: boolean, title: boolean, story: boolean, clip: boolean },
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
- **A quoted phrase matches the story as an ordered run too.** The story is
  indexed as the lemmatised token *sequence*, positions kept, so a phrase is
  checked against the story the same way it is against a keyword: the phrase's
  words must appear consecutively (by lemma), not merely somewhere in the room.
  This is the same machinery the "long story match" rule needs - a contiguous
  run of matched query words - so quoted phrases get story credit for free once
  that exists, rather than being a special case. (The word-set index this
  replaces, and why the change is an architecture change rather than a parsing
  one, is `docs/search-plan.md` §3.)

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

### Title matching

A room's optional human-written `title` (`packages/map/metadata.ts`) is matched
the same way a keyword is - exact/partial, term by term, no fuzziness beyond the
substring rule tags already use - with one structural difference: a room has
*one* title, not a list of them, so where the tag rules sum or count across
several keywords, the title rules take the single best reading across the
query's terms instead. And an exact title match is prioritized slightly above
an exact tag match: naming the room by its actual title is the most specific
thing a query can do, more specific than repeating one of its three generic
style keywords.

**A term matches a title exactly or partially, by the same rule a term matches
a keyword.** Searching `"the unsurveyed room"` should match a room titled `The
Unsurveyed Room` exactly; searching `unsurveyed` should match it partially.
*Enforcement:* every term in the query (the same `tagTerms` the tag rules
classify - one word, or one quoted phrase treated as a single unit) is tested
against the room's title with `classifyTagTerm`, the identical function tag
matching uses, called with the title as a one-element keyword list. Quoting
behaves identically to the tag rule above: a quoted phrase is one match against
the title, never one match per word it contains.

**Multiple terms hitting the same title is the same evidence read twice, not
new evidence.** Two different keywords partially matched is stronger proof
than one - that's why `tagPartialSum` sums. Two different query terms landing
inside the same one title string is not the same kind of stacking: they are
both describing the identical piece of evidence.
*Enforcement:* `titlePartial` is the **maximum** substring fraction over every
term that matched partially, not a sum - unlike `tagPartialSum`. `titleExact`
is a single boolean (did any term equal the title exactly), not a count -
unlike `tagExact`, there is nothing for it to count past one, since a room only
has one title to match.

**An exact title match always outranks any non-exact-tag, non-exact-title
evidence, and outranks a single exact tag match too - but not by much.** A room
found by its exact title should edge out a room that only matched one of its
generic tags, but two exact tag matches (a strong, specific hit on real
generation keywords) should still beat one title.
*Enforcement:* `titleExact` is worth a fixed `T = 5.5` points, chosen so it
clears both bars with real margin: `T` is set above the combined ceiling of
every non-exact signal (`T > tagPartial + titlePartial + story + storyLong +
clip`, i.e. `5.5 > 0.45 + 0.2 + 0.4 + 2 + 1 = 4.05`), the same shape of
guarantee `E` (tag-exact) makes for itself - and `T` clears `E` itself
(`5.5 > 5`) by a deliberately small margin, "slightly", per the rule's own
wording. `T` stays well under `2E = 10`, so two exact tag matches still beat
one exact title match; `E` is unchanged and still clears every non-exact signal
including `titlePartial` (`5 > 0.45 + 0.2 + 0.4 + 2 + 1 = 4.05`).

**A partial title match is real evidence, weaker than a partial tag match.** A
tag is one of three deliberately-chosen style keywords; the title is one
string doing several jobs at once (display name, catalog sort key, spine
label), so a substring landing inside it is somewhat less specific evidence
of a real match than a substring landing inside a purpose-built tag.
*Enforcement:* the title-partial weight is `Pt = 0.2`, below tag-partial's
`P = 0.45`. `L` (the long-story bonus) still clears `clip + tagPartial +
titlePartial` with `L`'s existing margin intact
(`2 > 1 + 0.45 + 0.2 = 1.65`), so a long story match keeps outranking any
combination of CLIP, a partial tag match, and a partial title match at once -
the same guarantee "Story matching" makes below, now checked against one more
signal in the ceiling.

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
ordinary cosine range, see "Image-content (CLIP) matching" below) can beat the bare word
match. This is the same inequality as the partial-tag rule above, from the
story side.

**A long story match - most or all of a matched sentence - outranks every CLIP
match and every partial tag match, at once, unconditionally.** "Long" means
*contiguous*: a run of query words found consecutively in the story, not the same
words scattered across it. `cat dog bird fish` hitting four unrelated sentences is
not a long match; `a room walled in glass` found as one phrase is.
*Enforcement:* `storyLongChars` (the character length of the longest contiguous
run of matched query words, by lemma - not the query-relative ratio, and not a
sum over scattered hits) feeds a saturating bonus:
`storyLongBonus = clamp01((storyLongChars - 16) / (40 - 16))`. Below 16 matched
characters (roughly one or two words) the bonus is exactly zero; by 40 (roughly a
full clause) it saturates at `L = 2`, and `L` is set above `clip + tagPartial`
(`2 > 1 + 0.45 = 1.45`) - so it wins even against a room that is simultaneously
CLIP's top, fully-confident pick AND has a maxed-out partial tag match. Measuring
a contiguous run needs the story indexed as an ordered token sequence, not a set
(`docs/search-plan.md` §3).

**A quoted phrase is one contiguous story match, same as one keyword match.**
`"art nouveau"` credits the story only where those two words appear consecutively,
feeding `storyLongChars` as a single run - the same ordered-run test the long-match
rule above already makes, so quoting adds no new story mechanism.

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
corpus's cosine DISTRIBUTION, not guessed.** These phrases appear in the tag
and story rules above and need one precise meaning.
*Enforcement:* they read off the same signed certainty curve "Computing
certainty" defines - two linear segments meeting at `centre`, `0` there, `+1`
at `high`, `-1` at `low`. `clipCertaintyGate` is the positive half of that
curve read back into `[0, 1]`, and "reasonably/highly certain" means
`clipCertaintyGate >= 0.5`. All three anchors are measured by
`tools/embed/cosine-range.ts` against this corpus, not chosen: whole-list
percentiles silently assumed "most pairs are unrelated", which turned out
wrong for common, genuinely-true words (`book` scored below the naive
90th-percentile "noise" cutoff on real, correct matches) - so `centre` is
instead the *median* of the whole keyword x room distribution (`overall.p50`,
`≈0.205`, the noise band a query with no real signal lands in - validated
against a keysmash/nonsense probe, which landed within 0.01 of it), `high` is
the *median* ceiling across near-universal keywords true of nearly every room
(`bookshelf`, `book`, `library`, `shelf`, ... - `≈0.279`), and `low` is the
*median* ceiling across known-irrelevant strong concepts - things CLIP
recognises but that share nothing with a shelved library wall (`race car`,
`swimming pool`, `sandy beach`, ... - `≈0.171`). `low` landing BELOW `centre`
was the interesting result, not the expected one: a keysmash query embeds near
the corpus's mean direction (genuinely no signal), while a coherent-but-wrong
concept has its own specific direction that is actively dissimilar to library
imagery - so real off-topic content reads as more confidently wrong than
gibberish does. See `docs/search-plan.md` §5 for how each anchor was measured
and `cosine-stats.ts`'s docstring for why `centre`/`high`/`low` each read off a
different distribution.

### Balancing signals against each other

**Nothing here is a hard tier - every guarantee above is one inequality inside
a single weighted sum.** See "One sort, not tiers" in the overview.

**These seven constants ARE the search weights, not a separate accounting.**
`E=5` (per exact tag), `P=0.45` (partial-tag budget), `T=5.5` (exact title
match), `Pt=0.2` (partial-title budget), `S=0.4` (full short-story match),
`L=2` (long contiguous-story bonus) and `C=1` (CLIP) are exactly what
`config.search.weights` carries - the target replaces the three-way
`{keyword, story, clip}` it holds today with this seven-way
`{tagExact, tagPartial, titleExact, titlePartial, story, storyLong, clip}`
shape, because the exact/partial distinction needs its own weight for both tag
and title, and short/long needs its own weight for story, for the inequalities
to hold. Each was chosen so its rule's inequality holds with real margin, not
just at the boundary, so re-tuning any one requires re-checking the others'
margins rather than eyeballing it alone. (The current three weights, and why
the inequalities are false under them, are `docs/search-plan.md` §2.)

### Computing certainty

Ranking asked "which room is most like the query"; certainty asks the different
question the overview names - "how sure are we this is a real match, in absolute
terms" - and the density gradient and the "how sure" UI both read its answer.
It is one signed number in `[-1, 1]`: positive is confidence the room matches,
`0` is no opinion, negative is confidence it does *not*. It is built from the
same evaluation ranking uses, but from each signal's *absolute* reading, never
the query-normalised one.

**Certainty is a signed soft-OR of the three absolute readings.** Any one signal
can carry it alone - an exact tag is certain whatever CLIP thinks of the picture -
and two weak agreeing signals count for more than either alone.
*Enforcement:* three inputs, each in `[0, 1]`, plus CLIP's negative half:
- `K` (tags), **coverage-scaled**: each query term contributes `1` if it exactly
  equals a keyword, its substring fraction if it only partially matches, or `0`,
  and `K` is the mean of those over the query's terms. So a query wholly covered
  by exact tags is `1`, one exact term among several is high but not `1`, and a
  lone partial match is moderate - which is what "an exact tag pushes certainty
  to 100%" has to mean once a query can have terms an exact tag does not cover.
- `Kt` (title), the same coverage-scaled mean as `K`, but against the room's
  one title instead of its list of keywords - each query term contributes `1`
  for an exact title match, its substring fraction for a partial one, `0`
  otherwise, meaned over the query's terms. A room with no title contributes
  `Kt = 0` and drops out of the soft-OR below exactly as a room with no
  metadata drops out of `K`.
- `S` (story), from **absolute matched length**, not the query-relative
  `storyRatio` ranking uses: `S = STORY_FLOOR + (1 - STORY_FLOOR) x storyLongBonus01`
  when any story word matched, where `storyLongBonus01 = clamp01((storyLongChars
  - 16) / (40 - 16))` is the same contiguous-run curve the ranking bonus reads.
  A single matched word sits at the moderate `STORY_FLOOR`; a full matched clause
  reaches `1`. Using `storyRatio` here instead would make a one-word query that
  matches read as 100% certain, which is the bug this rule exists to avoid.
- `Cpos` / `Cneg` (CLIP), the positive and negative halves of the signed curve
  below: `Cpos = max(0, signedClip)`, `Cneg = max(0, -signedClip)`.

The positive certainty is the soft-OR
`pos = 1 - (1 - K)(1 - Kt)(1 - S)(1 - Cpos)`, and the signed result is `pos`
when any positive signal fired, else `-Cneg`. A room with real text evidence is
never reported as a mismatch just because CLIP is cool on its picture - the
negative reading is only reached when nothing positive contradicts it. With no
embedding blob `Cpos = Cneg = 0` and certainty is text-only; with no metadata
`K = Kt = S = 0` and certainty is CLIP-only, free to go negative; with no title
`Kt = 0` alone and certainty falls back to tags/story/CLIP exactly as it does
today.

**Certainty need not be monotone with rank; the map makes it so.** The blend
above can hand back a later rank a higher certainty than an earlier one (they
sort on `score`, not on this). `ordering.ts`'s density ramp takes the running
minimum down the ranks and snaps anything under `CERTAINTY_FLOOR` to the
baseline, so density still falls monotonically outward - certainty does not have
to arrive that way. Only the positive part feeds the gradient: a mismatch is not
a reason to cluster a room toward the center.

### Reporting

**CLIP's reported certainty is a signed percentage anchored on the
distribution's no-opinion centre.** The number shown to a reader is the signed
curve above rendered as a percentage: `0` at the cosine an unrelated query lands
at, rising toward `+100%` at the high extreme a genuine match reaches, and - for
the rare cosine that falls *below* the no-opinion centre - toward `-100%`.
*Enforcement:* a monotone map with three measured anchors (no-opinion centre,
high extreme, low extreme) rather than one linear band from a hand-set floor. A
signed transform of the measured noise CDF is the natural shape; `cosine-stats.ts`
computes the percentiles it reads. Most of the negative percentage range maps
onto *low-positive* cosines - text→image cosines almost never actually go below
zero on this corpus (global min `-0.060` across 4.4M pairs) - so a "does not
match" reading is a cosine well under the noise centre, not a negative cosine.

**CLIP is never reported as completely certain, in either direction.** The
percentage is clamped to `0.01%`-`99.99%` (and the same for the negative side)
- CLIP never gets the last word.

**A negative match reads as evidence of a mismatch, not as a bare minus sign.**
A cosine below the no-opinion centre is shown as a compact phrase like "73%
certain the image content does not match the text", in a visually distinct style
(a different color, and either italics or bold - resolved during implementation)
so it is not confused with a positive, if weaker, match. Internally this is the
negative certainty value (e.g. `-0.73`); the phrasing is how it is surfaced.

**Tags, titles, and story report counts, not percentages - certainty isn't the
right question for them.** A tag match is either exact, partial, or absent; a
title match is the same, once per room; a story match is a run of characters.
There's no meaningful "73% sure" reading for any of them.
*Enforcement:* the tag row shows `tagExact` and however many terms matched
partially (derived from `tagPartialSum`'s contributing terms); the title row
shows whether `titleExact` fired, or that the title matched partially; the
story row shows `storyLongChars`. None of the three reads from the CLIP
certainty curve - the distribution anchors exist only for the CLIP row.

**Every room can be read on each axis independently, including how it compares
only on that axis.** A reader should be able to see "this room ranks #4 by tag
match, tied with 2 others" separately from its overall position - and the same
for title.
*Enforcement:* `SearchResult.ranks`/`ties` (see Data structures) are computed
by sorting `breakdown.tagExact`/`tagPartialSum`, `breakdown.titleExact`/
`titlePartial`, `breakdown.storyRatio`/`storyLongChars`, and
`breakdown.clipCosine` independently of the composite `order` - four extra
sorts of already-computed numbers, not four extra scoring passes.

**The composite view shows one ranking and explains itself on demand.** The
main display is just the overall rank (`x / unique_tile_count`); a tooltip
breaks down what earned it, as a percentage of the total score contributed by
each signal that actually contributed something.
*Enforcement:* `explainScore` already omits a signal entirely when it
contributed zero (a room no text touched shows only a CLIP row) rather than
printing a false `0%` - the tooltip's percentages are `weighted signal
contribution / RoomMatch.score`, read off the same `breakdown` structure
everything else in this document reads from.
