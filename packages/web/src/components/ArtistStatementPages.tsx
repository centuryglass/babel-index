/**
 * The two pages of the artist's statement: the diegetic myth on the left, the
 * real statement on the right. Pure and stateless (no hooks, no browser
 * calls) - `ArtistStatementOverlay` wraps this in the interactive `BookOverlay`
 * chrome, and `packages/server/staticPages.tsx` renders this exact markup
 * with `react-dom/server` for the SSR `/about` route. The words live here
 * once; neither caller keeps its own copy.
 *
 * `runBookLink` is the one piece that has to differ between the two: opening
 * `BabelBookOverlay` in place is a client-only affordance, so each caller
 * hands in the element that does the equivalent thing for it - a `<button>`
 * that opens the overlay live, or a plain `<a href="/babel-book">` for a
 * no-JS visitor.
 */
import type { ReactNode } from 'react';

const WIKI_URL = 'https://en.wikipedia.org/wiki/The_Library_of_Babel';
// The Library-of-Babel one-liner. Rendered as a text node (never innerHTML) -
// it carries `<`, `|` and `\`.
const BABEL_COMMAND = 'tr -dc \\ ,.a-pr-vy</dev/urandom|fold -80|sed 0~40G\\;16400q';

export function ArtistStatementPages({ runBookLink }: { runBookLink: ReactNode }) {
  return (
    <>
      <div className="book-page statement-page statement-story">
        <p className="statement-head" aria-hidden="true">The Index of Babel</p>
        <p>
          The Library of Babel holds every possible arrangement of letters
          on paper, stacked on endless shelves in senseless disorder. Every
          answer you seek is out there somewhere, but you will never find it
          by looking.
        </p>
        <p>
          The Inquisitors search anyway, wasting their lives on doomed
          wandering. They hope to find their vindication, but rarely turn up
          more than scraps. One might spend forty years searching, and never
          find anything greater than a single volume ending with the words
          "Oh time thy pyramids".
        </p>
        <p>
          The Authors reject the library's books, taking it as their duty to
          create the meaning that the Inquisitors will never find. They
          bleach the library's natural books free of text, then write their
          own words on the pages. Their territory is vast, holding treasures
          beyond anything seen in ten thousand years searching the shelves.
          And yet it's a private despair to many that all of their works
          already exist in countless superior variations on unknown Library
          shelves.
        </p>
        <p>
          Our order takes a third route. We refuse to abandon the search,
          but we know that the Index the Inquisitors seek will never be
          found, not through aimless exploration. Instead we will build it
          ourselves. Drawing lines between the knowledge the Authors hoard
          and the raw chaos of the Library, we have found patterns. Through
          our sciences, we've built those patterns into a map, a model, and
          finally, a net, stretching through seven hundred and sixty-eight
          dimensions. When pulled, the shelves are drawn in from libraries
          that never existed, each mathematically bound to shards of meaning.
        </p>
        <p>
          Even with the Index, we'll often spend weeks finding nothing more
          interesting than tedious genealogies of hypothetical villages, and
          even the beautiful finds are usually worthless. I've reluctantly
          discarded leather-bound clouds and antlered gemstone bookends,
          unsettling portrait-carved folios and imaginary bestiaries. Time
          and attention are still finite, and you can only share so many
          dream-wonders before people insist on having something real.
        </p>
        <p>
          Few stay for more than a few months. Search long enough and you
          find inspiration, and your stories grow beyond their roots in the
          Index. You're always free to join the Authors, even if they do
          condemn our practice as heretical. Perhaps I'll join them too one
          day, although I doubt it. Someone needs to tend to the Index, and
          I doubt I'll ever tire of the search.
        </p>
      </div>

      <div className="book-page statement-page statement-real">
        <p className="statement-head" aria-hidden="true">Artist&rsquo;s Statement</p>
        <p>
          The{' '}
          <a href={WIKI_URL} target="_blank" rel="noopener noreferrer">
            Library of Babel
          </a>{' '}
          is real. Not as a physical place, but as a mathematical truth. You
          can express it as a single line:
        </p>
        <pre className="statement-code">
          <code>{BABEL_COMMAND}</code>
        </pre>
        <p>
          {runBookLink}{' '}
          and you'll get an actual book from the library. It probably won't
          have anything interesting, but it's entirely possible that you'll
          find your life story, or the book you've always wished that you
          wrote.
        </p>
        <p>
          People search the library constantly, under other names. Most forms
          of divination are ways to search the library, as are many types of
          art. Someone drawing tarot cards, or casting yarrow stalks for the
          I Ching, is trying to find their story in one of the library's
          books. When a sculptor looks for a true shape within a piece of
          driftwood, that's searching the library. Sometimes they manage to
          find something interesting or even life-changing in the chaos.
          Usually they don't.
        </p>
        <p>
          AI's most interesting artistic role is in accelerating the search.
          Curating randomness to find accidental meaning is a real art form,
          but the rate of return is terribly low. Generative AI tools serve
          to tether that randomness, linking it to patterns found in existing
          art just tightly enough to exclude most of the meaningless noise.
          It's a rough index into the Library, letting us limit the search to
          a much more rewarding subset of the near-infinite space.
        </p>
        <p>
          AI doesn't take away the human work. It's still the same search it
          always was; the standards can just be raised now. For this project
          I discarded at least twenty rooms and stories for every one that I
          kept, and many of the remaining rooms and stories had major flaws I
          needed to individually fix. It's still the same process I'd follow
          through automatic drawing, where I'd join meaningless scribbled
          lines to form intricate cityscapes. Diffusion models and LLMs give
          me lines I never would have considered scribbling.
        </p>
        <p>
          There's still a lot of room left for curation within this project,
          even after all of the time I spent. I'd love to see which of these
          shelves are most interesting to you. Search for concepts that
          intrigue you, mark the best with a ★, and join me in the search.
        </p>
      </div>
    </>
  );
}
