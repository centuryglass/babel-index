# Search rules

The specification of what a search does: how a query is parsed, how each room
is scored against it, and how that score becomes an order, a map density and
the numbers a reader sees. It describes the code as built
(`packages/map/scoring.ts`, `packages/map/ordering.ts`,
`packages/config/config.ts`). A change to a weight, a matching rule or a
strength anchor updates this file in the same commit.

What search has to accomplish for a reader is stated separately, in
[`search_requirements.md`](search_requirements.md).

## Overview: one evaluation, two questions

A search asks every room four questions - does the query match your tags,
your title, your story, your picture - in one pass over the corpus. From the
answers it computes two numbers per room, which answer different questions:

- **Ranking** (`score`) answers "which rooms are the best matches, relative to
  each other, for this query on this corpus". It is one weighted sum that
  sorts the whole corpus into one order (see "One sort, not tiers").
- **Strength** (`strength`) answers "how good is this room's match, in
  absolute terms, whatever else in the corpus scored". It is one number in
  `[0, 1]`, `0` for no evidence. It drives the map's density gradient (strong
  matches cluster near the center, the rest stay at the baseline) and the
  percentages the UI reports. See "Computing strength".

One number cannot answer both. Ranking is relative: some room is always the
best match for any query, including a nonsense one. Strength has to be able
to say "none of these are good". So ranking reads CLIP normalised *within
this query's results*, and strength reads raw scores against *fixed,
corpus-measured bounds*. A raw CLIP cosine that is merely the best of a bad
lot must not read as a strong match.

Strength is evidence, never counter-evidence. No signal can find evidence
against a room, so nothing reports a mismatch.

Strength is not coverage. A room that matched one term of a five-term query
exactly is a strong match for that term, and says so. How much of the query
a room explains is decided by ranking's counts.

### One sort, not tiers

The rules below read like bucket rules ("an exact tag match outranks a CLIP
match"), but the implementation is a single weighted sum. A tiered sort would
let one weak signal in a high tier beat a strong signal in a low one: a room
with one throwaway partial tag match would outrank a room CLIP is certain
about.

Each rule holds because the weights make its inequality true. "An exact tag
match outranks any non-exact evidence" holds because one exact tag's
contribution is larger than every non-exact signal's maximum added together.
"Balancing signals against each other" lists the weights and the
inequalities.

## Assertions

Each assertion is a statement of behavior, followed by how the implementation
makes it true.

### Balancing signals against each other

**The seven weights are `config.search.weights`, and every cross-signal
guarantee is an inequality over them.**

| Symbol | `search.weights` key | Default | Weighs |
| --- | --- | --- | --- |
| `E` | `tagExact` | 5 | each term that exactly equals a keyword |
| `P` | `tagPartial` | 0.45 | the partial-tag budget, `clamp01(tagPartialSum / TAG_PARTIAL_SATURATION)` |
| `T` | `titleExact` | 5.5 | an exact title match (0 or 1) |
| `Pt` | `titlePartial` | 0.2 | the best partial title fraction |
| `S` | `story` | 0.4 | `storyRatio`, the query-relative story match |
| `L` | `storyLong` | 2 | the long-story bonus, a curve of `storyLongChars` |
| `C` | `clip` | 1 | `clipNorm * clipStrengthGate` |

The ranking score is:

```
score = E * tagExact + P * clamp01(tagPartialSum / TAG_PARTIAL_SATURATION)
      + T * titleExact + Pt * titlePartial
      + S * storyRatio + L * storyLongBonus
      + C * clipNorm * clipStrengthGate
```

The inequalities the defaults satisfy, and the rule each one serves:

| Inequality | Defaults | What it guarantees |
| --- | --- | --- |
| `E > P + Pt + S + L + C` | `5 > 4.05` | an exact tag outranks all non-exact evidence combined |
| `T > P + Pt + S + L + C` | `5.5 > 4.05` | an exact title does too |
| `E < T < 2E` | `5 < 5.5 < 10` | an exact title edges out one exact tag, not two |
| `L > C + P + Pt` | `2 > 1.65` | a long story match outranks CLIP plus maxed partial tag and title matches |
| `C * 0.5 >= P` | `0.5 >= 0.45` | a reasonably certain CLIP match clears the partial-tag budget |

Each default clears its inequality with margin, so re-tuning one weight means
re-checking every inequality it appears in. `config.test.ts` and
`scoring.test.ts` assert them, against `DEFAULTS` only: a `config.json` can
set weights that break them, and nothing reports it (open issue
[#229](https://github.com/centuryglass/babel-index/issues/229)).

Four formula constants in `scoring.ts` are not config. The first two shape
terms the inequalities bound; the last two feed strength, not the score:

- `TAG_PARTIAL_SATURATION` (2): how much summed partial-tag fraction fills
  the `P` budget.
- `STORY_LONG_RANGE` (`{ low: 16, high: 40 }`): the character band the
  long-story bonus ramps across.
- `STORY_FLOOR` (0.5): strength's reading for any story match.
  A judgement call, with no distribution to measure it against.
- `CLIP_STRENGTH` (`{ centre, high }`): the default CLIP anchors, overridable
  as `search.density.clipCentre`/`clipHigh`.

### Text matching mechanics

**Matching ignores case, accents, and other diacritics.** `rosé` and `rose`,
`Café` and `cafe`, are the same query and the same keyword.
*Enforcement:* every string goes through `fold()`: NFD decomposition with
combining marks stripped, lowercasing, then `any-ascii` for whatever is still
not ASCII (letters like `ł` or `ø`, which NFD has nothing to strip from).

**A story match counts only a genuine form of the same word, not a
lookalike.** Searching `cat` must not match `category`; `room` should match
`rooms`; `animation` must not match `animal`.
*Enforcement:* story matching compares lemmas (`wink-lemmatizer`, trying
noun, then verb, then adjective rules), not prefixes or stems. A
suffix-collapsing stemmer folds `animation` and `animal` onto one stem.

**Very short words and common filler words carry no search signal.**
Searching `a room of glass` should not spend weight on `a` or `of`.
*Enforcement:* `tokenise()` drops any token shorter than
`search.minTokenLength` (default 3; `a` would otherwise substring-match most
keywords) and any word in `STOPWORDS`. A dropped word cannot score, and so
cannot be highlighted: the same token list feeds both. The tag and title
rules apply the same floor to unquoted terms; a quoted phrase is always
eligible.

**A pasted wall of text cannot lock up the search.** A query is truncated to
`search.maxQueryLength` (default 256) characters.
*Enforcement:* `useSearch.ts`'s `search()` truncates, so a keyword chip, a
history entry and a shelf-book search pass through the same limit as typing.
`/api/search` truncates again server-side, since a direct request never goes
through `search()`.

### Tag matching

A term matches a keyword exactly when its folded text equals the folded
keyword, and partially by the fraction of the keyword it covers as a
substring (`classifyTagTerm`). `art` covers 3/11 of `art nouveau`.

**An exact tag match outranks any non-exact evidence.** A room with one exact
tag match beats a room with any combination of partial tags, partial titles,
story matches and CLIP confidence.
*Enforcement:* `E > P + Pt + S + L + C`. An exact title match is not
non-exact evidence; see "Title matching".

**More exact tag matches beat fewer, all else equal.** Searching
`alien impasto` should rank a room tagged with both above one tagged with
only one.
*Enforcement:* `n` exact matches are worth `n * E`, and `E` alone exceeds all
non-exact evidence, so `n + 1` beats `n` between rooms with the same title
reading. An exact title match (`T`) can outweigh one exact tag of
difference: one exact tag plus an exact title (`E + T = 10.5`) beats two
exact tags alone (`2E = 10`).

**A partial tag match is real evidence, but a confident image match beats a
lone one.** `art` partially matching `art nouveau` counts for something, but
a room CLIP is reasonably certain about should still win.
*Enforcement:* the partial-tag term is capped at `P` however many terms match
partially: summed fractions are divided by `TAG_PARTIAL_SATURATION` and
clamped to 1, so a long query cannot inflate it. A reasonably certain CLIP
match (`clipStrengthGate >= 0.5`, see "Image-content (CLIP) matching") on
the room CLIP ranks first (`clipNorm = 1`) contributes at least
`C * 0.5 = 0.5`, which clears `P`.

**More partial tag matches beat fewer, for the same number of exact
matches.**
*Enforcement:* `tagPartialSum` is a sum over the partially matching terms,
not an average. A sum only grows as matches are added; an average can fall
when a weaker match joins a stronger one, ranking a room with more evidence
lower. The sum stops helping once it reaches `TAG_PARTIAL_SATURATION`.

**A multi-word tag typed plainly is an exact match, without quotes.** A room
tagged `outsider art` is found exactly by the query `outsider art`, not only
by `"outsider art"`. A keyword chip searches its text unquoted, and
multi-word keywords are common, so without this the commonest search a reader
makes could not reach the tag it names.
*Enforcement:* for a query of more than one eligible term, `tagTermsOf`
builds a whole-query term, and `rankHybrid` classifies it against each room's
keywords beside the per-term pass. The better reading wins:
- An exact whole-query match counts as one exact match, never more, so
  `brutalism mezzotint` hitting two separate keywords (`2E`) still outranks
  a room tagged with the whole phrase (`E`).
- A partial whole-query match is used only when no term matched the room's
  keywords at all.

**A quoted phrase is one match, not one match per word it contains.**
Searching `"art nouveau"` credits at most one exact or one partial match for
the whole phrase.
*Enforcement:* a quoted phrase is one entry in the parsed query's `terms` and
is classified once, testing the whole phrase as the equality/substring
candidate. See "Quoted phrases".

### Title matching

A room's optional `title` (`packages/map/metadata.ts`) is matched the way a
keyword is: exact or partial, term by term, by the same substring rule. A
room has one title, not a list, so where the tag rules sum or count across
keywords, the title rules take the best reading across the query's terms.
An exact title match is weighted slightly above an exact tag match: naming a
room by its title is the most specific thing a query can do.

**A term matches a title exactly or partially, by the same rule a term
matches a keyword.** Searching `"the unsurveyed room"` matches a room titled
`The Unsurveyed Room` exactly; `unsurveyed` matches it partially.
*Enforcement:* every term the tag rules classify, and the whole-query term,
is tested against the title with `classifyTagTerm`, called with the title as
a one-element keyword list. A quoted phrase is one match against the title,
as it is against keywords.

**Several terms hitting the same title are one piece of evidence read twice,
not new evidence.** Two different keywords partially matched is stronger
proof than one, which is why `tagPartialSum` sums. Two query terms landing
inside the same title string describe the same evidence.
*Enforcement:* `titlePartial` is the maximum substring fraction over every
term, not a sum. `titleExact` is 0 or 1 (did any term equal the title), not
a count.

**An exact title match outranks any non-exact evidence, and a single exact
tag match too - but not two exact tag matches.**
*Enforcement:* `T > P + Pt + S + L + C`, the same guarantee `E` makes, and
`E < T < 2E`. The margin over `E` is small (`T - E = 0.5`): it decides
between an exact-title room and an exact-tag room whose other evidence is
comparable. If the tag room's non-exact evidence exceeds the title room's by
more than `0.5`, the tag room wins.

**A partial title match is real evidence, weaker than a partial tag match.**
A tag is a purpose-chosen style keyword. A title does several jobs (display
name, catalog sort key, spine label), so a substring landing inside it is
less specific evidence.
*Enforcement:* `Pt < P`, and `L > C + P + Pt` keeps the long-story guarantee
intact with the title term included.

### Story matching

A story is indexed as its ordered sequence of lemmas, with each word's span
in the folded text. Two story readings feed ranking:

- `storyRatio`: the matched share of the query, in `[0, 1]`. Each query token
  counts by its length (`cartographer` outweighs `oil`), and the ratio
  divides by the query, not the story, so a hit in a long story is worth the
  same as in a short one.
- `storyLongChars`: the character span, in the folded story, of the longest
  contiguous run of story words whose lemma is one of the query's
  (`longestMatchRun`). "Contiguous" is in the indexed sequence, so a stopword
  or short word between two matches does not break a run. The query's word
  order does not matter.

**A short, exact story match is real evidence, and beats a weak image match -
but a confident one can still win.** Searching `cat` and finding it in a
room's story should usually outrank CLIP.
*Enforcement:* a query whose every token is in the story reaches
`storyRatio = 1` and contributes the full `S`. CLIP's term,
`C * clipNorm * clipStrengthGate`, beats it only when it exceeds `S` (`0.4`
with the defaults). A reasonably certain CLIP match on CLIP's top room
contributes at least `0.5`, so it always does.

**A long story match outranks every CLIP match and every partial tag and
title match, at once.** "Long" means contiguous: `cat dog bird fish` hitting
four unrelated sentences is not a long match; `a room walled in glass` found
as one run is.
*Enforcement:* `storyLongChars` feeds a saturating bonus,
`storyLongBonus = clamp01((storyLongChars - low) / (high - low))` over
`STORY_LONG_RANGE`. Below `low` (16 characters, roughly one or two words) it
is zero; at `high` (40, roughly a full clause) it saturates at `L`, and
`L > C + P + Pt`, so it beats a room that is CLIP's fully confident top pick
and has maxed-out partial tag and title matches.

### Image-content (CLIP) matching

CLIP's absolute reading is the strength curve `clipCurveStrength`: `0` at and
below the anchor `centre`, rising linearly to `1` at `high`. In ranking this
value is `clipStrengthGate`; in strength it is `C`. **"Reasonably certain"**,
used throughout these rules, means `clipStrengthGate >= 0.5`.

**A query CLIP has no real opinion about cannot look confident just because
it produced some top result.** Min-max normalisation always gives the top
room `clipNorm = 1`, and that must not read as a strong match for `cghjj`.
*Enforcement:* CLIP's ranking term is `C * clipNorm * clipStrengthGate`, the
relative position times the absolute reading. A query with no real signal
has every raw cosine near or below `centre`, so `clipStrengthGate` is near
zero and the term contributes almost nothing, whatever `clipNorm` says.

**The anchors are measured against a corpus's cosine distributions, not
guessed.**
*Enforcement:* `CLIP_STRENGTH` holds the defaults (`centre` 0.205, `high`
0.279); config can override them as `search.density.clipCentre`
and `clipHigh`. `tools/embed/cosine-range.ts` measures them:
- `centre` is the median of the whole keyword x room distribution, the band
  a query with no real signal lands in. A keysmash probe lands on it.
- `high` is the median ceiling across keywords true of nearly every room
  (`bookshelf`, `book`, `library`, ...), a genuine match's typical
  confidence.
- A third probe, strong concepts that share nothing with a library wall
  (`race car`, `swimming pool`, ...), lands below `centre`. The curve does
  not read it; it shows `centre` is a conservative zero, so a room at
  `centre` is noise rather than a weak match.

`CLIP_STRENGTH`'s docblock carries the measurement details, and
`cosine-stats.ts`'s header says what each distribution answers.

**A cosine below `centre` is absence of evidence, not evidence of a
mismatch.** CLIP's joint space has no meaningful antipode: a text vector
pointing away from an image vector is an unrelated concept, not a claim that
the image is the query's opposite.
*Enforcement:* the curve clamps everything below `centre` to `0`.

## Quoted phrases

A quoted phrase is one term (see "The parsed query"). What quoting changes:

- **Tags and titles: a quoted phrase is tested whole.** `"art nouveau"` is
  exact if some keyword equals the whole phrase, partial if some keyword
  contains it as a substring, and is not also split into `art` and `nouveau`
  for separate credit. A room tagged `art` and `nouveau` as two separate
  keywords gets no tag credit from the quoted phrase. This is phrase search's
  usual precision-over-recall tradeoff. Quoting a single word (`"art"`)
  changes nothing, since both cases go through `classifyTagTerm` with the
  same folded text.
- **The floor: a quoted phrase is always eligible** for tag and title
  matching, whatever its length or stopwords.
- **The story: quoting adds an ordered run and restricts nothing.** The
  phrase's words still count toward `storyRatio` and `longestMatchRun`
  wherever they appear, as unquoted words do. `storyPhraseRun` also
  measures the phrase's words appearing consecutively in the phrase's order,
  and `storyLongChars` takes the longer of the two runs. With the default
  `minTokenLength`, that ordered run is never longer than the unordered one,
  so quoting does not change a story score. Open issue
  [#327](https://github.com/centuryglass/babel-index/issues/327) tracks
  deciding what a quote should do here.

## Computing strength

Strength is built from the same evaluation ranking uses, but from each
signal's absolute reading, never the query-normalised one.

**Strength is a soft-OR of four absolute readings.** Any one signal can
carry it alone (an exact tag is a full-strength match whatever CLIP thinks of
the picture), and two weak agreeing signals count for more than either alone.
*Enforcement:* `matchStrength` computes
`strength = 1 - (1 - K)(1 - Kt)(1 - S)(1 - C)` from four inputs in
`[0, 1]`. Strength's `S` and `C` are not the ranking weights of the same
letter.
- `K` (tags): the room's best reading over the query's terms and the
  whole-query term - `1` for an exact keyword match, the substring fraction
  for a partial one, `0` otherwise. A maximum, not a mean: adding unrelated
  words to a query must not weaken a room that has not changed. How much of
  the query a room explains is decided by ranking's `tagExact` count.
- `Kt` (title): the same best reading against the room's one title. A room
  with no title has `Kt = 0`.
- `S` (story): from absolute matched length, not the query-relative
  `storyRatio`. When any story word matched,
  `S = STORY_FLOOR + (1 - STORY_FLOOR) * storyLongBonus01`, where
  `storyLongBonus01` is the same `STORY_LONG_RANGE` curve the ranking bonus
  reads. A single matched word sits at `STORY_FLOOR`; a full matched clause
  reaches `1`. Using `storyRatio` would make any one-word query that matches
  read as a 100% match.
- `C` (CLIP): `clipCurveStrength` of the raw cosine (see "Image-content
  (CLIP) matching").

A missing signal reads `0` and drops out of the product. With no embedding
blob, strength is text-only; with no metadata, it is CLIP-only. A room no
signal found evidence for reads `0` either way, and the map places it at the
baseline.

**Strength need not be monotone with rank; the map makes it so.** Ranks sort
on `score`, not on strength, so a later rank can have a higher strength than
an earlier one. `ordering.ts`'s `densityRamp` takes the running minimum down
the ranks and snaps anything under `search.density.floor` (default
`STRENGTH_FLOOR`) to the baseline, so density still falls monotonically
outward. The cost is that a room's reported strength and the strength it is
placed by can disagree (open issue
[#226](https://github.com/centuryglass/babel-index/issues/226)).

## Reporting

`explainRanking` builds everything a room's score display shows, from the
same `breakdown` the sort used. It returns `null` for a room nothing matched
on any axis and with no CLIP reading.

**The composite line shows the overall rank and the strength, and explains
itself on demand.** It reads "#4 of 2048, 73.00% match strength". Its tooltip
breaks the score into each axis's share.
*Enforcement:* the percentage is `strengthPercent(strength)`. Each share
(`contributions`) is that axis's weighted term divided by `score`, rounded to
a whole percent and sorted greatest first. An axis that contributed nothing
is omitted rather than shown as `0%`, so a room no text touched shows only
the image share.

**CLIP's row reports the strength curve as a percentage.** It reads
"#2 by image: 41.00% match": `0` at or below `centre`, `100%` at `high`. The
raw cosine is in the row's tooltip.
*Enforcement:* the percentage is `strengthPercent(clipStrengthGate)`.

**Every reported percentage stays in `0%`-`100%`.** The CLIP row and the
composite line are both clamped to that range by `strengthPercent`.

**Tags, titles, and story report what matched, not percentages.** A tag
match is exact, partial, or absent; a title match is the same, once per room;
a story match is a run of characters. None has a meaningful "73% sure"
reading.
*Enforcement:* the tag row shows the exact count (`tagExact`) and the partial
count (`tagPartialCount`); the title row shows "exact" or "partial"; the story
row shows `storyLongChars` as its length. None reads the CLIP curve.

**Every room can be read on each axis independently, including how it ranks
on that axis alone.** A reader can see "#4 by tag, tied with 2" separately
from the room's overall position.
*Enforcement:* `rankHybrid`'s `ranks`/`ties` come from four extra sorts of
the already-computed numbers, independent of the composite `order`:
- tag: `tagExact`, then `tagPartialSum`;
- title: `titleExact`, then `titlePartial`;
- story: `storyRatio`, then `storyLongChars`;
- clip: the raw cosine.

Ranks use competition ranking (`1, 2, 2, 4`), so "#4" always means three
rooms scored higher on that axis.

## Data structures

The types live in `packages/map/searchResult.ts`.

### The parsed query

A query is parsed (`parseQuery`) into an ordered list of terms. Everywhere
this document says "term", read "one word, or one quoted phrase treated as a
single unit".

```
Term = {
  text: string,       // as typed: one word, or the contents of one "quoted phrase"
  folded: string,     // fold(text)
  quoted: boolean,    // was this a "quoted phrase" in the original query?
  words: string[],    // [folded] for an unquoted term; the phrase's words for a quoted one
}

ParsedQuery = {
  raw: string,        // the query as typed
  folded: string,     // fold(raw) - the whole-query term's text
  terms: Term[],
}
```

Quotes are found before folding: each `"..."` span becomes one term with
`quoted: true`, and everything outside quotes is split on whitespace into
one term per word. (`tokenise()`, which the story reading uses, splits on any
non-letter, non-digit character instead.) An unterminated quote is an
ordinary character. `parseQuery` applies no stopword or length floor;
`tagTermsOf` applies it to unquoted terms, and `tokenise()` to story tokens.

### The per-room index

`buildSearchIndex` builds one entry per room when metadata arrives, `null`
for a room with no metadata:

```
SearchIndexEntry = {
  keywords: string[],         // folded, one entry per tag, not tokenised further
  title: string | null,       // folded title - one string, since a room has at most one
  story: {
    sequence: { lemma, start, end }[],  // lemmatised story words in order, with
                                        // their spans in the folded story
    set: Set<string>,                   // the same lemmas, for storyRatio's lookups
  },
}
```

A keyword is stored whole, so a quoted phrase is tested against it as a
substring the same way a word is.

### One room's evaluation against one query

`rankHybrid` computes one row per room in the same pass. Ranking, strength
and every reported number read this row; nothing downstream recomputes any
of it.

```
tagExact          // count of terms exactly equal to a keyword
tagPartialSum     // sum of best substring fractions over partially matching terms
tagPartialCount   // how many terms that sum is over
titleExact        // 0 or 1
titlePartial      // max substring fraction against the title
storyRatio        // matched share of the query, in [0, 1] - a ranking input
storyLongChars    // longest contiguous matched run, in characters
cosine            // raw CLIP cosine, or null without embeddings
clipNorm          // cosine min-maxed across the corpus for this query
clipStrengthGate  // clipCurveStrength(cosine), in [0, 1]
score             // the weighted sum ranking sorts by
strength          // the soft-OR the density gradient and the UI read
```

### The corpus-wide result

```
RankHybridResult = {
  order: number[],          // room ids, best score first
  strength: Float32Array,   // by rank, parallel to order
  breakdown: ScoreBreakdown,// by rank: one array per row field above
  ranks: SignalRanks,       // by rank: { tag, title, story, clip } per-axis rank
  ties: SignalRanks,        // by rank: how many other rooms share that axis rank
  signals: { clip, keyword, title, story },  // which signals found anything
}
```

`breakdown` renames three row fields: `storyRatio` is `story`, `clipNorm` is
`clip`, and a missing `cosine` is `NaN`. `ranks`/`ties` are computed apart
from `order`, so re-sorting for a display column never touches placement.
`useSearch.ts` stores the result as `SearchResult`, which adds the searched
`term`, and whose arrays are all `null` for a corpus with neither embeddings
nor metadata to rank with.
