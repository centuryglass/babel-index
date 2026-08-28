/**
 * The candidate faces for the spine-title experiment, and where to fetch them.
 *
 * Every entry is a free (OFL) Google Fonts family. The six the brief named, plus
 * additions chosen for one reason: spine titles render small (~11-20px now the
 * wider-book tile can carry a larger title), so what matters is not elegance at
 * display size but survival at text size. Bitter and Spectral were drawn for
 * exactly that (a sturdy slab, a screen-first serif); EB Garamond is the
 * counter-example, a thin old-style face, included to see how badly a delicate
 * serif fares that small.
 *
 * We pull two weights of each so the settings sweep can ask whether gilt reads
 * better a touch heavier - tiny light strokes on a bright spine tend to vanish.
 *
 * The system sans baseline (what the app ships today) needs no download; it is
 * declared in variants.mjs by family string alone.
 */
export const FONTS = [
  // The six the brief asked for.
  { slug: 'literata', family: 'Literata' },
  { slug: 'libre-baskerville', family: 'Libre Baskerville', weights: [400, 700] },
  { slug: 'vollkorn', family: 'Vollkorn' },
  { slug: 'pt-serif', family: 'PT Serif', weights: [400, 700] },
  { slug: 'alegreya', family: 'Alegreya' },
  { slug: 'source-serif-4', family: 'Source Serif 4' },
  // Serif additions: two faces built to hold up at text size, one to fail on purpose.
  { slug: 'bitter', family: 'Bitter' },
  { slug: 'spectral', family: 'Spectral' },
  { slug: 'eb-garamond', family: 'EB Garamond' },
  // Sans-serif candidates. Humanist and grotesque faces with strong hinting and
  // open apertures - the qualities that keep a sans legible at spine size. Inter and
  // IBM Plex Sans are UI-first; Source Sans 3 and Public Sans are government/
  // interface workhorses; Work Sans is a lighter grotesque for contrast.
  { slug: 'inter', family: 'Inter' },
  { slug: 'ibm-plex-sans', family: 'IBM Plex Sans' },
  { slug: 'source-sans-3', family: 'Source Sans 3' },
  { slug: 'public-sans', family: 'Public Sans' },
  { slug: 'work-sans', family: 'Work Sans' },
  // Further serif/slab candidates, all OFL text faces built to hold their colour
  // at small sizes - a wider net now that the wider spine can carry a larger title.
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

/** Weights we fetch for a family unless it overrides (some only ship 400/700). */
export const DEFAULT_WEIGHTS = [400, 600];
