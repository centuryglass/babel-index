/**
 * A random "book" from the Library of Babel: fixed-width lines grouped into
 * paragraphs, drawn from a restricted charset the way the library's own books
 * are. Pure and DOM-free, so both `BabelBookOverlay.tsx` (the browser easter
 * egg) and `packages/server/app.ts`'s `/babel-book` route (a plain-text
 * no-JS equivalent) generate from one implementation.
 */
const BOOK_CHARSET = 'abcdefghijklmnoprstuvy, .';

/**
 * The text of one random "book": fixed-width lines grouped into paragraphs
 * (a blank line every `linesPerParagraph` lines).
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
