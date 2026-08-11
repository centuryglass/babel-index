/**
 * Canonical constants from Borges, "The Library of Babel" (1941).
 *
 * Every number here is taken from the story text, not invented. See
 * docs/borges-parameters.md for the verbatim passages each one comes from.
 * Nothing downstream should hard-code these; import them.
 */

export const STORY = {
  // "The universe (which others call the Library) is composed of an
  //  indefinite, perhaps infinite number of hexagonal galleries..."
  sidesPerGallery: 6,

  // "Twenty shelves, five long shelves per side, cover all the sides
  //  except two."
  shelvedSides: 4,
  freeSides: 2,
  shelvesPerSide: 5,
  shelvesPerGallery: 20,

  // "each bookshelf holds thirty-two books identical in format; each book
  //  contains four hundred ten pages; each page, forty lines; each line,
  //  approximately eighty black letters."
  booksPerShelf: 32,
  booksPerGallery: 640, // 20 shelves * 32
  pagesPerBook: 410,
  linesPerPage: 40,
  charactersPerLine: 80,

  // "the twenty-five sufficient symbols" - the space, the comma, the period,
  // and the twenty-two letters of the alphabet.
  orthographicSymbols: 25,

  // "Light is provided by some spherical fruit which bear the name of lamps.
  //  There are two, transversally placed, in each hexagon."
  lampsPerGallery: 2,

  // "To the left and right of the hallway there are two very small closets."
  closetsPerHallway: 2,

  // "In the hallway there is a mirror which faithfully duplicates all
  //  appearances." / "Also through here passes a spiral stairway, which sinks
  //  abysmally and soars upwards to remote distances."
  mirrorsPerHallway: 1,
  spiralStairwaysPerHallway: 1,
};

/** Characters in one book: 410 * 40 * 80. */
export const CHARACTERS_PER_BOOK =
  STORY.pagesPerBook * STORY.linesPerPage * STORY.charactersPerLine;

/**
 * Total distinct books in the Library: 25 ^ 1_312_000. Returned as a BigInt
 * exponent pair rather than a number, because it is not a number any machine
 * will hold.
 */
export const LIBRARY_CARDINALITY = {
  base: STORY.orthographicSymbols,
  exponent: CHARACTERS_PER_BOOK,
  toString() {
    return `${this.base}^${this.exponent}`;
  },
};
