# Search: critique and recommendations

A review of the search system as it stands (`packages/map/scoring.ts`,
`packages/map/ordering.ts`, `packages/map/favorites.ts`,
`docs/search_rules.md`), written to answer one question: the search works,
so why is it so hard to hold in your head?

This is analysis, not a change. Nothing here has been implemented. The
findings each carry a reproduction; the recommendations are ordered by what
they buy against what they cost, and several of them are decisions to make
rather than fixes to apply. `docs/pending_task_list.md` carries the entries
that came out of it.

Every number below was measured against `assets/corpus-sample/`
(26 rooms, text signals only - the CLIP text tower is an optional install
and was not present).

## What works, and should survive any rewrite

The parts worth protecting, so a rewrite does not trade them away:

- **One weighted sum rather than tiered buckets.** The reasoning in
  `scoring.ts`'s "One sort, not tiers" is correct and the failure it avoids
  is real. A tiered sort splices a few results onto the front of an
  unchanged order; the map needs the whole library to rearrange.
- **Calibrating CLIP against a measured distribution.** `CLIP_CERTAINTY`'s
  three anchors, and the finding that `low` sits *below* `centre`, are the
  most valuable engineering in the subsystem. A hand-set floor would have
  been wrong in a way nobody would have noticed.
- **Lemmas rather than stems for story matching.** `animation`/`animal` is a
  real false positive and the code avoids it deliberately.
- **`foldWithMap`.** Folded offsets are not source offsets, and the
  highlighter is correct because someone noticed.
- **The density gradient as a single formula.** `contentRatio + (peak -
  contentRatio) * certainty` walking outward is a genuinely elegant way to
  turn a per-rank profile into a picture, and it is not the source of the
  confusion.

The convolution is not in any of these. It is in what feeds them.

## The central problem: one number doing three jobs

`matchCertainty` returns one signed value that is then asked to be:

1. **A per-room display number** - "73.00% match certainty" on every card.
2. **A per-rank density profile** - how tightly the map packs this room in.
3. **A match/no-match gate** - `CERTAINTY_FLOOR` decides whether a room
   clusters at all.

These are three different questions, and the third is not even a per-room
question. "How sure are we?" is naturally a property of *the search*, not of
room #17. The visual effect the piece is after - a striking cluster for a
distinct query, a scattered map for a vague one - is driven by whether a
cluster forms at all, which is one number per query, not one per room.

Because the per-query question was answered with a per-room number, its
shape got bent to fit. That bending is the source of most of the
complexity:

- **Coverage-scaling.** `K` is the *mean* over query terms so that a query
  only partly covered by tags reads as less than fully certain. That is
  a per-query recall idea implemented inside a per-room strength number,
  and it produces Finding 2 below.
- **The running minimum in `densityRamp`.** Certainty is not monotone with
  rank because rooms sort on `score` and cluster on `certainty`, which are
  different computations. The running minimum is a repair applied after the
  fact, and it produces Finding 3.
- **The signed range.** The negative half exists so a query can say "not
  this", but only CLIP ever reaches it (see Finding 5), so the sign is
  carried through every type, every array and every display path to serve
  one signal.

Naming the number "certainty" was not the mistake by itself. Asking one
number to be both an absolute per-room reading and a per-query confidence
estimate is what made it unexplainable - and it is why the documentation
written to clarify it could not.

## Findings

### 1. A multi-word tag typed verbatim is not an exact match

`assets/corpus-sample/001.webp` is tagged `outsider art`. Typing that query
as a reader would:

```
query "outsider art"     -> score 0.206, strength 0.458, tagExact 0   (partial)
query "\"outsider art\"" -> score 5.000, strength 1.000, tagExact 1   (exact)
```

Same words, 24x the score, and the difference is a pair of quotes the
interface never suggests. `rankHybrid` classifies term by term
(`classifyTagTerm` per entry of `parsed.terms`), so an unquoted multi-word
query is only ever tested as its separate words.

This is not a corner case. **34 of the 78 keywords in the sample corpus
(43.6%) are multi-word**, and `searchKeyword` (`main.tsx`) runs a chip's
text raw:

```js
const searchKeyword = (text: string) => { ...; search(text); };
```

So clicking the `outsider art` chip *on room 001* runs a search that does
not exactly match room 001's own tag, and the card then reports 45.80%
certainty against a tag the reader is looking at. Roughly two chip clicks in
five land here.

### 2. `keywordScore` fixes Finding 1, is fully tested, and is never called

`keywordScore` implements exactly the missing reading - "two readings, and
the better one wins", the whole query against the whole keyword alongside
the per-token mean. Its docstring says so:

> the whole query against the whole keyword, which is what makes an exact
> match score exactly 1 even when the keyword is two words long

`scoring.test.ts`'s "an exact keyword match scores 1, including a multi-word
keyword" asserts it:

```js
assert.equal(keywordScore('art nouveau', ['art', 'nouveau'], ['art nouveau', 'oak']), 1);
```

That test passes. It also guards nothing: `rankHybrid` does not call
`keywordScore`, and no other caller exists in `packages/` or `tools/`. Six
tests currently verify a function that has no effect on any search.

Two comments point at it as though it were live, and are false as written:

- `classifyTagTerm`'s doc comment - "This is `keywordScore`'s substring rule,
  read per term rather than blended across the whole query". The blended
  reading is not reached at all.
- `ParsedQuery.folded` (`searchResult.ts`) is documented as "used for
  `keywordScore`'s whole-query-against-one-keyword reading". `parseQuery`
  computes the field; nothing in the ranking path reads it.

This is the clearest single example of why the system reads as tangled: the
behavior described by the docs, the comments and the tests is the behavior
the code had before term parsing landed, and three layers of description
kept describing it afterwards.

### 3. A room's printed certainty and its placement disagree

Ranking sorts on `score`; the gradient reads `certainty`; they are different
computations, so certainty arrives non-monotone and `densityRamp` takes a
running minimum over it. The repair is silent, and the two numbers are both
shown to the reader - one as text, one as position.

```
query "verdigris green smear across the walls"
#1 007.webp  score 5.000  certainty 0.200   (exact tag `verdigris`)
#2 001.webp  score 1.280  certainty 0.750   (a 28-char contiguous story clause)
```

The top result of the search reports **20.00% match certainty**. The second
result reports 75.00% on its card, and is then placed by the map as though
it were 0.200, because the running minimum caps it to rank #1's value. The
card and the map give the reader two different answers about the same room,
and neither says which to believe.

### 4. Certainty falls as the query grows, for a room that has not changed

`tagCoverage` is the mean over all query terms. Room 007 is tagged
`verdigris`, and its reported certainty for a query containing that tag
depends on how many other words are in the query:

| query | terms scored | room 007 certainty |
| --- | --- | --- |
| `verdigris` | 1 | 1.000 |
| `verdigris green smear across the walls` | 5 | 0.200 |

Room 007 matched a tag exactly in both cases. Adding words the reader did
not expect to match cost it 80 points of confidence. This is coverage
("how much of the query is explained") wearing the label of strength ("how
good is this match"), and it is the precise gap between the word "certainty"
and what was actually wanted.

### 5. The negative half is CLIP-only, and the wording overclaims

`matchCertainty` returns `-Cneg` only when `K`, `Kt`, `S` and `Cpos` are all
zero. Nothing but CLIP can produce a negative value. Two consequences:

- A corpus with no `embeddings.bin` has no negative range at all. Every room
  reads as 0 - "no opinion" - including rooms the text search is completely
  sure did not match.
- `RoomDetails`'s `signedCertaintyText` renders the negative case as
  "73.00% certain this does not match". "This" reads as the room; the claim
  is only ever about the picture.

### 6. A favorite sort and a search make competing claims on one axis

`favoriteSort` composes them as
`Math.max(searchCertainty, favorited ? 1 : 0)`. On the map, distance from the
center is the only channel either one has, so after a search with `mine`
active:

- Every favorited room is placed at certainty 1, including rooms the search
  scored 0. A favorited non-match and a perfect match are placed identically.
- The axis now means two things at once - "matches your query" and "you
  favorited this" - with nothing visually separating them. The striking
  cluster the piece is built around is diluted by rooms the search rejected.

The module comment calls this "enriches the search's own cluster". What it
does is inject rooms the search said do not match, at maximum confidence,
into the middle of the cluster of rooms that do.

Two smaller edges in the same area:

- `changeSort`'s comment (`main.tsx`) stated "Only a search may rebuild the
  layout, because only a search has a certainty profile to place by."
  `favoriteSort` returns a profile for `'mine'` and `'count'`, `layout`
  consumes it, and `AGENTS.md` documents that it rebuilds. (Fixed in this
  pass - see "Changes made".)
- `effectiveSortMode` silently reads `'random'` as `'relevance'` whenever a
  search is active. The center tile's switch is the whole state display, so
  the reader sees a lit switch that is doing nothing.

### 7. The weights are config, and the guarantees are not checked at runtime

`docs/search_rules.md` states every cross-signal guarantee as an inequality
over the seven weights (`E > tagPartial + story + storyLong + clip`, and so
on), and `scoring.test.ts` asserts them - **against `DEFAULTS`**.
`config.ts` validates each weight with `nonNegative` and nothing else, so a
`config.json` setting `search.weights.tagExact: 0.1` loads cleanly, prints
no note, and falsifies every "always outranks" assertion in the
specification.

Either the inequalities are load-bearing, in which case `config.ts` should
check them and push a note like every other suspicious value it sees, or
they are not, in which case the document should stop stating them as
guarantees.

### 8. `docs/search_rules.md` is a test specification, not an explanation

542 lines, organised as assertion-plus-enforcement. That shape is right for
verifying an implementation and wrong for understanding one: every fact
arrives as a defence of a decision against an alternative, so a reader
looking for "what happens when I type two words" has to read the
justification for seven constants first. Three specific problems:

- **It duplicates `scoring.test.ts`.** The assertions and the tests are the
  same content in two places, with no mechanism keeping them in step - and
  Finding 2 is what that drift looks like when it happens.
- **It restates facts that have a home.** The cosine-anchor derivation is
  written out at length here and also lives on `CLIP_CERTAINTY` and in
  `tools/embed/cosine-range.ts`, against `AGENTS.md`'s own "one fact, one
  home".
- **It documents the ranking path that exists and the certainty model that
  was wanted**, in the same voice, so the reader cannot tell which parts are
  describing the code and which are describing the intent. The "Overview"
  section's framing of ranking-versus-certainty is the clearest statement of
  the design anywhere in the repo, and it is on page one of a document
  nobody finishes.

## Recommendations

Ordered so each is useful alone, and so the early ones do not depend on
agreeing with the later ones.

### R1. Quote multi-word chip searches (one line, fixes Finding 1's worst half)

Have `searchKeyword` wrap a multi-word keyword in quotes before searching.
A chip is a claim that the reader wants *this tag*, and quoting is how the
parser already spells that. This makes two chip clicks in five stop
under-reporting, and needs no scoring change.

The typed-query half of Finding 1 is R3's to fix.

### R2. Rename `certainty` to `strength`, and take the max over terms

The word was wrong, and the formula was bent to fit the wrong word. Change
both together:

- `tagCoverage`/`titleCoverage` become the **maximum** per-term match
  quality rather than the mean. A room whose tag you typed reads 1.00
  whatever else is in the query, which is what Finding 4 asks for.
- The count of matching terms stays a *ranking* input (`tagExact` is already
  a count, and `n * E` already ranks more matches higher), so nothing is
  lost - coverage keeps deciding order, and stops deciding strength.
- The card's line becomes "match strength", and the name stops promising an
  epistemic reading the number never had.

### R3. Restore the whole-query reading, then delete or adopt `keywordScore`

In `rankHybrid`, test the whole folded query as a synthetic single term
against keywords and title alongside the per-term pass, and keep the better
reading. That is `keywordScore`'s own doctrine, moved into the live path,
and it fixes typed multi-word queries without touching quoting.

Whichever way this goes, `keywordScore`, `ParsedQuery.folded` and the two
comments in Finding 2 resolve to one state instead of three: either the
function becomes the implementation of the whole-query reading, or it and
its six tests are deleted. Both are better than a tested ghost.

### R4. Make CLIP absolute, and rank on strength

This is the structural simplification, and it removes the ranking-versus-
certainty duality the documentation spends its length on.

`signedClipCertainty` already solves the problem `clipNorm` was introduced
for. The narrow cosine band is exactly what the three measured anchors map
onto `[-1, 1]`; min-maxing the same cosine across the corpus is a second
normalisation of a number that has already been normalised, and it is the
only reason ranking has to be relative at all. So:

- Drop `clipNorm` from the weighted sum and weight `clipCertaintyGate`
  directly. CLIP becomes an absolute signal like the other three.
- With every signal absolute, **rank on strength**. `score` and `strength`
  become one computation, the map's "closer to the center is a better match"
  reading becomes literally true, and `densityRamp`'s running minimum can be
  deleted rather than explained - monotonicity holds by construction.
- Finding 3 disappears: there is no second number to disagree with the
  first.

The cost, stated plainly: `clipCertaintyGate` saturates at `band.high`, so
rooms above that cosine currently tie where `clipNorm` separated them.
Since `high` is a *median* ceiling, real matches do exceed it. Keep
`clipNorm` as an explicit tiebreak within equal gate values rather than as a
co-equal factor - that preserves the discrimination and still collapses the
duality, because a tiebreak cannot reorder rooms of different strength.

This is the recommendation to prototype before committing to. It is also
the one that would let `search_rules.md` lose half its length.

### R5. Give the per-query question its own number

Once strength is per-room and honest, the effect the piece wants is one
multiplication away. Derive a per-query `confidence` in `[0, 1]` from the
strength distribution - how far the top strengths stand above the corpus's
typical strength for that query - and scale the gradient by it:

```
threshold(rank) = contentRatio + (peak - contentRatio) * confidence * strength[rank]
```

A distinct query has high confidence and a sharp cluster. A vague one has
low confidence and a shallow gradient everywhere, which is the "showing the
lack of a strong pattern" behavior, now produced deliberately rather than as
a side effect of every room scoring low. `CERTAINTY_FLOOR` becomes a
property of `confidence` - one test per query instead of one per room - and
"no match" and "no search" stay the same picture for a stated reason.

This also gives the UI something true to say that it cannot currently say:
"this search found nothing" is a per-query fact, and there is no variable
holding it today.

### R6. Take favorites off the density axis

Recommendation: `favoriteSort` collapses back into `favoriteOrder`, and a
favorite sort stops producing a certainty profile.

Distance from the center means match strength, and nothing else. A favorite
sort still reorders - favorites arrive first, in whatever order the search
put them in - but it no longer claims they are matches. Favorites already
have their own visual channel on the map: the badge. `SearchCertainty`,
`FavoriteSortResult` and the composition logic all go away, "a re-sort is a
re-rank, never a rebuild" becomes true as `main.tsx` already claims, and the
question of what a favorite sort means during a search stops needing an
answer because the two no longer share a channel.

If favorites must stay a placement input, then the alternative is to give
them a *separate* channel - a ring, a tint, a distinct badge state - rather
than borrowing the one that already means something else.

Separately: make the `'random'` switch visibly unavailable during a search
rather than lit and inert.

### R7. Check the weight inequalities where the weights are loaded

Move the inequality checks out of `scoring.test.ts`'s assertions against
`DEFAULTS` and into `config.ts`, as a note pushed onto `notes` when a loaded
config breaks one. This is what `config.ts` already does for every other
value whose failure mode is silence, and it is the difference between the
specification being a guarantee and being a comment about the defaults.

### R8. Split the documentation by audience

Three documents out of one, each with a single job:

- **`docs/search.md`, short.** What a reader experiences: the four signals,
  what the map is showing them, what quoting does, what the numbers on a
  card mean. Sixty lines. This is the file that does not exist today, and
  the gap this critique was asked about.
- **The assertions move into `scoring.test.ts`** as test names and comments.
  They are a test specification; the tests are where a specification stops
  being able to drift, and Finding 2 is what drift costs.
- **`search_rules.md` keeps the constants and their inequalities** as a
  table, and points at `CLIP_CERTAINTY` and `tools/embed/cosine-range.ts`
  for the measurement narrative rather than restating it.

If R4 lands, the "Overview" section's ranking-versus-certainty framing is
deleted rather than rewritten - the distinction it explains stops existing.

## Sequencing

R1 and R7 are independent and small. R2 and R3 together fix the findings a
reader actually hits, without restructuring anything. R4 is the one that
makes the system explainable, and R5 follows from it. R6 is a product
decision the code cannot make. R8 is worth doing last, when there is a
settled design to describe - documenting the current one again would repeat
the mistake this file is about.

## Changes made in this pass

One stale comment, per `AGENTS.md`'s rule that a trivial bug found during
other work gets fixed rather than filed: `main.tsx`'s claim that only a
search rebuilds the layout, corrected to match `favoriteSort` and
`AGENTS.md`. Everything else here is recorded in
`docs/pending_task_list.md` and left for a decision.
