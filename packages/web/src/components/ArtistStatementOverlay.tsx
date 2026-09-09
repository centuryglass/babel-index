/**
 * The artist's statement, reached by the open book painted into a shelf gap on
 * the center tile (`centerBookAtPoint` in `packages/web/src/lib/center.ts`,
 * dispatched from `main.tsx`). An open book of two pages: the diegetic myth on
 * the left, the real statement on the right. On a display too narrow for two
 * readable columns the CSS stacks them, story above statement, the spine
 * becoming a horizontal rule.
 *
 * This component is the source of truth for both texts. The statement is not
 * plain prose (it carries a shell one-liner, an outbound link, and a phrase
 * that has to open the Babel book), so the words live here as JSX rather than
 * in a doc parsed at build time - there is no other copy to keep in step.
 *
 * "Click here to run some equivalent code" opens `BabelBookOverlay` ON TOP of
 * this one - `bookOpen` is local state, the shared dialog stack in `useDialog`
 * is what makes Escape close the book first and this statement second, and the
 * `behind` class is what dims and sets this one back while the book is up.
 */
import { useRef, useState } from 'react';
import { useDialog } from '../hooks/useDialog.ts';
import { BabelBookOverlay } from './BabelBookOverlay.tsx';

const WIKI_URL = 'https://en.wikipedia.org/wiki/The_Library_of_Babel';
// The Library-of-Babel one-liner. Rendered as a text node (never innerHTML) -
// it carries `<`, `|` and `\`.
const BABEL_COMMAND = 'tr -dc \\ ,.a-pr-vy</dev/urandom|fold -80|sed 0~40G\\;16400q';

export function ArtistStatementOverlay({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [bookOpen, setBookOpen] = useState(false);
  useDialog(ref, onClose);

  return (
    <>
      <div
        className={`overlay-scrim${bookOpen ? ' behind' : ''}`}
        onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <div
          className="overlay statement-overlay"
          ref={ref}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          aria-label="an artist's statement"
        >
          <div className="card-head">
            <button className="card-close" onClick={onClose} aria-label="close">
              ×
            </button>
          </div>

          <div className="statement-book">
            <div className="statement-page statement-story">
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

            <div className="statement-page statement-real">
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
                <button className="statement-link" onClick={() => setBookOpen(true)}>
                  Click here to run some equivalent code
                </button>{' '}
                and you'll get an actual book from the library. It probably won't
                have anything interesting, but it's entirely possible that you'll
                find your life story, or the book you've always wished that you
                wrote.
              </p>
              <p>
                People do things equivalent to searching the library every day. At
                its core, most forms of divination are ways to search the library,
                as are many forms of art. When a person flips the tarot cards or
                tosses the yarrow for the I Ching, they're trying to find their
                story in one of the library's books. When a sculptor looks for a
                true shape within a piece of driftwood, that's searching the
                library. Sometimes they manage to find something interesting or
                even life-changing in the chaos. Usually they don't.
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
                lines to form intricate cityscapes. This accelerates that search to
                give me results I'd only dreamed of before.
              </p>
              <p>
                There's still a lot of room left for curation here, even after all
                the time I spent. I'd love to see which of these shelves are most
                interesting to you. Search for concepts that intrigue you, mark the
                best with a ★, and join me in the search.
              </p>
            </div>
          </div>
        </div>
      </div>

      {bookOpen && <BabelBookOverlay onClose={() => setBookOpen(false)} />}
    </>
  );
}
