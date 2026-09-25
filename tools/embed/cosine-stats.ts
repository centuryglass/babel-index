/**
 * Descriptive statistics for CLIP cosine samples - min/max/mean/std/percentiles
 * over one array, and the arithmetic `cosine-range.ts` uses to turn a measured
 * distribution into a calibration number.
 *
 * Pure, no filesystem, no model: what `cosine-range.ts` measures, this states
 * how, so the arithmetic is testable without a corpus or a network connection to
 * download CLIP.
 *
 * ### What each distribution answers
 *
 * `overall` - every keyword against every room. Across a few thousand of each,
 * most pairs are unrelated (`gothic` genuinely describes a handful of rooms out
 * of a couple thousand), so its centre is the band a query with no real signal
 * lands in.
 *
 * `keywordMax` - one number per keyword, the top cosine it reached anywhere in
 * the corpus: what "as sure as it gets" looks like for a keyword that has some
 * purchase on the corpus.
 *
 * A known-outcome list - `summarizeUniversal` - answers a third question. The
 * two above assume nobody knows which keyword truly describes which room, so
 * their bounds are percentile cuts of a pool that mixes real matches in with
 * unrelated pairs. A word true of nearly every room (`bookshelf`, for a corpus
 * of library walls) is a real positive match for close to the whole corpus, and
 * a concept CLIP recognises that shares nothing with it (`swimming pool`) is a
 * known negative. Either list's own distribution measures what a genuine match
 * or a genuine miss looks like, rather than where a mixed pool thins out.
 *
 * The shipped anchors are `CLIP_STRENGTH`'s `centre` and `high`; its docblock
 * in packages/map/scoring.ts says which of these measurements each one reads.
 * `docs/search_rules.md` "Image-content (CLIP) matching" is where they are used.
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

/** A suggested pair, with the percentiles that produced it echoed so a stored
 *  report still says which cut each number came from. */
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

/**
 * The two bands `summarizeUniversal` reports for a known-outcome keyword list.
 * The anchors the app ships are ceilings - see `CLIP_STRENGTH`; the floor is
 * reported alongside, as the low end of the same measurement.
 */
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
 * Sorts a COPY. `values` is never mutated, so a caller can keep using the array
 * after summarizing it - `cosine-range.ts`'s per-keyword cosines are also its
 * overall pool.
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
 * Turn two measured distributions into a coarse clipLow/clipHigh pair: a high
 * percentile of `overall` as the noise floor, a middling percentile of
 * `keywordMax` as a typical best match.
 *
 * A first read off the shape of the corpus, not what the app ships: the anchors
 * in `CLIP_STRENGTH` are read off a known-outcome list instead. The pair's
 * names are not config keys. `search.density` has no `clipLow`, and its
 * `clipHigh` defaults to `CLIP_STRENGTH.high`, which `summarizeUniversal`'s
 * ceiling measures, not this `clipHigh`. Do not promote
 * `clipLow` to a strength floor on its own - a high percentile of `overall`
 * assumes most pairs are unrelated, and a common word that is genuinely true of
 * many rooms (`book`) scores below such a cutoff on correct matches.
 *
 * `valid: false` means the two bands overlap at the chosen percentiles on this
 * corpus - a real possible outcome for a small or generic keyword list, or a
 * corpus CLIP finds hard to tell apart, and worth seeing rather than papering
 * over with an arbitrary widening.
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
 * Calibrate against a known-outcome keyword list, where an outcome is measured
 * rather than inferred from distribution shape.
 *
 * `floor` is the minimum, across every keyword, of that keyword's own
 * `floorPercentile`; `ceiling` is the median of each keyword's own
 * `ceilingPercentile` - a typical rather than a worst-case reading of "about as
 * sure as a real match gets", the same role `keywordMax`'s median plays for
 * `suggestClipBounds`.
 *
 * The min/median split answers one hazard: CLIP's cosine scale is not
 * comparable across strings, since a longer or differently-tokenised phrase
 * shifts a whole distribution up or down for reasons unrelated to how true it
 * is. So the floor is only trustworthy if every phrasing tried clears it, and a
 * single keyword's scale is never trusted for either number.
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
