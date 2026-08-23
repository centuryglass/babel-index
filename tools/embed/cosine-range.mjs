/**
 * Measure where CLIP's raw cosine range actually sits on a real corpus.
 *
 * `search.density.clipLow/clipHigh` (packages/config/config.mjs, sourced from
 * `CLIP_CERTAINTY` in packages/map/scoring.js) are read off what ViT-B/32
 * typically does on natural photographs, not measured against this corpus - see
 * the open question in docs/implementation-plan.md §7. This script is the
 * measurement it asks for: embed every line of a keyword list with the same
 * text tower `packages/server/app.mjs` uses at search time, score each one
 * against every row of a corpus's `embeddings.bin` with the exact
 * `embeddingScores()` the app ranks with, and report the distribution - overall,
 * and per keyword - so a clipLow/clipHigh choice can be read off real numbers
 * instead of the "0.10-0.15 for natural photographs" starting point.
 *
 * Two inputs, both prepared elsewhere:
 *   --embeddings <dir>  a directory holding embeddings.bin + embeddings.json,
 *                       as written by tools/embed/embed.mjs
 *   --keywords <file>   a text file, one keyword or phrase per line
 *
 * Run:
 *   node tools/embed/cosine-range.mjs --embeddings <dir> --keywords <file>
 *   node tools/embed/cosine-range.mjs --embeddings <dir> --keywords <file> \
 *     --out report.json --low-percentile 90 --high-percentile 50
 *
 * Emits a JSON report (--out, default ./cosine-range-report.json) with the full
 * percentile tables, per-keyword stats, and a suggested clipLow/clipHigh - and
 * prints a shorter version of the same to the console. The suggestion is a
 * starting point; see cosine-stats.mjs for what it is read off and why.
 *
 * The expensive part is the text tower, not the arithmetic: a few thousand
 * cosines per keyword is a few million multiply-adds total, well under a
 * second, but embedding a few thousand keyword strings is a few thousand
 * forward passes. Batched the same way tools/embed/embed.mjs batches images.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { embeddingScores } from '../../packages/map/ordering.js';
import { summarize, suggestClipBounds } from './cosine-stats.mjs';

const BATCH = 32;
const SHOW_EXTREMES = 10;

function parseArgs(args) {
  const out = {};
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
 * tools/embed/embed.mjs. Checked against a stale or mismatched blob the same
 * way scan.mjs checks it - a byte count that does not match `count x dim`
 * would silently misalign every row.
 */
async function loadEmbeddings(dir) {
  const json = JSON.parse(await readFile(join(dir, 'embeddings.json'), 'utf8'));
  const bin = await readFile(join(dir, 'embeddings.bin'));
  const embeddings = new Int8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  const expected = json.count * json.dim;
  if (embeddings.length !== expected)
    throw new Error(
      `${dir}/embeddings.bin has ${embeddings.length} bytes, expected ${expected} ` +
        `(count ${json.count} x dim ${json.dim}) - stale or mismatched blob?`
    );
  return { embeddings, dim: json.dim, count: json.count, model: json.model };
}

/** One trimmed, non-empty, de-duplicated keyword per line. */
async function loadKeywords(file) {
  const text = await readFile(file, 'utf8');
  const seen = new Set();
  const keywords = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    keywords.push(line);
  }
  return keywords;
}

/**
 * The CLIP text tower, loaded once. Dynamic import, same reason as
 * `packages/server/app.mjs`'s `textTower()`: `@huggingface/transformers` is an
 * optional dependency, and the failure is worth explaining rather than
 * rethrowing as a bare module-resolution stack.
 */
async function loadTextTower(model) {
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    throw Object.assign(new Error(
      'This tool needs @huggingface/transformers, which is an optional dependency and is ' +
        'not installed here (it pulls in onnxruntime-node, which does not publish for every ' +
        'platform - see tools/embed/embed.mjs). Run this on a machine where it installed.'
    ), { expected: true });
  }
  const { AutoTokenizer, CLIPTextModelWithProjection } = transformers;
  const [tokenizer, textModel] = await Promise.all([
    AutoTokenizer.from_pretrained(model),
    CLIPTextModelWithProjection.from_pretrained(model, { dtype: 'fp32' }),
  ]);
  return { tokenizer, textModel };
}

/** L2-normalise one row, matching how both `embed.mjs` and `app.mjs` prepare a vector. */
function normalise(row) {
  let norm = 0;
  for (const x of row) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  const out = Float32Array.from(row);
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Embed a batch of strings, one L2-normalised query vector per string. */
async function embedBatch(tokenizer, textModel, strings) {
  const inputs = tokenizer(strings, { padding: true, truncation: true });
  const { text_embeds } = await textModel(inputs);
  return text_embeds.tolist().map(normalise);
}

function printPercentiles(label, stats) {
  const row = Object.entries(stats.percentiles)
    .map(([k, v]) => `${k}=${v.toFixed(3)}`)
    .join('  ');
  console.log(
    `${label}: n=${stats.count} min=${stats.min.toFixed(3)} max=${stats.max.toFixed(3)} ` +
      `mean=${stats.mean.toFixed(3)} std=${stats.std.toFixed(3)}`
  );
  console.log(`  ${row}`);
}

function printSummary(report) {
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
    `Suggested clipLow=${s.clipLow.toFixed(3)} (overall p${s.lowPercentile}), ` +
      `clipHigh=${s.clipHigh.toFixed(3)} (keywordMax p${s.highPercentile})`
  );
  for (const note of s.notes) console.log(`  ! ${note}`);
  console.log('A starting point - read the percentile tables above before trusting it.');
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const embeddingsDir = argv.embeddings ?? 'assets/corpus-sample';
  const keywordsFile = argv.keywords;
  if (!keywordsFile) throw new Error('--keywords <file> is required (one keyword or phrase per line)');
  const outFile = argv.out ?? 'cosine-range-report.json';
  const lowPercentile = argv['low-percentile'] !== undefined ? Number(argv['low-percentile']) : undefined;
  const highPercentile = argv['high-percentile'] !== undefined ? Number(argv['high-percentile']) : undefined;

  const { embeddings, dim, count, model } = await loadEmbeddings(embeddingsDir);
  const keywords = await loadKeywords(keywordsFile);
  if (!keywords.length) throw new Error(`no keywords found in ${keywordsFile}`);
  console.log(`${count} rooms, ${keywords.length} keywords, model ${model}`);

  const { tokenizer, textModel } = await loadTextTower(model);

  // One flat array of every keyword x room cosine, filled batch by batch. A
  // few thousand keywords against a few thousand rooms is tens of millions of
  // floats at most - comfortably in memory for an offline job that needs to see
  // every pair to report the overall distribution honestly.
  const overall = new Float32Array(count * keywords.length);
  const perKeyword = new Array(keywords.length);

  for (let start = 0; start < keywords.length; start += BATCH) {
    const chunk = keywords.slice(start, start + BATCH);
    const vectors = await embedBatch(tokenizer, textModel, chunk);
    vectors.forEach((vector, i) => {
      const k = start + i;
      const cosines = embeddingScores(embeddings, dim, vector);
      overall.set(cosines, k * count);
      perKeyword[k] = { keyword: chunk[i], ...summarize(cosines) };
    });
    console.log(`  ${Math.min(start + BATCH, keywords.length)}/${keywords.length}`);
  }

  const keywordMax = Float64Array.from(perKeyword, (k) => k.max);
  const keywordMean = Float64Array.from(perKeyword, (k) => k.mean);
  const keywordRange = Float64Array.from(perKeyword, (k) => k.max - k.min);

  const suggestion = suggestClipBounds({ overall, keywordMax }, { lowPercentile, highPercentile });

  const report = {
    generatedAt: new Date().toISOString(),
    model,
    rooms: count,
    keywords: keywords.length,
    overall: summarize(overall),
    keywordMax: summarize(keywordMax),
    keywordMean: summarize(keywordMean),
    keywordRange: summarize(keywordRange),
    suggestion,
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
