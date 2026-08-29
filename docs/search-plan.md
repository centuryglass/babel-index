# Search implementation plan

`docs/search_rules.md` is the target: how search behaves once it is finished. This
file is the gap between that target and the code today, and the steps to close
it. When a step lands, delete it — `search_rules.md` and the git log are the
record of where we ended up, this file only tracks where we still are.

Read `search_rules.md` first. Every "Ideal" below is a pointer into it, not a
restatement; the point here is the "Now" and the "Steps".

## 1. Certainty has no formula — landed

**Ideal** (`search_rules.md` "Computing certainty"): one absolute `[-1, 1]`
per room, a soft-OR of three absolute readings, story read by *absolute matched
length* and exact tags scaled by *query coverage*.

**Landed:** `matchCertainty` in `scoring.ts` takes `{tagCoverage, storyLongChars,
storyMatched, cosine}` and computes the signed `[-1, 1]` coverage-scaled soft-OR
the spec names — `tagCoverage` and `storyLongBonus01(storyLongChars)` (shared
with §2's `storyLong` ranking bonus) replace the old ratio-only reads, and the
CLIP term still comes from the linear `CLIP_CERTAINTY` band pending §5's
recalibration. The density gradient (`ordering.ts` `densityRamp`) is unchanged,
still forcing certainty non-increasing with rank and flooring it.

## 2. Weights are a different system from the spec's constants — landed

**Ideal** (`search_rules.md` "Balancing signals"): `E=5, P=0.45, C=1, S=0.4,
L=2`, chosen so every ranking inequality holds by construction.

**Landed:** `config.search.weights` is now the five-key shape
`{tagExact, tagPartial, story, storyLong, clip}` at the spec's defaults
(`config.ts`), and `rankHybrid` (`scoring.ts`) sums exactly those five terms —
`tagExact` count, `tagPartialSum` clamped through `TAG_PARTIAL_SATURATION`,
`story`/`storyLong` off the shared `storyLongBonus01` ramp, and `clip`. Tests in
`scoring.test.mjs` assert the spec's cross-signal inequalities directly against
the resolved weights.

## 3. Story matching is word-set, not word-sequence — landed

**Ideal** (`search_rules.md` story assertions + "Feature additions"): a *long
contiguous run* of matched query words is the thing that outranks everything,
and a quoted phrase matches the story as a contiguous run too.

**Landed:** `buildSearchIndex` now stores the story as `{sequence, set}` —
`sequence` is the lemmatised token *sequence* with `{lemma, start, end}` spans
into the folded story (still built once at load), `set` is the same lemmas for
`storyScore`'s O(1) ratio lookup (unchanged behaviour, just reading the new
shape). Two new pure functions in `scoring.ts` measure what `storyLongChars`
needs: `longestMatchRun(sequence, matchLemmas)` (unordered — the longest run of
*consecutive story tokens* whose lemma is in the query's lemma set) and
`storyPhraseRun(sequence, phraseLemmas)` (ordered — a quoted phrase's words
found consecutively, in order). Both are unit-tested in `scoring.test.mjs`
and, since §1/§2 landed, both are wired into `rankHybrid`:
`longestMatchRun`'s character length feeds `storyLongBonus01` for both the
`storyLong` ranking bonus and certainty's `S` term, and `storyPhraseRun` gives
a quoted term story credit against its lemmatised `words` from `parseQuery`.

## 4. Quoted-phrase parsing does not exist — landed

**Ideal** (`search_rules.md` "The parsed query"): a query is an ordered list of
terms, a quoted phrase being one term matched whole.

**Landed:** `parseQuery(raw)` in `scoring.ts` produces the `Term[]`/`ParsedQuery`
shape the spec defines (types in `searchResult.ts`) — quoted spans found first,
the remainder split on whitespace, `words` set per the spec (`[folded]` for an
unquoted term, `tokenise(phrase)` for a quoted one). `classifyTagTerm(term,
keywords)` gives the one-classification-per-term reading tag matching needs
(`{exact, partial}`), tested including the "phrase matches whole, not split"
and "quoting a bare word changes nothing" cases.

Since §1/§2 landed, both `parseQuery` and `classifyTagTerm` are called from
`rankHybrid` — the `tagExact`/`tagPartialSum` split is built per-term from
`classifyTagTerm`'s classification, replacing the old flat `foldedQuery`/
`queryTokens` reads.

## 5. CLIP certainty is mapped off theoretical extremes, not the distribution — landed

**Ideal** (`search_rules.md` "Image-content matching" + "Computing certainty"):
one continuous, distribution-anchored curve. The centre of the measured cosine
distribution is where CLIP has *no opinion*; above it, rising confidence the
image matches; below it, rising confidence it does *not*. Displayed as a signed
percentage, "N% certain the image content does not match" for the negative side.

**Landed:** `CLIP_CERTAINTY` (`scoring.ts`) is now the three-anchor
`{centre, high, low}` shape, and `signedClipCertainty` is a genuine monotone
signed curve — two linear segments meeting at `centre`, `0` there, `+1` at
`high`, `−1` at `low` — replacing the old two-point `clamp01` band that could
never go negative. `centre` (≈0.205) and `high` (≈0.279) are read straight off
the real measurement already committed (`cosine-range-report.json`, 2048 rooms
× 2149 keywords): `centre` is `overall`'s median (the noise band), `high` is
the median ceiling across near-universal keywords (`bookshelf`, `book`,
`library`, ...). `clipCertaintyGate` (the ranking term) is this curve's
positive half, computed by the caller (`rankHybrid`) rather than by
`signedClipCertainty` itself, so certainty's negative half (`Cneg` in
`matchCertainty`) can read the same call's negative half too — one
calibration, two readings, not two bands to drift. `explainScore` now returns
a `signedPercent` on the CLIP row (clamped `0.01%`–`99.99%`), and
`RoomDetails`/`index.html` render it as the spec's compact phrase, styled
distinctly (a different color, italic) when negative. `config.search.density`
carries the three anchors as `clipCentre`/`clipHigh`/`clipLow`, narrowing-only
validated as `clipHigh > clipCentre > clipLow`.

**`low` is now measured too — landed.** Ran `tools/embed/cosine-range.ts`
against the full corpus (2048 rooms x 2149 generation keywords) with
`--irrelevant` against ten known-irrelevant strong concepts (`race car`,
`swimming pool`, `sandy beach`, `city traffic jam`, `snow-capped mountain`,
`underwater coral reef`, `rock concert crowd`, `hot air balloon festival`,
`herd of cattle grazing`, `lightning storm over the ocean` — picked to share
no visual structure, repeating-grid or otherwise, with shelved library walls,
so a match would have to be genuine semantic confusion rather than a
compositional coincidence) and `--nonsense` with nine keysmash queries as a
validation-only check. `low` is `irrelevant.ceiling` (the median p50 across
those concepts' own best match, ≈0.171, the same `summarizeUniversal` math
`--universal` uses for `high`) — dropped into `CLIP_CERTAINTY.low`
(`packages/map/scoring.ts`), which `config.ts`'s `clipLow` default reads
straight off. `--nonsense` came back at mean 0.212 against `centre`'s 0.205
(drift 0.008, well inside noise), so `centre` needed no re-read.

The result inverted the placeholder's own prediction: the mirror-across-centre
guess assumed a real `low` would land low-*positive* (irrelevant-but-real
concepts read as weak evidence, not counter-evidence), but the measured
ceiling (0.171) sits *below* `centre` (0.205) — genuinely negative on the
signed curve. Read together with the nonsense probe agreeing with `centre`,
this looks like a real property of the embedding space rather than a
miscalibration: gibberish embeds near the corpus's mean direction (no signal
either way), while a coherent-but-wrong concept has its own specific direction
that is actively dissimilar to library imagery — so genuine off-topic content
reads as more confidently wrong than noise does, not merely as absent signal.

## 6. Per-signal ranks and ties are not computed — landed

**Ideal** (`search_rules.md` "Data structures" §4, reporting assertions): every
room readable on each axis alone — "#4 by tag, tied with 2 others".

**Landed:** `rankHybrid` (`scoring.ts`) now returns `ranks`/`ties`, each
`{tag, story, clip}`, parallel to `order` like `breakdown` - three more
independent sorts of the numbers already computed (`tagExact`/`tagPartialSum`
for tag, `storyRatio`/`storyLongChars` for story, raw `cosine` for clip), run
once via `rankAxis` before the composite sort reorders `scored`. No new
scoring. `rank` is 1-based competition ranking (`1, 2, 2, 4`, ties share the
better position) and `ties` is how many *other* rooms share it.
`RoomDetails.tsx`'s `ScoreBreakdown` surfaces this as the axis note the spec
names, attached to the first row of each axis group (`tagExact`/`tagPartial`
share the tag axis, `story`/`storyLong` share the story axis) so a tied pair
of rows never repeats the same note twice. `searchResult.ts`'s `SignalRanks`
type and `useSearch.ts`'s pass-through complete the plumbing; the no-signal
stub keeps `ranks`/`ties` `null` alongside `breakdown`.

## 7. Distribution-mapping experiment — after the core lands

The centre/extreme calibration in §5 assumes raw cosines. Two changes could make
the distribution far easier to map by de-clustering it at the source, and both
touch **only** the offline distribution mapping, never client/server code — so
they are safe to defer until §§1–6 are working:

- **Mean-image centring:** subtract the corpus mean image vector from each
  embedding before scoring. The cosines cluster at 0.205 because the image
  embeddings share a large "library-ness" component; removing it should spread
  real matches away from noise and may restore a genuine negative side.
- **Generic-tile baseline:** centre on the generic tiles instead — they are the
  diegetic "no distinct content" reference, so "more certain than the generics"
  reads as "found something more specific than wallpaper".

Decide between them (and against doing nothing) with an **objective** metric, not
by eye: run three probe sets through each mapping — universal keywords
(known-true), keysmash/nonsense (known-noise), and known-irrelevant strong
concepts (known-false) — and measure the separation between the known-true and
known-noise certainty distributions (a d′ / AUC between them). The mapping that
separates them most, while keeping known-false at or below noise, wins. This
needs no hand-labelled relevance judgements, which the corpus does not have.
