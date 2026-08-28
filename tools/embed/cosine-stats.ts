/**
 * Descriptive statistics for CLIP cosine samples - min/max/mean/std/percentiles
 * over one array, and turning two of those distributions into a clipLow/clipHigh
 * suggestion.
 *
 * Pure, no filesystem, no model - what `cosine-range.ts` computes, this states
 * how, so the arithmetic is testable without a corpus or a network connection to
 * download CLIP.
 *
 * ### Why the low/high bounds come from two different distributions
 *
 * `search.density.clipLow` in `packages/config/config.ts` wants "the cosine at
 * which CLIP starts saying something about this corpus at all" - and across a
 * few thousand keywords against a few thousand rooms, most PAIRS are unrelated
 * (a keyword like `gothic` genuinely describes a handful of rooms out of a
 * couple thousand), so the bulk of the overall keyword x room distribution IS
 * the "unrelated" baseline. A high percentile of it - the edge most unrelated
 * pairs never cross - is a reasonable read of where noise ends.
 *
 * `clipHigh` wants the opposite question: "when a keyword genuinely has
 * something to point at, how high does CLIP go". The overall distribution
 * cannot answer that - it is dominated by noise - but each keyword's OWN best
 * match can: `keywordMax` is one number per keyword, the top cosine it reached
 * anywhere in the corpus, and a middling percentile of THAT distribution is a
 * measurement of what "as sure as it gets" typically looks like, once a keyword
 * with any purchase on the corpus is doing the asking.
 *
 * Neither is exact - there is no ground truth pairing a keyword to the rooms it
 * "should" match - but both are read off the real corpus and the real keyword
 * list rather than assumed. `docs/search_rules.md` is where these numbers get
 * used, and where the "universal keyword" idea below is spent.
 *
 * ### Universal keywords, a third calibration
 *
 * `overall` and `keywordMax` both assume that whether a keyword genuinely
 * applies to a room is unknown - there is no ground truth to check against, so
 * both bounds are read off distribution shape rather than known outcomes. A
 * word that is true of nearly every room (`bookshelf`, for a corpus of library
 * walls) is the one case where the outcome IS known: it is a real positive
 * match for something close to the whole corpus, not a handful of rooms out of
 * a couple thousand. Its own cosine distribution is therefore a direct
 * measurement of "what does a real match look like", rather than a percentile
 * cut of a distribution that mixes real matches into a sea of unrelated ones.
 *
 * The caveat is that CLIP's cosine scale is not comparable across different
 * strings - a longer or differently-tokenised phrase shifts the whole
 * distribution up or down for reasons that have nothing to do with how true it
 * is. `summarizeUniversal` below is deliberately conservative about this: it
 * takes the LOWEST float across every universal keyword's own low percentile as
 * the floor (the weakest a genuine match has been observed to score, across
 * several different phrasings) rather than trusting any single keyword's scale.
 */

/** The percentiles a report prints, at the resolution worth reading by eye. */
export const REPORT_PERCENTILES = [1, 5, 10, 25, 50, 75, 90, 95, 99];

export interface Summary {
  count: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  percentiles: Record<string, number>;
}

export interface ClipBoundsSuggestion {
  clipLow: number;
  clipHigh: number;
  lowPercentile: number;
  highPercentile: number;
  valid: boolean;
  notes: string[];
}

/** A keyword's own summary, as `cosine-range.ts` computes for every keyword. */
export interface KeywordSummary extends Summary {
  keyword: string;
}

export interface UniversalCalibration {
  floor: number;
  ceiling: number;
  floorPercentile: number;
  ceilingPercentile: number;
  byKeyword: { keyword: string; floor: number; ceiling: number }[];
  notes: string[];
}

/**
 * Linear-interpolated percentile (the common "R-7"/numpy-default method) over
 * an array already sorted ascending.
 *
 * @param p in [0, 100]
 */
export function percentileOf(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[n - 1];
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/**
 * Mean, population standard deviation, and a percentile table for one array of
 * samples. Population std (dividing by `n`, not `n - 1`): these are the whole
 * set of cosines for a keyword or a corpus, not a sample standing in for one.
 *
 * Sorts a COPY - `values` is never mutated, so a caller can reuse the array it
 * passed in (`cosine-range.ts` does, for the per-room breakdown of one keyword).
 */
export function summarize(values: ArrayLike<number>, percentiles: number[] = REPORT_PERCENTILES): Summary {
  const n = values.length;
  if (!n) return { count: 0, min: NaN, max: NaN, mean: NaN, std: NaN, percentiles: {} };

  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;

  let sq = 0;
  for (let i = 0; i < n; i++) sq += (values[i] - mean) ** 2;
  const std = Math.sqrt(sq / n);

  const sorted = Float64Array.from(values).sort();
  const table: Record<string, number> = {};
  for (const p of percentiles) table[`p${p}`] = percentileOf(sorted, p);

  return { count: n, min: sorted[0], max: sorted[n - 1], mean, std, percentiles: table };
}

/**
 * Turn two measured distributions into a clipLow/clipHigh starting point.
 *
 * A suggestion, not an answer - see the file header for what each bound is read
 * off and why. `valid: false` means the two bands overlap at the chosen
 * percentiles on this corpus, which is a real possible outcome (a small or
 * generic keyword list, or a corpus CLIP finds hard to tell apart) worth seeing
 * rather than papering over with an arbitrary widening.
 *
 * @param opts.lowPercentile percentile of `overall` for clipLow (default 90)
 * @param opts.highPercentile percentile of `keywordMax` for clipHigh (default 50)
 */
export function suggestClipBounds(
  { overall, keywordMax }: { overall: ArrayLike<number>; keywordMax: ArrayLike<number> },
  { lowPercentile = 90, highPercentile = 50 }: { lowPercentile?: number; highPercentile?: number } = {}
): ClipBoundsSuggestion {
  const notes: string[] = [];
  const sortedOverall = Float64Array.from(overall).sort();
  const sortedMax = Float64Array.from(keywordMax).sort();

  const clipLow = percentileOf(sortedOverall, lowPercentile);
  const clipHigh = percentileOf(sortedMax, highPercentile);

  const valid = clipHigh > clipLow;
  if (!valid)
    notes.push(
      `p${highPercentile} of each keyword's best match (${clipHigh.toFixed(3)}) does not clear ` +
        `p${lowPercentile} of the overall distribution (${clipLow.toFixed(3)}) - the two bands ` +
        'overlap on this corpus. Read the percentile tables in the report and pick bounds by hand ' +
        'rather than trusting this pair.'
    );

  return { clipLow, clipHigh, lowPercentile, highPercentile, valid, notes };
}

/**
 * Calibrate against keywords known (not merely assumed) to be true of nearly
 * every room, rather than off distribution shape alone.
 *
 * `floor` is the minimum, across every universal keyword, of that keyword's own
 * `floorPercentile` - conservative on purpose, since two different phrasings of
 * "there are books here" can sit at noticeably different absolute cosines (see
 * the file header), and the floor is only trustworthy if every phrasing tried
 * clears it. `ceiling` is the median of each keyword's own `ceilingPercentile`,
 * a typical rather than a worst-case reading of "about as sure as a real match
 * gets", the same role `keywordMax`'s median plays for the ordinary suggestion.
 */
export function summarizeUniversal(
  entries: { keyword: string; percentiles: Record<string, number> }[],
  { floorPercentile = 10, ceilingPercentile = 50 }: { floorPercentile?: number; ceilingPercentile?: number } = {}
): UniversalCalibration {
  if (!entries.length)
    return {
      floor: NaN,
      ceiling: NaN,
      floorPercentile,
      ceilingPercentile,
      byKeyword: [],
      notes: ['no universal keywords supplied'],
    };

  const floorKey = `p${floorPercentile}`;
  const ceilingKey = `p${ceilingPercentile}`;
  const byKeyword = entries.map((e) => ({
    keyword: e.keyword,
    floor: e.percentiles[floorKey],
    ceiling: e.percentiles[ceilingKey],
  }));

  const floor = Math.min(...byKeyword.map((k) => k.floor));
  const ceilings = Float64Array.from(byKeyword.map((k) => k.ceiling)).sort();
  const ceiling = percentileOf(ceilings, 50);

  const notes: string[] = [];
  const spread = Math.max(...byKeyword.map((k) => k.ceiling)) - Math.min(...byKeyword.map((k) => k.ceiling));
  if (spread > 0.05)
    notes.push(
      `universal keywords disagree by ${spread.toFixed(3)} at p${ceilingPercentile} - CLIP's cosine ` +
        'scale is keyword-string-dependent, so a single-keyword calibration would not have been safe ' +
        'to trust; this is why floor/ceiling are the min/median across all of them, not one keyword.'
    );
  if (!(ceiling > floor))
    notes.push(`ceiling ${ceiling.toFixed(3)} does not clear floor ${floor.toFixed(3)} - pick bounds by hand.`);

  return { floor, ceiling, floorPercentile, ceilingPercentile, byKeyword, notes };
}
