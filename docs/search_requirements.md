# Search requirements

What search has to accomplish for a reader, as plain requirements. This is
the target, not a description of what the code does today: some of these
hold now, some do not, and nothing here is written to match the current
implementation.

`docs/search_rules.md` specifies the behavior as built, and
`docs/search_critique.md` reviews the gap between the two. This file is the
input both of those should answer to. It states no formula, no weight and no
data structure on purpose - a requirement that names a mechanism stops being
a requirement and becomes a design.

**An `SR-nn` is a permanent identifier, not a list position.** Tests cite
requirements by id (`test('... [SR-18]', ...)`) and `npm run
check:requirements` rebuilds the coverage mapping from those tags on every
run, so a renumbering would silently re-point every citation at the wrong
requirement. Add a new requirement at the end of its section with the next
unused number, and never reuse the number of one that is retired. This file
cites no tests in return: the reference runs one way, from the thing that
changes to the thing that does not.

A requirement marked _(judged)_ has no assertion that would fail if it
stopped being true, and is counted separately rather than as a permanent
coverage gap.

## Finding

- **SR-01** Search should find things within titles, tags, stories and image
  content.
- **SR-02** Search should match regardless of case, accents, or diacritics.
- **SR-03** Search should match a multi-word tag when the user types it
  plainly, without quotes.
- **SR-04** Search should match grammatical variants of a word without matching
  lookalikes.
- **SR-05** Search should let a user demand an exact quoted phrase when they
  want one.
- **SR-06** Search should ignore words too short or too common to carry
  meaning.
- **SR-07** Clicking a keyword should search for that keyword exactly as
  written.
- **SR-08** Search should consider every room in the corpus, never a subset.

## Ranking

- **SR-09** Search should balance the relative importance of those elements in
  a way that feels intuitively correct to users. _(judged)_
- **SR-10** When the search exactly matches a tag, title, or significant chunk
  of story content, those matches should take precedence over whatever CLIP has
  to say.
- **SR-11** Search should prioritize image content strongly enough to ensure
  that a search for a common visual element that CLIP recognizes produces a
  striking and obvious pattern in the sorted map.
- **SR-12** An exact match should outrank a partial one.
- **SR-13** More matches should outrank fewer.
- **SR-14** A room matching several signals weakly should be able to outrank a
  room matching one signal weakly.
- **SR-15** The same query against the same corpus should always produce the
  same order.

## Strength and honesty

- **SR-16** Search should report how strong each room's match is on a scale
  that does not depend on what else is in the corpus.
- **SR-17** A room's reported strength should not drop because the user added
  words that have nothing to do with it.
- **SR-18** Typing a room's tag verbatim should report that room as a maximally
  strong match.
- **SR-19** Search should never present the top result of a meaningless query
  as a strong match.
- **SR-20** Search should tell the user plainly when nothing matched.
- **SR-21** Search should say which signals it actually had available, and not
  imply confidence it cannot support.
- **SR-22** The strength a room reports and the position it occupies on the map
  should agree.

## The map

- **SR-23** Search should allow us to sort rooms on the map in a way that makes
  it visually clear how strong the results are across the full dataset.
- **SR-24** Distance from the center should carry one meaning at a time.
- **SR-25** Which meaning is in force should be visible on screen, so a reader
  never has to remember what they turned on to read the map correctly.
- **SR-26** With no search and no favorite sort active, distance from the
  center should carry no meaning.
- **SR-27** While a search is active, distance from the center should mean
  match strength alone.
- **SR-28** While a favorite sort is active, distance from the center should
  mean favorite status alone.
- **SR-29** A vague search should look visibly different from a precise one,
  and from no search at all.
- **SR-30** Clearing the search should return the map to its unsearched state.
- **SR-31** A search should rearrange the library visibly, as motion, not as a
  jump cut.

## Explaining itself

- **SR-32** When ranking search results, users should be able to see a clear
  and simple breakdown of why each room landed on its particular ranking.
- **SR-33** Each room should show how it ranks on each signal independently,
  not only overall.
- **SR-34** Search should highlight the matched text wherever it is shown.
- **SR-35** Search should mark only what actually counted toward the score.
- **SR-36** Raw underlying numbers should be available to anyone who wants
  them, without being the primary reading.

## Fitting the rest of the app

- **SR-37** A search should produce the same ranking in the map and in the
  catalog.
- **SR-38** Search should be reachable from the center tile, the side panel,
  and the catalog alike.
- **SR-39** Recent searches should be recoverable without retyping.
- **SR-40** Search should respect blocked tags and never surface a room the
  reader has excluded.
- **SR-41** A search and a favorite sort should be mutually exclusive: starting
  either one should end the other.
- **SR-42** A room found by search should be shareable by a link that still
  resolves later.

## Holding up

- **SR-43** Search should stay responsive on the largest corpus it will ever
  serve.
- **SR-44** A long or pasted query should be refused or truncated, never
  allowed to freeze the page.
- **SR-45** A second search issued before the first returns should win.
- **SR-46** A search that fails should say so and leave the library as it was.

## Reachable by everyone

- **SR-47** Search should announce its results to a screen reader without a
  keypress.
- **SR-48** Every result should be reachable and openable by keyboard alone.
- **SR-49** Anything the map conveys by position or density should also be
  available as text.
