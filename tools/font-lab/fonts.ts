/**
 * The candidate faces for the spine-title experiment, and where to fetch them.
 *
 * Every entry is a free (OFL) Google Fonts family. Spine titles render small,
 * so what matters is not elegance at display size but survival at text size.
 *
 * Two weights are fetched per family (`DEFAULT_WEIGHTS`) so the settings sweep
 * can ask whether gilt reads better a touch heavier - tiny light strokes on a
 * bright spine tend to vanish.
 *
 * The system-sans reference face needs no download; it is declared in
 * variants.ts by family string alone.
 */
export interface FontEntry {
  slug: string;
  family: string;
  /** Weights to fetch; DEFAULT_WEIGHTS when absent. */
  weights?: number[];
}

export const FONTS: FontEntry[] = [
  // The first six candidates, all serifs.
  { slug: 'literata', family: 'Literata' },
  { slug: 'libre-baskerville', family: 'Libre Baskerville', weights: [400, 700] },
  { slug: 'vollkorn', family: 'Vollkorn' },
  { slug: 'pt-serif', family: 'PT Serif', weights: [400, 700] },
  { slug: 'alegreya', family: 'Alegreya' },
  { slug: 'source-serif-4', family: 'Source Serif 4' },
  // Serif additions: two faces built to hold up at text size (a sturdy slab,
  // a screen-first serif), one delicate face as the counter-example.
  { slug: 'bitter', family: 'Bitter' },
  { slug: 'spectral', family: 'Spectral' },
  { slug: 'eb-garamond', family: 'EB Garamond' },
  // Sans-serif candidates: humanist and grotesque faces with strong hinting
  // and open apertures - the qualities that keep a sans legible at spine size.
  // Inter and IBM Plex Sans are UI-first; Source Sans 3 and Public Sans are
  // public-sector interface faces; Work Sans is a lighter grotesque for contrast.
  { slug: 'inter', family: 'Inter' },
  { slug: 'ibm-plex-sans', family: 'IBM Plex Sans' },
  { slug: 'source-sans-3', family: 'Source Sans 3' },
  { slug: 'public-sans', family: 'Public Sans' },
  { slug: 'work-sans', family: 'Work Sans' },
  // Further serif/slab candidates, built to hold their colour at small sizes.
  { slug: 'lora', family: 'Lora' },
  { slug: 'crimson-pro', family: 'Crimson Pro' },
  { slug: 'newsreader', family: 'Newsreader' },
  { slug: 'fraunces', family: 'Fraunces' },
  { slug: 'domine', family: 'Domine', weights: [400, 700] },
  { slug: 'zilla-slab', family: 'Zilla Slab' },
  { slug: 'roboto-slab', family: 'Roboto Slab' },
  // Further sans candidates: geometric-humanist faces with open apertures.
  { slug: 'figtree', family: 'Figtree' },
  { slug: 'manrope', family: 'Manrope' },
  { slug: 'dm-sans', family: 'DM Sans' },
];

/** Fetched weights for a family unless its `weights` field overrides. */
export const DEFAULT_WEIGHTS = [400, 600];
