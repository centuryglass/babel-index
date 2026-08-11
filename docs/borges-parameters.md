# The parameters, as Borges gave them

Everything the base room asserts about the Library comes from the 1941 story.
This file records the source passages so that
[`tools/base-image/lib/story.js`](../tools/base-image/lib/story.js) can be
checked against them rather than trusted.

## A note on translations

The two English translations in wide circulation phrase the architecture
differently, and the passages quoted below are drawn from both — Irby's (in
*Labyrinths*) for the gallery description, Hurley's (in *Collected Fictions*)
for the enumeration of books. They agree on every number this project uses.
Where the repository quotes the story it is quoting a translation, not the
Spanish.

## The gallery

> The universe (which others call the Library) is composed of an indefinite,
> perhaps infinite number of hexagonal galleries, with vast air shafts between,
> surrounded by very low railings.

> Twenty shelves, five long shelves per side, cover all the sides except two;
> their height, which is the distance from floor to ceiling, scarcely exceeds
> that of a normal bookcase.

> One of the free sides leads to a narrow hallway which opens onto another
> gallery, identical to the first and to all the rest. To the left and right of
> the hallway there are two very small closets. [...] Also through here passes a
> spiral stairway, which sinks abysmally and soars upwards to remote distances.
> In the hallway there is a mirror which faithfully duplicates all appearances.

> Light is provided by some spherical fruit which bear the name of lamps. There
> are two, transversally placed, in each hexagon. The light they emit is
> insufficient, incessant.

## The books

> each bookshelf holds thirty-two books identical in format; each book contains
> four hundred ten pages; each page, forty lines; each line, approximately
> eighty black letters.

> [...] the twenty-five sufficient symbols [...]

The story's editorial footnote glosses those symbols: the original manuscript
has neither numerals nor capitals, punctuation runs to the comma and the period
only, and those two marks plus the space and the twenty-two letters of the
alphabet make twenty-five.

## Derived numbers

| Quantity | Value | Where it comes from |
| --- | --- | --- |
| Sides per gallery | 6 | "hexagonal galleries" |
| Shelved sides | 4 | "cover all the sides except two" |
| Free sides | 2 | as above |
| Shelves per side | 5 | "five long shelves per side" |
| Shelves per gallery | 20 | stated outright |
| Books per shelf | 32 | stated outright |
| **Books per gallery** | **640** | 20 × 32 |
| Pages per book | 410 | stated outright |
| Lines per page | 40 | stated outright |
| Characters per line | ~80 | "approximately eighty" |
| **Characters per book** | **1,312,000** | 410 × 40 × 80 |
| Orthographic symbols | 25 | stated outright |
| **Distinct books** | **25^1,312,000** | symbols ^ characters |
| Lamps per gallery | 2 | "two, transversally placed" |
| Closets per hallway | 2 | "to the left and right" |
| Mirrors per hallway | 1 | stated outright |
| Spiral stairways per hallway | 1 | stated outright |

## Where the story is silent, and what we chose

The story is a description, not a plan, and it leaves gaps that a renderer
cannot leave open. Each gap below is a project decision, not a fact about the
Library:

1. **Is the shelved-side count 20 or 30?** Irby's "twenty shelves, five long
   shelves per side" over four shelved sides is self-consistent. Hurley's "each
   wall of each hexagon is furnished with five bookshelves" reads as 30 if
   "each wall" means all six. We take 20, the number the story states directly.
   A tile is one of those four sides: 5 shelves × 32 books = 160.
2. **A tile is a wall, not a room.** The story describes galleries; the map is a
   grid of single shelved walls. That is a presentation choice made because a
   wall tiles and a hexagonal room does not — not a claim about the
   architecture. The hallway, the closets, the mirror, the spiral stairway and
   the air shaft are all therefore absent from the tile.
3. **Two lamps per gallery becomes one per tile**, so four per gallery. The
   story says two, transversally placed. Deliberate: a wall needs its own light
   source to read as lit.
4. **The grid's vertical axis means nothing in particular.** With tiles as walls
   rather than rooms, "the tile above" is not the gallery on the floor above.
   The grid is an abstract arrangement surface.

See [implementation-plan.md](implementation-plan.md#6-decisions-made) for how
these were settled.
