/**
 * Measure where CLIP's raw cosine range actually sits on a real corpus.
 *
 * `CLIP_STRENGTH` (`packages/map/scoring.ts`) and `search.density.clipCentre/
 * clipHigh` want numbers read off this corpus's own behaviour, not
 * guessed. This script embeds every line of a keyword list with the same text
 * tower `packages/server/app.ts` loads at search time and scores each vector
 * against every row of a corpus's `embeddings.bin` with the same
 * `embeddingScores()` the app ranks with. Reusing that path is the point: a
 * calibration measured through a different one measures something else.
 *
 * The report holds the overall distribution, one summary per keyword, and the
 * optional probe lists. `cosine-stats.ts` defines what each distribution can
 * answer and how a bound is read off it.
 *
 * Two required inputs, both prepared elsewhere, plus the optional probes:
 *   --embeddings <dir>   a directory holding embeddings.bin + embeddings.json,
 *                        as written by tools/embed/embed.ts
 *   --keywords <file>    a text file, one keyword or phrase per line
 *   --universal <file>   keywords true of nearly every room (e.g. "bookshelf"
 *                        for a library corpus) - the high extreme
 *   --irrelevant <file>  keywords with nothing to do with the corpus (e.g.
 *                        "race car", "swimming pool") - the low extreme
 *   --nonsense <file>    keysmash/nonsense queries - validation only
 * `docs/search_rules.md` "Image-content (CLIP) matching" names both extremes.
 *
 * Run:
 *   node --import ./build/register.mjs tools/embed/cosine-range.ts \
 *     --embeddings <dir> --keywords <file> \
 *     [--universal <file>] [--irrelevant <file>] [--nonsense <file>] \
 *     [--out report.json] [--low-percentile 90] [--high-percentile 50]
 *
 * Emits a JSON report (--out, default ./cosine-range-report.json) with the full
 * percentile tables, per-keyword stats, and a suggested clipLow/clipHigh, and
 * prints a shorter version of the same to the console. See `suggestClipBounds`
 * for what that pair is read off, and what it is not.
 *
 * The expensive part is the text tower, not the arithmetic: a few thousand
 * cosines per keyword is a few million multiply-adds total, well under a second,
 * but embedding a few thousand keyword strings is a few thousand forward passes.
 * Batched the way tools/embed/embed.ts batches images.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { embeddingScores } from '../../packages/map/ordering.ts';
import {
  summarize,
  suggestClipBounds,
  summarizeUniversal,
  type Summary,
  type KeywordSummary,
  type ClipBoundsSuggestion,
  type UniversalCalibration,
} from './cosine-stats.ts';

const BATCH = 32;
const SHOW_EXTREMES = 10;

/** A corpus's embedding blob, with the `embeddings.json` fields that describe it. */
interface EmbeddingSet {
  embeddings: Int8Array;
  dim: number;
  count: number;
  model: string;
  scale: number;
}

/** The JSON written to `--out`, and the shape the console summary reads. */
interface Report {
  generatedAt: string;
  model: string;
  rooms: number;
  keywords: number;
  /** Every keyword against every room: the noise band, and its centre. */
  overall: Summary;
  /** Each keyword's best cosine anywhere in the corpus: the match band. */
  keywordMax: Summary;
  /** Each keyword's own mean: how far apart keywords sit from each other. */
  keywordMean: Summary;
  /** Each keyword's max - min: how much a keyword separates the corpus. */
  keywordRange: Summary;
  /** The coarse percentile pair - see `suggestClipBounds`. */
  suggestion: ClipBoundsSuggestion;
  /** The high extreme: `summarizeUniversal` over the `--universal` list. */
  universal: UniversalCalibration | null;
  /**
   * The low extreme: `summarizeUniversal` over the `--irrelevant` list, known
   * concepts that share nothing with this corpus (a "swimming pool" query
   * against a library). One function serves both extremes because only the
   * list's meaning changes, not the arithmetic.
   */
  irrelevant: UniversalCalibration | null;
  /**
   * Validation only, never a formula input: the `--nonsense` pool scored the same
   * way `overall` is, expected to sit in `overall`'s centre band since both are
   * readings of no real signal. Reported beside it so agreement needs no extra
   * arithmetic.
   */
  nonsense: Summary | null;
  perKeyword: KeywordSummary[];
}

function parseArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const eq = args[i].indexOf('=');
    if (eq > -1) out[args[i].slice(2, eq)] = args[i].slice(eq + 1);
    else out[args[i].slice(2)] = args[++i];
  }
  return out;
}

/**
 * Read embeddings.bin + embeddings.json from a directory written by
 * tools/embed/embed.ts.
 *
 * A byte count that is not `count x dim` is refused: rows are positional, so a
 * short or over-long blob would misalign every row after the gap.
 */
async function loadEmbeddings(dir: string): Promise<EmbeddingSet> {
  const json = JSON.parse(await readFile(join(dir, 'embeddings.json'), 'utf8'));
  const bin = await readFile(join(dir, 'embeddings.bin'));
  const embeddings = new Int8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  const expected = json.count * json.dim;
  if (embeddings.length !== expected)
    throw new Error(
      `${dir}/embeddings.bin has ${embeddings.length} bytes, expected ${expected} ` +
        `(count ${json.count} x dim ${json.dim}) - stale or mismatched blob?`
    );
  return { embeddings, dim: json.dim, count: json.count, model: json.model, scale: json.scale };
}

/** One trimmed, non-empty, de-duplicated keyword per line. */
async function loadKeywords(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8');
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    keywords.push(line);
  }
  return keywords;
}

/**
 * The CLIP text tower, loaded once.
 *
 * A dynamic import because the package is optional (AGENTS.md,
 * "@huggingface/transformers is OPTIONAL"). `packages/server/app.ts`'s
 * `hasTextModel()` carries the platform detail, and its `textTower()` is the
 * lazy load this mirrors.
 *
 * Both members are typed `any`: never imported statically, so there is no type to
 * import either.
 */
async function loadTextTower(model: string): Promise<{ tokenizer: any; textModel: any }> {
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch (err: any) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    throw Object.assign(new Error(
      'This tool needs @huggingface/transformers, which is an optional dependency and is ' +
        'not installed here (it pulls in onnxruntime-node, which does not publish for every ' +
        'platform - see tools/embed/embed.ts). Run this on a machine where it installed.'
    ), { expected: true });
  }
  const { AutoTokenizer, CLIPTextModelWithProjection } = transformers as any;
  const [tokenizer, textModel] = await Promise.all([
    AutoTokenizer.from_pretrained(model),
    CLIPTextModelWithProjection.from_pretrained(model, { dtype: 'fp32' }),
  ]);
  return { tokenizer, textModel };
}

/**
 * L2-normalise one embedded string, the way `embedQuery` (packages/server/app.ts)
 * prepares a live query and `quantiseInto` (tools/embed/embed.ts) an image row.
 */
function normalise(row: ArrayLike<number>): Float32Array {
  let norm = 0;
  for (let i = 0; i < row.length; i++) norm += row[i] * row[i];
  norm = Math.sqrt(norm) || 1;
  const out = Float32Array.from(row);
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Embed a batch of strings, one L2-normalised query vector per string. */
async function embedBatch(tokenizer: any, textModel: any, strings: string[]): Promise<Float32Array[]> {
  const inputs = tokenizer(strings, { padding: true, truncation: true });
  const { text_embeds } = await textModel(inputs);
  return text_embeds.tolist().map(normalise);
}

/**
 * Embed and score every string in `list` against the corpus, in `BATCH` chunks.
 *
 * `overall` is the flat keyword x room pool - `count` cosines per keyword, in
 * list order - and `perKeyword` each keyword's own summary of the same numbers.
 *
 * @param label tag on the per-chunk progress line
 */
async function scoreList(
  tokenizer: any,
  textModel: any,
  embeddings: Int8Array,
  dim: number,
  scale: number,
  count: number,
  list: string[],
  label: string
): Promise<{ perKeyword: KeywordSummary[]; overall: Float32Array }> {
  const perKeyword: KeywordSummary[] = new Array(list.length);
  const overall = new Float32Array(count * list.length);
  for (let start = 0; start < list.length; start += BATCH) {
    const chunk = list.slice(start, start + BATCH);
    const vectors = await embedBatch(tokenizer, textModel, chunk);
    vectors.forEach((vector, i) => {
      const k = start + i;
      const cosines = embeddingScores(embeddings, dim, scale, vector);
      overall.set(cosines, k * count);
      perKeyword[k] = { keyword: chunk[i], ...summarize(cosines) };
    });
    console.log(`  [${label}] ${Math.min(start + BATCH, list.length)}/${list.length}`);
  }
  return { perKeyword, overall };
}

function printPercentiles(label: string, stats: Summary) {
  const row = Object.entries(stats.percentiles)
    .map(([k, v]) => `${k}=${v.toFixed(3)}`)
    .join('  ');
  console.log(
    `${label}: n=${stats.count} min=${stats.min.toFixed(3)} max=${stats.max.toFixed(3)} ` +
      `mean=${stats.mean.toFixed(3)} std=${stats.std.toFixed(3)}`
  );
  console.log(`  ${row}`);
}

function printSummary(report: Report) {
  console.log('');
  console.log(`${report.rooms} rooms x ${report.keywords} keywords, model ${report.model}`);
  console.log('');
  console.log('Overall (every keyword x every room - mostly unrelated pairs, the noise band):');
  printPercentiles('  overall', report.overall);
  console.log('');
  console.log("Per keyword, each keyword's own best-matching room (the match band):");
  printPercentiles('  keywordMax', report.keywordMax);
  console.log('');
  console.log('How much keywords differ from each other:');
  printPercentiles('  keywordMean (typical cosine per keyword)', report.keywordMean);
  printPercentiles('  keywordRange (max - min per keyword)', report.keywordRange);
  console.log('');

  const byMax = [...report.perKeyword].sort((a, b) => b.max - a.max);
  console.log(`Strongest ${SHOW_EXTREMES} keywords by best match:`);
  for (const k of byMax.slice(0, SHOW_EXTREMES))
    console.log(`  ${k.max.toFixed(3)}  ${k.keyword}`);
  console.log(`Weakest ${SHOW_EXTREMES} keywords by best match:`);
  for (const k of byMax.slice(-SHOW_EXTREMES).reverse())
    console.log(`  ${k.max.toFixed(3)}  ${k.keyword}`);
  console.log('');

  const s = report.suggestion;
  console.log(
    `Coarse percentile pair: clipLow=${s.clipLow.toFixed(3)} (overall p${s.lowPercentile}), ` +
      `clipHigh=${s.clipHigh.toFixed(3)} (keywordMax p${s.highPercentile}) - ` +
      'not the calibration method, see suggestClipBounds; read against the anchors below.'
  );
  for (const note of s.notes) console.log(`  ! ${note}`);

  if (report.universal) {
    const u = report.universal;
    console.log('');
    console.log('Universal-keyword calibration (known-true-of-nearly-every-room terms):');
    for (const k of u.byKeyword)
      console.log(`  ${k.keyword}: p${u.floorPercentile}=${k.floor.toFixed(3)}  p${u.ceilingPercentile}=${k.ceiling.toFixed(3)}`);
    console.log(`  floor=${u.floor.toFixed(3)}  ceiling=${u.ceiling.toFixed(3)}`);
    for (const note of u.notes) console.log(`  ! ${note}`);
  }

  if (report.irrelevant) {
    const i = report.irrelevant;
    console.log('');
    console.log('Irrelevant-concept calibration (known-to-have-nothing-to-do-with-this-corpus terms) - the low extreme:');
    for (const k of i.byKeyword)
      console.log(`  ${k.keyword}: p${i.floorPercentile}=${k.floor.toFixed(3)}  p${i.ceilingPercentile}=${k.ceiling.toFixed(3)}`);
    console.log(`  floor=${i.floor.toFixed(3)}  ceiling=${i.ceiling.toFixed(3)}`);
    for (const note of i.notes) console.log(`  ! ${note}`);
  }

  if (report.universal && report.irrelevant) {
    console.log('');
    console.log(
      'Calibration anchors (docs/search_rules.md, "Image-content (CLIP) matching"): ' +
        `centre=${report.overall.percentiles.p50.toFixed(3)} (overall p50), ` +
        `high=${report.universal.ceiling.toFixed(3)} (universal ceiling), ` +
        `low=${report.irrelevant.ceiling.toFixed(3)} (irrelevant ceiling) - ` +
        'expected below centre, since the corpus shares nothing with these keywords.'
    );
  }

  if (report.nonsense) {
    const n = report.nonsense;
    console.log('');
    console.log('Nonsense/keysmash validation (should agree with the overall centre, not calibrate anything):');
    printPercentiles('  nonsense', n);
    const centre = report.overall.percentiles.p50;
    const drift = Math.abs(n.mean - centre);
    console.log(`  overall centre p50=${centre.toFixed(3)}, nonsense mean=${n.mean.toFixed(3)} (drift ${drift.toFixed(3)})`);
    if (drift > 0.02) console.log('  ! nonsense drifts more than 0.02 from the overall centre - worth a closer look');
  }

  console.log('The anchors above are the calibration answer; the percentile tables are how to sanity-check them.');
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const embeddingsDir = argv.embeddings ?? 'assets/corpus-sample';
  const keywordsFile = argv.keywords;
  if (!keywordsFile) throw new Error('--keywords <file> is required (one keyword or phrase per line)');
  const outFile = argv.out ?? 'cosine-range-report.json';
  const lowPercentile = argv['low-percentile'] !== undefined ? Number(argv['low-percentile']) : undefined;
  const highPercentile = argv['high-percentile'] !== undefined ? Number(argv['high-percentile']) : undefined;

  const { embeddings, dim, scale, count, model } = await loadEmbeddings(embeddingsDir);
  const keywords = await loadKeywords(keywordsFile);
  if (!keywords.length) throw new Error(`no keywords found in ${keywordsFile}`);
  const universalWords = argv.universal ? await loadKeywords(argv.universal) : [];
  const irrelevantWords = argv.irrelevant ? await loadKeywords(argv.irrelevant) : [];
  const nonsenseWords = argv.nonsense ? await loadKeywords(argv.nonsense) : [];
  console.log(
    `${count} rooms, ${keywords.length} keywords` +
      (universalWords.length ? ` + ${universalWords.length} universal` : '') +
      (irrelevantWords.length ? ` + ${irrelevantWords.length} irrelevant` : '') +
      (nonsenseWords.length ? ` + ${nonsenseWords.length} nonsense` : '') +
      `, model ${model}`
  );

  const { tokenizer, textModel } = await loadTextTower(model);

  const { perKeyword, overall } = await scoreList(
    tokenizer, textModel, embeddings, dim, scale, count, keywords, 'keywords'
  );

  const keywordMax = Float64Array.from(perKeyword, (k) => k.max);
  const keywordMean = Float64Array.from(perKeyword, (k) => k.mean);
  const keywordRange = Float64Array.from(perKeyword, (k) => k.max - k.min);

  const suggestion = suggestClipBounds({ overall, keywordMax }, { lowPercentile, highPercentile });

  let universal: UniversalCalibration | null = null;
  if (universalWords.length) {
    const { perKeyword: universalPerKeyword } = await scoreList(
      tokenizer, textModel, embeddings, dim, scale, count, universalWords, 'universal'
    );
    universal = summarizeUniversal(universalPerKeyword);
  }

  let irrelevant: UniversalCalibration | null = null;
  if (irrelevantWords.length) {
    const { perKeyword: irrelevantPerKeyword } = await scoreList(
      tokenizer, textModel, embeddings, dim, scale, count, irrelevantWords, 'irrelevant'
    );
    irrelevant = summarizeUniversal(irrelevantPerKeyword);
  }

  let nonsense: Summary | null = null;
  if (nonsenseWords.length) {
    const { overall: nonsenseOverall } = await scoreList(
      tokenizer, textModel, embeddings, dim, scale, count, nonsenseWords, 'nonsense'
    );
    nonsense = summarize(nonsenseOverall);
  }

  const report: Report = {
    generatedAt: new Date().toISOString(),
    model,
    rooms: count,
    keywords: keywords.length,
    overall: summarize(overall),
    keywordMax: summarize(keywordMax),
    keywordMean: summarize(keywordMean),
    keywordRange: summarize(keywordRange),
    suggestion,
    universal,
    irrelevant,
    nonsense,
    perKeyword,
  };

  await writeFile(outFile, JSON.stringify(report, null, 2) + '\n');
  printSummary(report);
  console.log('');
  console.log(`wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err?.expected ? err.message : err);
  process.exit(1);
});
