/**
 * A minimal paged overlay for showing a long block of text a screenful at a
 * time. Not wired into the app - this exists to try out the pagination
 * mechanics on a body of text large enough to need them, before deciding
 * whether/how a paged text view belongs anywhere real.
 */
import { useMemo, useState } from 'react';

const SAMPLE_CHARSET = 'abcdefghijklmnoprstuvy, .';

/**
 * A block of random lines, in the same shape as prose: fixed-width lines
 * grouped into paragraphs (a blank line every `linesPerParagraph` lines).
 */
export function generateSampleText(
  lineCount = 16400,
  lineLength = 80,
  linesPerParagraph = 40,
  charset = SAMPLE_CHARSET
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

/** Split text into pages of `linesPerPage` lines each. */
export function paginateText(text: string, linesPerPage = 40): string[] {
  const lines = text.split('\n');
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage).join('\n'));
  }
  return pages.length > 0 ? pages : [''];
}

interface PagedTextOverlayProps {
  text?: string;
  linesPerPage?: number;
  onClose?: () => void;
}

export function PagedTextOverlay({ text, linesPerPage = 40, onClose }: PagedTextOverlayProps) {
  const body = useMemo(() => text ?? generateSampleText(), [text]);
  const pages = useMemo(() => paginateText(body, linesPerPage), [body, linesPerPage]);
  const [page, setPage] = useState(0);

  const clamped = Math.min(page, pages.length - 1);
  const atFirst = clamped === 0;
  const atLast = clamped === pages.length - 1;

  return (
    <div className="overlay-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="overlay" role="dialog" aria-modal="true" aria-label="paged text">
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
