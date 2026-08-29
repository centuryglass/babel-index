/**
 * The matrix the lab sweeps: every entry becomes one labelled composite.
 *
 * Two sweeps share one shape so the renderer treats them uniformly:
 *
 *   - FONTS: each candidate face at the settings the app ships today, so the only
 *     thing that changes screen to screen is the typeface. This is the "which
 *     font" question.
 *   - SETTINGS: one face held fixed while a single rendering knob moves - weight,
 *     halo, tracking, size, ink. This is the "having picked a font, how do we set
 *     it" question, and each variant changes exactly one axis off the baseline so
 *     the screenshots read as a controlled A/B.
 *
 * A variant is a complete spec; the renderer never reaches for a default. The
 * fields mirror composeSpines in packages/web/src/center.js one-for-one so a
 * winner can be ported back by copying numbers, not translating them.
 */
import { FONTS } from './fonts.ts';
import type { FontEntry } from './fonts.ts';

export interface FaceRef {
  family: string;
  weight: number;
}

/** Mirrors composeSpines' styling options in packages/web/src/lib/center.ts one-for-one. */
export interface SpineStyle {
  weight: number;
  style: string;
  sizeScale: number; //   fontPx = clamp(minPx, maxPx, floor(spineWidthPx * sizeScale))
  minPx: number;
  maxPx: number;
  ink: string; //         font colour; any rgba
  halo: string | null; // dark outline; null disables it
  haloScale: number; //   lineWidth = max(haloFloor ?? 1.5, fontPx * haloScale)
  haloFloor?: number;
  letterSpacing: number; // px, added between glyphs
  caps: boolean; //       ALL CAPS the titles
  backdrop: boolean; //   draw a rounded black plate per book instead of the outline
  backdropColor: string; // the plate's fill (any rgba)
}

/** One labelled composite the renderer draws. */
export interface Variant extends SpineStyle {
  id: string;
  group: string;
  label: string;
  sub: string;
  fontFamily: string;
  face: FaceRef | null;
}

// The app's current spine styling, from center.js. Every variant starts here and
// overrides a subset, so "baseline" is stated once.
const BASE: SpineStyle = {
  weight: 400,
  style: 'normal',
  sizeScale: 0.82, //   fontPx = clamp(minPx, maxPx, floor(spineWidthPx * sizeScale))
  minPx: 6,
  maxPx: 13,
  ink: 'rgba(238,230,214,0.92)', //  warm gilt (font colour; any rgba)
  halo: 'rgba(12,9,6,0.85)', //      dark outline
  haloScale: 0.2, //                 lineWidth = max(1.5, fontPx * haloScale)  (= fontPx/5)
  letterSpacing: 0, //               px, added between glyphs
  caps: false, //                    ALL CAPS the titles
  backdrop: false, //                draw a rounded black plate per book instead of the outline
  backdropColor: 'rgba(0,0,0,0.55)', // the plate's fill (any rgba)
};

// A readable serif to carry the fallback in every serif variant's font stack.
const SERIF = 'Georgia, serif';

/** The font sweep: one composite per candidate, plus the shipping baseline. */
const fontSweep: Variant[] = [
  {
    id: 'baseline-system-sans',
    group: 'fonts',
    label: 'CURRENT — system sans-serif',
    sub: 'what the app ships today',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    face: null, // no webfont; uses the OS UI face
    ...BASE,
  },
  ...FONTS.map((f) => ({
    id: `font-${f.slug}`,
    group: 'fonts',
    label: f.family,
    sub: 'baseline settings, weight 400',
    fontFamily: `'${f.family}', ${SERIF}`,
    face: { family: f.family, weight: 400 },
    ...BASE,
  })),
];

// The settings sweep runs for every candidate face (plus the shipping system-sans
// baseline), each landing in its own out/settings/<slug>/ subdirectory so the
// per-font composites never clobber one another. "Heavier" variants (set-01,
// set-07) want a non-400 weight; most faces have 600 downloaded (DEFAULT_WEIGHTS),
// but a few (Libre Baskerville, PT Serif, Domine) only ship 400/700, so the bold
// weight is read off the font's own `weights` list rather than assumed.
function boldWeight(weights: number[]): number {
  if (weights.includes(600)) return 600;
  return weights.find((w) => w !== 400) ?? 400;
}

interface SweepFont {
  slug: string;
  family: string | null;
  fontFamily: string;
  bold: number;
}

const settingsFonts: SweepFont[] = [
  {
    slug: 'baseline-system-sans',
    family: null,
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    bold: 600,
  },
  ...FONTS.map((f: FontEntry) => ({
    slug: f.slug,
    family: f.family,
    fontFamily: `'${f.family}', ${SERIF}`,
    bold: boldWeight(f.weights ?? [400, 600]),
  })),
];

/** One-axis-at-a-time variations off the baseline, for a single sweep face. */
function buildSettingsSweep(sf: SweepFont): Variant[] {
  const face = (weight: number): FaceRef | null => (sf.family ? { family: sf.family, weight } : null);
  const label = sf.family ?? 'System sans';
  return [
    {
      id: 'set-00-baseline',
      label: `${label} — baseline`,
      sub: 'weight 400 · halo /5 · no tracking · scale 0.82',
      face: face(400),
    },
    {
      id: 'set-01-weight-bold',
      label: `${label} — weight ${sf.bold}`,
      sub: 'heavier stroke; does gilt hold better?',
      weight: sf.bold,
      face: face(sf.bold),
    },
    {
      id: 'set-02-halo-thin',
      label: `${label} — thin halo`,
      sub: 'lineWidth max(1, fontPx/8)',
      haloScale: 0.125,
      haloFloor: 1,
      face: face(400),
    },
    {
      id: 'set-03-halo-none',
      label: `${label} — no halo`,
      sub: 'fill only, no dark outline',
      halo: null,
      face: face(400),
    },
    {
      id: 'set-04-tracking',
      label: `${label} — +0.4px tracking`,
      sub: 'letters spaced apart for small-size legibility',
      letterSpacing: 0.4,
      face: face(400),
    },
    {
      id: 'set-05-larger',
      label: `${label} — scale 0.95, cap 15`,
      sub: 'fill more of the spine width',
      sizeScale: 0.95,
      maxPx: 15,
      face: face(400),
    },
    {
      id: 'set-06-brighter-ink',
      label: `${label} — brighter ink`,
      sub: 'opaque warm-white gilt',
      ink: 'rgba(246,240,228,1)',
      face: face(400),
    },
    {
      id: 'set-07-weight-bold-tracking',
      label: `${label} — ${sf.bold} + tracking`,
      sub: 'the two small-size tricks together',
      weight: sf.bold,
      letterSpacing: 0.3,
      face: face(sf.bold),
    },
    {
      id: 'set-08-caps',
      label: `${label} — ALL CAPS`,
      sub: 'uppercase reads differently down a spine',
      caps: true,
      face: face(400),
    },
    {
      id: 'set-09-backdrop',
      label: `${label} — backdrop plate`,
      sub: 'rounded black plate per book instead of an outline',
      halo: null,
      backdrop: true,
      face: face(400),
    },
    // The size cap is now a live question: the wider-book tile roughly doubled spine
    // width, so at the baseline maxPx 13 the title stops growing well before the 2x
    // zoom cap - zooming in enlarges the shelf behind the text but not the text. These
    // raise the ceiling so the title fills the wider spine and keeps growing with zoom.
    {
      id: 'set-10-cap-16',
      label: `${label} — cap 16`,
      sub: 'maxPx 16: let the wider spine carry a larger title',
      maxPx: 16,
      face: face(400),
    },
    {
      id: 'set-11-cap-20',
      label: `${label} — cap 20`,
      sub: 'maxPx 20: title grows with zoom to fill the wide spine',
      maxPx: 20,
      face: face(400),
    },
    {
      id: 'set-12-scale-95-cap-18',
      label: `${label} — scale 0.95, cap 18`,
      sub: 'more of the spine width AND a higher ceiling together',
      sizeScale: 0.95,
      maxPx: 18,
      face: face(400),
    },
  ].map((v) => ({
    group: `settings/${sf.slug}`,
    fontFamily: sf.fontFamily,
    ...BASE,
    ...v,
  }));
}

const settingsSweep = settingsFonts.flatMap(buildSettingsSweep);

export const VARIANTS = [...fontSweep, ...settingsSweep];

/** Every (family, weight) the page must load as a FontFace before rendering. */
export const REQUIRED_FACES: FaceRef[] = (() => {
  const seen = new Map<string, FaceRef>();
  for (const v of VARIANTS) {
    if (!v.face) continue;
    const key = `${v.face.family}-${v.face.weight}`;
    if (!seen.has(key)) seen.set(key, v.face);
  }
  return [...seen.values()];
})();
