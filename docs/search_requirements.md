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

## Finding

1. Search should find things within titles, tags, stories and image content.
2. Search should match regardless of case, accents, or diacritics.
3. Search should match a multi-word tag when the user types it plainly,
   without quotes.
4. Search should match grammatical variants of a word without matching
   lookalikes.
5. Search should let a user demand an exact quoted phrase when they want one.
6. Search should ignore words too short or too common to carry meaning.
7. Clicking a keyword should search for that keyword exactly as written.
8. Search should consider every room in the corpus, never a subset.

## Ranking

9. Search should balance the relative importance of those elements in a way
   that feels intuitively correct to users.
10. When the search exactly matches a tag, title, or significant chunk of
    story content, those matches should take precedence over whatever CLIP
    has to say.
11. Search should prioritize image content strongly enough to ensure that a
    search for a common visual element that CLIP recognizes produces a
    striking and obvious pattern in the sorted map.
12. An exact match should outrank a partial one.
13. More matches should outrank fewer.
14. A room matching several signals weakly should be able to outrank a room
    matching one signal weakly.
15. The same query against the same corpus should always produce the same
    order.

## Strength and honesty

16. Search should report how strong each room's match is on a scale that does
    not depend on what else is in the corpus.
17. A room's reported strength should not drop because the user added words
    that have nothing to do with it.
18. Typing a room's tag verbatim should report that room as a maximally
    strong match.
19. Search should never present the top result of a meaningless query as a
    strong match.
20. Search should tell the user plainly when nothing matched.
21. Search should say which signals it actually had available, and not imply
    confidence it cannot support.
22. The strength a room reports and the position it occupies on the map
    should agree.

## The map

23. Search should allow us to sort rooms on the map in a way that makes it
    visually clear how strong the results are across the full dataset.
24. Distance from the center should carry one meaning at a time.
25. Which meaning is in force should be visible on screen, so a reader never
    has to remember what they turned on to read the map correctly.
26. With no search and no favorite sort active, distance from the center
    should carry no meaning.
27. While a search is active, distance from the center should mean match
    strength alone.
28. While a favorite sort is active, distance from the center should mean
    favorite status alone.
29. A vague search should look visibly different from a precise one, and from
    no search at all.
30. Clearing the search should return the map to its unsearched state.
31. A search should rearrange the library visibly, as motion, not as a jump
    cut.

## Explaining itself

32. When ranking search results, users should be able to see a clear and
    simple breakdown of why each room landed on its particular ranking.
33. Each room should show how it ranks on each signal independently, not only
    overall.
34. Search should highlight the matched text wherever it is shown.
35. Search should mark only what actually counted toward the score.
36. Raw underlying numbers should be available to anyone who wants them,
    without being the primary reading.

## Fitting the rest of the app

37. A search should produce the same ranking in the map and in the catalog.
38. Search should be reachable from the center tile, the side panel, and the
    catalog alike.
39. Recent searches should be recoverable without retyping.
40. Search should respect blocked tags and never surface a room the reader
    has excluded.
41. A search and a favorite sort should be mutually exclusive: starting
    either one should end the other.
42. A room found by search should be shareable by a link that still resolves
    later.

## Holding up

43. Search should stay responsive on the largest corpus it will ever serve.
44. A long or pasted query should be refused or truncated, never allowed to
    freeze the page.
45. A second search issued before the first returns should win.
46. A search that fails should say so and leave the library as it was.

## Reachable by everyone

47. Search should announce its results to a screen reader without a keypress.
48. Every result should be reachable and openable by keyboard alone.
49. Anything the map conveys by position or density should also be available
    as text.
