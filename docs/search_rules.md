# Search rules

The specification of what a search does: how a query is parsed, how each room
is evaluated against it, and how that evaluation becomes a map position, a
map density and the numbers a reader sees. It describes the code as built
(`packages/map/scoring.ts`, `packages/map/ordering.ts`,
`packages/config/config.ts`). A change to a weight, a matching rule or a
strength anchor updates this file in the same commit.

What search has to accomplish for a reader is stated separately, in
[`search_requirements.md`](search_requirements.md).

## Overview: one number

A search asks every room four questions - does the query match your tags,
your title, your story, your picture - in one pass over the collection. Each
answer becomes a **pull** in `[0, 1]`: how strongly that kind of evidence
draws the room toward the center. The four pulls combine into one number per
room, its **strength** (`strength`), also in `[0, 1]`, `0` for no evidence.

Strength does both jobs the map needs:

- **Placement.** `rankHybrid` sorts the whole collection by strength, so the
  strongest matches are placed nearest the center.
- **Density.** `ordering.ts` reads the same number to decide how densely
  matching rooms pack among the generic ones at each distance.

Because one number does both, a room's reported strength and its place on
the map cannot disagree.

Strength is absolute. Every pull reads the room's own evidence against fixed
bounds, never against the rest of the collection, so a query the collection has no
answer to leaves every room near `0` and clusters nothing. CLIP reads its raw
cosine for this reason (see "Image-content (CLIP) matching").

Strength is evidence, never counter-evidence. No signal can find evidence
against a room, so nothing reports a mismatch.

### One sort, not tiers

The rules below read like bucket rules ("an exact tag match outranks a CLIP
match"), but the implementation is one combination of pulls. A tiered sort
would let one weak signal in a high tier beat a strong signal in a low one: a
room with one throwaway partial tag match would outrank a room CLIP is
confident about.

Each rule holds because the weights make it hold on the queries that test
it. `scoring.test.ts` asserts each ordering requirement on a query built for
it, tagged with its `search_requirements.md` id, so a re-tune that breaks a
rule fails a named test.

## Assertions

Each assertion is a statement of behavior, followed by how the implementation
makes it true.

### Signal weights

**The seven weights are `config.search.weights`, each in `[0, 1]`: how
strongly one piece of evidence pulls a room toward the center.**

| `search.weights` key | Default | A pull of |
| --- | --- | --- |
| `tagExact` | 1 | each term that exactly equals a keyword |
| `tagPartial` | 0.6 | `tagPartial` times the fraction of the keyword a term covers |
| `titleExact` | 1 | an exact title match |
| `titlePartial` | 0.6 | `titlePartial` times the best fraction of the title a term covers |
| `story` | 0.35 | each distinct query word found in the story |
| `storyLong` | 0.95 | `storyLong` times the story run curve (see "Story matching") |
| `clip` | 0.85 | `clip` times CLIP's curve (see "Image-content (CLIP) matching") |

`resolveConfig` rejects a weight outside `[0, 1]`: a pull past `1` has no
meaning to the soft OR that combines them. A `config.json` can still set
weights that break an ordering rule below, and nothing reports it (open issue
[#229](https://github.com/centuryglass/babel-index/issues/229)).

Two constants in `scoring.ts` are not config:

- `STORY_LONG_RANGE` (`{ low: 16, high: 40 }`): the character band the story
  run curve ramps across.
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
substring (`classifyTagTerm`). `art` covers 3/11 of `art nouveau`. The tag
pull is a soft OR over the query's terms, each exact term pulling at
`tagExact` and each partial one at `tagPartial` times its fraction.

**An exact tag match is a full-strength match.** Typing a room's tag
verbatim reads as 100%, whatever else the query or the picture says.
*Enforcement:* `tagExact` defaults to `1`, and a pull of `1` saturates the
soft OR.

**An exact tag match outranks every non-exact reading.** A room with one
exact tag match is placed ahead of a room with only partial tags, partial
titles, story matches or CLIP.
*Enforcement:* the exact room is at strength `1`, and a room with no exact
match cannot reach `1`: every other pull is below `1`, and a soft OR of pulls
below `1` stays below `1`.

**More exact tag matches beat fewer.** Searching `alien impasto` should place
a room tagged with both ahead of one tagged with only one.
*Enforcement:* both rooms are at strength `1`, so `comparePlacement` breaks
the tie on the count of exact term matches (`tagExact` plus `titleExact`).

**A partial tag match is real evidence, but a confident image match beats a
lone one.** `art` partially matching `art nouveau` counts for something, but
a room CLIP is confident about should still win.
*Enforcement:* a partial pulls at `tagPartial` times its fraction, so a lone
short partial sits well under `clip`.

**More partial tag matches beat fewer, for the same number of exact
matches.**
*Enforcement:* each partially matching term adds a pull to the soft OR, which
only rises as pulls are added.

**A multi-word tag typed plainly is an exact match, without quotes.** A room
tagged `outsider art` is found exactly by the query `outsider art`, not only
by `"outsider art"`. A keyword chip searches its text unquoted, and
multi-word keywords are common, so without this the commonest search a reader
makes could not reach the tag it names.
*Enforcement:* for a query of more than one eligible term, `tagTermsOf`
builds a whole-query term, and `rankHybrid` classifies it against each room's
keywords beside the per-term pass. The better reading wins:
- An exact whole-query match counts as one exact match, never more, so
  `brutalism mezzotint` hitting two separate keywords (two exact matches)
  still places ahead of a room tagged with the whole phrase (one).
- A partial whole-query match replaces the per-term pull only when it is
  larger.

A multi-word keyword inside a longer query (`golden hour` in `golden hour
jungle`) matches only partially: open issue
[#398](https://github.com/centuryglass/babel-index/issues/398).

**A quoted phrase is one match, not one match per word it contains.**
Searching `"art nouveau"` credits at most one exact or one partial match for
the whole phrase.
*Enforcement:* a quoted phrase is one entry in the parsed query's `terms` and
is classified once, testing the whole phrase as the equality/substring
candidate. See "Quoted phrases".

### Title matching

A room's optional `title` (`packages/map/metadata.ts`) is matched the way a
keyword is: exact or partial, term by term, by the same substring rule. A
room has one title, not a list, so where the tag rules combine readings
across terms, the title rules take the best one.

**A term matches a title exactly or partially, by the same rule a term
matches a keyword.** Searching `"the unsurveyed room"` matches a room titled
`The Unsurveyed Room` exactly; `unsurveyed` matches it partially.
*Enforcement:* every term the tag rules classify, and the whole-query term,
is tested against the title with `classifyTagTerm`, called with the title as
a one-element keyword list. A quoted phrase is one match against the title,
as it is against keywords.

**Several terms hitting the same title are one piece of evidence read twice,
not new evidence.** Two different keywords partially matched is stronger
proof than one, which is why the tag pull combines across terms. Two query
terms landing inside the same title string describe the same evidence.
*Enforcement:* `titlePartial` is the maximum substring fraction over every
term, not a combination. `titleExact` is 0 or 1 (did any term equal the
title), not a count. The title pull is `titleExact` for an exact match,
otherwise `titlePartial` times that fraction.

**An exact title match is as strong as an exact tag match.**
*Enforcement:* `titleExact` defaults to `1`, like `tagExact`, and an exact
title counts toward the exact-match tiebreak the same way one exact tag does.

### Story matching

A story is indexed as its ordered sequence of lemmas, with each word's span
in the folded text. Two story readings feed the story pull:

- `storyWords`: how many of the query's distinct words (by lemma) the story
  contains (`storyWordMatches`). A count, so a hit in a long story is worth
  the same as in a short one, and a query word the story lacks takes nothing
  away.
- `storyLongChars`: the character span, in the folded story, of the longest
  contiguous run of story words whose lemma is one of the query's
  (`longestMatchRun`). "Contiguous" is in the indexed sequence, so a stopword
  or short word between two matches does not break a run. The query's word
  order does not matter.

The story pull is the soft OR of `story` once per matched word and
`storyLong` times the run curve,
`clamp01((storyLongChars - low) / (high - low))` over `STORY_LONG_RANGE`.
Below `low` (16 characters, about one long word, which `story` already
credits) the curve is zero; at `high` (40, about a full clause) it is `1`.

**A short, exact story match is real evidence, and a confident image match
can outweigh it.** Searching `cat` and finding it once in a room's story
pulls at `story`; a CLIP reading past roughly `story / clip` of its curve
pulls harder.

**A long story match outranks CLIP at its most confident.** "Long" means
contiguous: `cat dog bird fish` hitting four unrelated sentences is not a
long match; `a room walled in glass and bathed in warm light` found as one
run is.
*Enforcement:* a saturated run pulls at `storyLong`, and `storyLong > clip`.

### Image-content (CLIP) matching

CLIP's reading is the curve `clipCurveStrength` of the raw cosine: `0` at
and below the anchor `centre`, rising linearly to `1` at `high`. CLIP's pull
is `clip` times the curve.

**A query CLIP has no real opinion about cannot look confident just because
some room scored highest.** The best cosine of a bad lot must not read as a
strong match for `cghjj`.
*Enforcement:* the curve reads the raw cosine against fixed anchors, never
the cosine's position among this query's results. A query with no real
signal has every raw cosine near or below `centre`, so its CLIP pulls are
near zero. How well fixed anchors hold across queries is open issue
[#397](https://github.com/centuryglass/babel-index/issues/397).

**The anchors are measured against a collection's cosine distributions, not
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
  phrase's words still count toward `storyWords` and `longestMatchRun`
  wherever they appear, as unquoted words do. `storyPhraseRun` also
  measures the phrase's words appearing consecutively in the phrase's order,
  and `storyLongChars` takes the longer of the two runs. With the default
  `minTokenLength`, that ordered run is never longer than the unordered one,
  so quoting does not change a story pull. Open issue
  [#327](https://github.com/centuryglass/babel-index/issues/327) tracks
  deciding what a quote should do here.

## Computing strength

**Strength is a soft OR of the four axes' pulls.** Any one axis can carry it
alone, and two weak agreeing axes count for more than either alone.
*Enforcement:* `matchStrength` computes
`strength = 1 - (1 - tag)(1 - title)(1 - story)(1 - clip)`, each pull in
`[0, 1]`. Within the tag and story axes, pulls combine across terms and
words by the same soft OR, so the whole calculation is one soft OR over every
piece of evidence, with titles taking the best reading.

**Adding words to a query never weakens a room that has not changed.** A
room that matched one term of a five-term query exactly is a full-strength
match for that term.
*Enforcement:* a word that matches nothing adds a pull of `0`, and a soft OR
is unchanged by a `0`.

A missing signal pulls `0` and drops out. With no embedding blob, strength
is text-only; with no metadata, it is CLIP-only. A room no signal found
evidence for reads `0` either way, and the map places it at the baseline.

**Placement order is strength, then two tiebreaks.** `comparePlacement`
sorts by strength; among equal strengths above `0`, by the count of exact
term matches, then by the raw cosine; rooms at `0` keep id order, so a query
nothing matched leaves the map as it was.

**Strength is non-increasing along the placement order.** `ordering.ts`'s
`densityRamp` reads it rank by rank.

**Density runs linearly between two strength anchors.** Anything at or under
`search.density.floor` (default `STRENGTH_FLOOR`) sits at the baseline, and
anything at or over `search.density.peakAt` (default `0.85`, CLIP's weight)
packs at `search.density.peak`.

## Reporting

`explainRanking` builds everything a room's score display shows, from the
same `breakdown` the sort used. It returns `null` for a room nothing matched
on any axis and with no CLIP reading.

**The composite line shows the room's place and its strength, and explains
itself on demand.** It reads "#4 of 2048, 73.00% match strength". Its tooltip
breaks the strength into each axis's share.
*Enforcement:* the percentage is `strengthPercent(strength)`. Each share
(`contributions`) is that axis's pull divided by the four pulls added
together, rounded to a whole percent and sorted greatest first. The soft OR
does not split into additive parts, so a share is of the pulls, not of
`strength`. An axis that pulled nothing is omitted rather than shown as
`0%`, so a room no text touched shows only the image share.

**CLIP's row reports its curve as a percentage.** It reads
"#2 by image: 41.00% match": `0` at or below `centre`, `100%` at `high`. The
raw cosine is in the row's tooltip.
*Enforcement:* the percentage is `strengthPercent(clipStrength)`, the curve
before `weights.clip` scales it.

**Every reported percentage stays in `0%`-`100%`.** The CLIP row and the
composite line are both clamped to that range by `strengthPercent`.

**Tags, titles, and story report what matched, not percentages.** A tag
match is exact, partial, or absent; a title match is the same, once per room;
a story match is a run of characters.
*Enforcement:* the tag row shows the exact count (`tagExact`) and the partial
count (`tagPartialCount`); the title row shows "exact" or "partial"; the story
row shows `storyLongChars` as its length. None reads the CLIP curve.

**Every room can be read on each axis independently, including how it ranks
on that axis alone.** A reader can see "#4 by tag, tied with 2" separately
from the room's overall position.
*Enforcement:* `rankHybrid`'s `ranks`/`ties` come from four extra sorts of
the already-computed numbers, independent of the placement `order`:
- tag: the tag pull, then `tagExact`;
- title: the title pull;
- story: the story pull, then `storyLongChars`;
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
    set: Set<string>,                   // the same lemmas, for storyWordMatches' lookups
  },
}
```

A keyword is stored whole, so a quoted phrase is tested against it as a
substring the same way a word is.

### One room's evaluation against one query

`rankHybrid` computes one row per room in the same pass. Placement, density
and every reported number read this row; nothing downstream recomputes any
of it.

```
tag, title, story, clip  // the four axes' pulls, each in [0, 1]
tagExact          // count of terms exactly equal to a keyword
tagPartialCount   // count of terms that matched a keyword only partially
titleExact        // 0 or 1
titlePartial      // max substring fraction against the title
storyWords        // distinct query words the story contains
storyLongChars    // longest contiguous matched run, in characters
cosine            // raw CLIP cosine, or null without embeddings
clipStrength      // clipCurveStrength(cosine), in [0, 1], before weights.clip
strength          // the soft OR of the four pulls
```

### The collection-wide result

```
RankHybridResult = {
  order: number[],          // room ids, strongest first
  strength: Float32Array,   // by rank, parallel to order, non-increasing
  breakdown: ScoreBreakdown,// by rank: one array per row field above except strength
  ranks: SignalRanks,       // by rank: { tag, title, story, clip } per-axis rank
  ties: SignalRanks,        // by rank: how many other rooms share that axis rank
  signals: { clip, keyword, title, story },  // which signals found anything
}
```

A missing `cosine` is `NaN` in `breakdown`. `ranks`/`ties` are computed apart
from `order`, so re-sorting for a display column never touches placement.
`useSearch.ts` stores the result as `SearchResult`, which adds the searched
`term`, and whose arrays are all `null` for a collection with neither embeddings
nor metadata to rank with.
