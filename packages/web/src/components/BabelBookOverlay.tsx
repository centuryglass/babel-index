/**
 * Shows a random book from the Library of Babel: an endless wall of
 * (mostly) meaningless text, paged a screenful at a time, in the spirit of
 * Borges's library where every possible book already exists on some shelf.
 *
 * An easter egg on the artist's statement, opened by "Click here to run some
 * equivalent code" and stacked on top of it. It is the same open book as the
 * statement (`BookOverlay`) - a spread of two pages when the dialog is wide
 * enough, one page when it is not - so `next`/`previous` step by two or by one
 * to match what is on screen.
 */
import { useMemo, useState } from 'react';
import { BookOverlay } from './BookOverlay.tsx';

const BOOK_CHARSET = 'abcdefghijklmnoprstuvy, .';

/**
 * The text of one random "book": fixed-width lines grouped into paragraphs
 * (a blank line every `linesPerParagraph` lines), drawn from a restricted
 * charset the way the Library of Babel's books are.
 */
export function generateRandomBookText(
  lineCount = 16400,
  lineLength = 80,
  linesPerParagraph = 40,
  charset = BOOK_CHARSET
) {
  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    let line = '';
    for (let j = 0; j < lineLength; j++) {
      line += charset[(Math.random() * charset.length) | 0];
    }
    lines.push(line);
    if (i % linesPerParagraph === linesPerParagraph - 1) lines.push('');
  }
  return lines.join('\n');
}

/**
 * Split a book's text into pages of `linesPerPage` lines each. The generator
 * writes a blank line after every full paragraph; when a paragraph is a page
 * long that blank is the page separator, so it is consumed between pages rather
 * than counted toward the next - otherwise each page's content would slip down
 * one line further than the last.
 */
export function paginateBookText(text: string, linesPerPage = 40): string[] {
  const lines = text.split('\n');
  const pages: string[] = [];
  let i = 0;
  while (i < lines.length) {
    pages.push(lines.slice(i, i + linesPerPage).join('\n'));
    i += linesPerPage;
    if (lines[i] === '') i += 1;
  }
  return pages.length > 0 ? pages : [''];
}

interface BabelBookOverlayProps {
  text?: string;
  linesPerPage?: number;
  onClose?: () => void;
}

export function BabelBookOverlay({ text, linesPerPage = 40, onClose }: BabelBookOverlayProps) {
  const book = useMemo(() => text ?? generateRandomBookText(), [text]);
  const pages = useMemo(() => paginateBookText(book, linesPerPage), [book, linesPerPage]);
  // `page` is the index of the left (or only) page currently shown.
  const [page, setPage] = useState(0);
  const [isWide, setIsWide] = useState(true);

  const last = pages.length - 1;
  const left = Math.min(page, last);
  const right = isWide && left < last ? left + 1 : null;

  const step = right !== null ? 2 : 1;
  const atFirst = left === 0;
  const atLast = (right ?? left) === last;

  const counter =
    right !== null
      ? `pages ${left + 1}-${right + 1} / ${pages.length}`
      : `page ${left + 1} / ${pages.length}`;

  return (
    <BookOverlay
      ariaLabel="a random book"
      onClose={() => onClose?.()}
      scrimClassName="stacked"
      overlayClassName="babel-overlay"
      onWideChange={setIsWide}
      head={<span className="card-id">{counter}</span>}
      footer={
        <div className="book-nav">
          <button disabled={atFirst} onClick={() => setPage(Math.max(0, left - step))}>
            previous
          </button>
          <button disabled={atLast} onClick={() => setPage(Math.min(last, left + step))}>
            next
          </button>
        </div>
      }
    >
      <pre className="book-page babel-page">{pages[left]}</pre>
      {right !== null && <pre className="book-page babel-page">{pages[right]}</pre>}
    </BookOverlay>
  );
}
