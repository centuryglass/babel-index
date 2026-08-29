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

**Landed:** `matchCertainty` in `scoring.js` takes `{tagCoverage, storyLongChars,
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
(`config.ts`), and `rankHybrid` (`scoring.js`) sums exactly those five terms —
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
shape). Two new pure functions in `scoring.js` measure what `storyLongChars`
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

**Landed:** `parseQuery(raw)` in `scoring.js` produces the `Term[]`/`ParsedQuery`
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

## 5. CLIP certainty is mapped off theoretical extremes, not the distribution

**Ideal** (`search_rules.md` "Image-content matching" + "Computing certainty"):
one continuous, distribution-anchored curve. The centre of the measured cosine
distribution is where CLIP has *no opinion*; above it, rising confidence the
image matches; below it, rising confidence it does *not*. Displayed as a signed
percentage, "N% certain the image content does not match" for the negative side.

**Now:** two hand-set linear bands. `CLIP_CERTAINTY = {-0.08, 0.37}` (used for
both the ranking gate and the density gradient) and the doc's separate display
band both put their zero-crossing far below where text→image cosines actually
live. Measured on the real corpus (2048 rooms × 2149 keywords, ViT-B/32):
unrelated pairs centre at cosine **≈ 0.205**, the global min across 4.4M pairs is
only **−0.060**, and real best-matches sit at **p50 ≈ 0.26**, max **0.346**. So a
genuinely unrelated query reads as ~60% certain on the current display band, and
the negative side is unreachable.

**Steps:**
1. Measure the *no-opinion centre* and the two extremes directly, not by
   guessing:
   - the noise centre from the `overall` distribution (`cosine-range.ts`) and
     from a set of **nonsense/keysmash** probe queries (they should land in the
     same band — that agreement is the validation);
   - the high extreme from `keywordMax` and the universal-keyword ceiling
     (already measured);
   - the low extreme from **known-irrelevant strong concepts** (celebrity names,
     objects nothing in the corpus resembles). Expect these to land *low-positive*,
     not negative — which is the point: it confirms the negative display range
     maps almost entirely onto low-positive cosines, with only outliers below
     zero, exactly as the spec now says.
2. Replace the linear band with a monotone map anchored on those three points:
   `0` at the no-opinion centre, `+1` toward the high extreme, `−1` toward the
   low extreme, continuous throughout (no discrete steps). A signed transform of
   the measured noise CDF is the natural shape and needs no arbitrary bounds;
   `cosine-stats.ts` already computes the percentiles it would read.
3. Keep the ranking gate (`clipCertaintyGate`, the `[0, 1]` used inside the sum)
   as the positive half of the same curve — one calibration, two readings, not
   two bands to drift.
4. Update `explainScore`/`RoomDetails` to render the signed value: a positive
   "certain it matches" and a visually distinct negative "certain it does not",
   clamped `0.01%`–`99.99%` on both sides.

## 6. Per-signal ranks and ties are not computed

**Ideal** (`search_rules.md` "Data structures" §4, reporting assertions): every
room readable on each axis alone — "#4 by tag, tied with 2 others".

**Now:** `rankHybrid` returns `order`/`certainty`/`breakdown`/`signals` only.

**Steps:** add the three independent per-signal sorts of the existing
`breakdown` arrays (`ranks`/`ties`), and surface them in the breakdown UI. No new
scoring — just sorting numbers the pass already produced.

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
