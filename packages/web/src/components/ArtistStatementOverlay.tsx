/**
 * The artist's statement, reached by the open book painted into a shelf gap on
 * the center tile (`centerBookAtPoint` in `packages/web/src/lib/center.ts`,
 * dispatched from `main.tsx`). An open book of two pages, whose text lives in
 * `ArtistStatementPages.tsx` (shared with the SSR `/about` route - see that
 * file's own comment).
 *
 * The `.statement-link` button opens `BabelBookOverlay` on top of this one -
 * `bookOpen` is local state, the shared dialog stack in `useDialog` makes
 * Escape close the book first and this statement second, and the `behind`
 * class dims and sets this one back while the book is up.
 */
import { useState } from 'react';
import { BookOverlay } from './BookOverlay.tsx';
import { BabelBookOverlay } from './BabelBookOverlay.tsx';
import { ArtistStatementPages } from './ArtistStatementPages.tsx';

export function ArtistStatementOverlay({ onClose }: { onClose: () => void }) {
  const [bookOpen, setBookOpen] = useState(false);

  return (
    <>
      <BookOverlay
        ariaLabel="an artist's statement"
        onClose={onClose}
        overlayClassName="statement-overlay"
        scrimClassName={bookOpen ? 'behind' : undefined}
      >
        <ArtistStatementPages
          runBookLink={
            <button className="statement-link" onClick={() => setBookOpen(true)}>
              Run the same thing here
            </button>
          }
        />
      </BookOverlay>

      {bookOpen && <BabelBookOverlay onClose={() => setBookOpen(false)} />}
    </>
  );
}
