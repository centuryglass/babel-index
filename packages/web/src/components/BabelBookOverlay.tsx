/**
 * Shows a random book from the Library of Babel: an endless wall of
 * (mostly) meaningless text, paged a screenful at a time, in the spirit of
 * Borges's library where every possible book already exists on some shelf.
 *
 * Meant as an easter egg on the artist statement page, once that page
 * exists - not wired into the app yet.
 */
import { useMemo, useState } from 'react';

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

/** Split a book's text into pages of `linesPerPage` lines each. */
export function paginateBookText(text: string, linesPerPage = 40): string[] {
  const lines = text.split('\n');
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage).join('\n'));
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
  const [page, setPage] = useState(0);

  const clamped = Math.min(page, pages.length - 1);
  const atFirst = clamped === 0;
  const atLast = clamped === pages.length - 1;

  return (
    <div className="overlay-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="overlay" role="dialog" aria-modal="true" aria-label="a random book">
        <div className="card-head">
          <span className="card-id">
            page {clamped + 1} / {pages.length}
          </span>
          {onClose && (
            <button className="card-close" onClick={onClose} aria-label="close">
              ×
            </button>
          )}
        </div>

        <pre className="overlay-body">{pages[clamped]}</pre>

        <div className="card-head">
          <button disabled={atFirst} onClick={() => setPage(clamped - 1)}>
            previous
          </button>
          <button disabled={atLast} onClick={() => setPage(clamped + 1)}>
            next
          </button>
        </div>
      </div>
    </div>
  );
}
