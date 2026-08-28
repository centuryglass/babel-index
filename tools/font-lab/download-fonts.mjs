/**
 * Fetch the latin woff2 of every candidate face into tools/font-lab/fonts/.
 *
 * Uses the Google Fonts CSS2 API with a browser User-Agent (that header is what
 * makes it return woff2 rather than the older ttf), then pulls the URL out of the
 * `/* latin *\/` @font-face block - the spines are English, so the latin subset
 * is all we need and it keeps the files small. Idempotent: skips a file already
 * on disk, so re-running is cheap.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FONTS, DEFAULT_WEIGHTS } from './fonts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(HERE, 'fonts');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** Pull the latin-subset woff2 url out of a CSS2 API response. */
function latinWoff2(css) {
  // Blocks are `/* subset */\n@font-face { ... }`. Grab each, keep the latin one.
  const blocks = css.split('/*').map((b) => '/*' + b);
  const latin = blocks.find((b) => b.startsWith('/* latin */'));
  const src = latin ?? blocks.find((b) => b.includes('url('));
  const m = src && src.match(/url\((https:\/\/[^)]+\.woff2)\)/);
  if (!m) throw new Error('no woff2 url in CSS block');
  return m[1];
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchFace(family, weight) {
  const fam = family.replace(/ /g, '+');
  const url = `https://fonts.googleapis.com/css2?family=${fam}:wght@${weight}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`CSS ${res.status} for ${family} ${weight}`);
  const woff2 = latinWoff2(await res.text());
  const bin = await fetch(woff2);
  if (!bin.ok) throw new Error(`woff2 ${bin.status} for ${family} ${weight}`);
  return Buffer.from(await bin.arrayBuffer());
}

async function main() {
  await mkdir(FONT_DIR, { recursive: true });
  for (const font of FONTS) {
    const weights = font.weights ?? DEFAULT_WEIGHTS;
    for (const weight of weights) {
      const out = join(FONT_DIR, `${font.slug}-${weight}.woff2`);
      if (await exists(out)) {
        console.log(`skip  ${font.slug}-${weight}`);
        continue;
      }
      try {
        const buf = await fetchFace(font.family, weight);
        await writeFile(out, buf);
        console.log(`ok    ${font.slug}-${weight}  (${(buf.length / 1024).toFixed(0)} KB)`);
      } catch (err) {
        console.error(`FAIL  ${font.slug}-${weight}: ${err.message}`);
      }
    }
  }
}

main();
