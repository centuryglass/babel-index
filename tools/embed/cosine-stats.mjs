/**
 * Descriptive statistics for CLIP cosine samples - min/max/mean/std/percentiles
 * over one array, and turning two of those distributions into a clipLow/clipHigh
 * suggestion.
 *
 * Pure, no filesystem, no model - what `cosine-range.mjs` computes, this states
 * how, so the arithmetic is testable without a corpus or a network connection to
 * download CLIP.
 *
 * ### Why the low/high bounds come from two different distributions
 *
 * `search.density.clipLow` in `packages/config/config.mjs` wants "the cosine at
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
 * list rather than assumed, which is what the open question in
 * docs/implementation-plan.md §7 asks for.
 */

/** The percentiles a report prints, at the resolution worth reading by eye. */
export const REPORT_PERCENTILES = [1, 5, 10, 25, 50, 75, 90, 95, 99];

/**
 * Linear-interpolated percentile (the common "R-7"/numpy-default method) over
 * an array already sorted ascending.
 *
 * @param {ArrayLike<number>} sorted
 * @param {number} p in [0, 100]
 */
export function percentileOf(sorted, p) {
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
 * passed in (`cosine-range.mjs` does, for the per-room breakdown of one keyword).
 *
 * @param {ArrayLike<number>} values
 * @param {number[]} [percentiles]
 * @returns {{count:number, min:number, max:number, mean:number, std:number,
 *            percentiles:Record<string, number>}}
 */
export function summarize(values, percentiles = REPORT_PERCENTILES) {
  const n = values.length;
  if (!n) return { count: 0, min: NaN, max: NaN, mean: NaN, std: NaN, percentiles: {} };

  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;

  let sq = 0;
  for (let i = 0; i < n; i++) sq += (values[i] - mean) ** 2;
  const std = Math.sqrt(sq / n);

  const sorted = Float64Array.from(values).sort();
  const table = {};
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
 * @param {{overall: ArrayLike<number>, keywordMax: ArrayLike<number>}} dists
 * @param {object} [opts]
 * @param {number} [opts.lowPercentile] percentile of `overall` for clipLow (default 90)
 * @param {number} [opts.highPercentile] percentile of `keywordMax` for clipHigh (default 50)
 * @returns {{clipLow:number, clipHigh:number, lowPercentile:number,
 *            highPercentile:number, valid:boolean, notes:string[]}}
 */
export function suggestClipBounds(
  { overall, keywordMax },
  { lowPercentile = 90, highPercentile = 50 } = {}
) {
  const notes = [];
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
