/**
 * Compute CLIP image embeddings for a corpus of room images, offline.
 *
 * The image tower runs here, once, and ships as a static blob the browser ranks
 * against; only the text tower runs at request time, in the demo server's
 * /api/search. Both towers are the same model, which is what makes an image
 * vector and a text vector comparable at all - see `MODEL_ID`.
 *
 * Emits, next to the images by default:
 *   embeddings.bin   int8, row-major, one row per room, `count * dim` bytes
 *   embeddings.json  the sidecar: model, dim, count, scale, file order, and hashes
 *
 * Row order is the contract. It comes from `scanDirectory()` - the same scan the
 * server assigns room ids from - so row i is room id i. Nothing here re-derives
 * an ordering.
 *
 * Vectors are L2-normalised, so an int8 dot product approximates cosine, and
 * quantised symmetrically at `QUANT_SCALE` (the int8 half-range). Dequantise a
 * byte as `v / QUANT_SCALE`.
 *
 * ### Re-runs are incremental
 *
 * `embeddings.json` carries a `hashes` map (filename -> content hash) alongside
 * `order`. A rerun hashes every source file and copies the row of any file whose
 * hash and model both match, rather than running it back through the vision
 * tower, so touching a few images in a large corpus costs a few inferences. A
 * model change matches nothing, so every row is re-embedded. This mirrors the
 * content-hash cache in packages/pipeline/mips.ts, and `contentHash()` is shared
 * with it rather than reimplemented.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanDirectory } from '../../packages/server/scan.ts';
import { withClipCache } from '../../packages/server/clip-cache.ts';
import { contentHash } from '../../packages/pipeline/mips.ts';

/**
 * Must be the model `TEXT_MODEL` (packages/server/app.ts) loads for the text
 * tower, or the two towers point into different spaces and every ranking is
 * nonsense. Changing this also invalidates every cached row, so the next run
 * re-embeds the whole corpus.
 */
const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const QUANT_SCALE = 127; // int8 half-range
const BATCH = 16;

type Args = Record<string, string | undefined>;

function parseArgs(args: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const eq = args[i].indexOf('=');
    if (eq > -1) out[args[i].slice(2, eq)] = args[i].slice(eq + 1);
    else out[args[i].slice(2)] = args[++i];
  }
  return out;
}

/** L2-normalise a row and quantise it symmetrically into `out`, from `base`. */
function quantiseInto(row: ArrayLike<number>, out: Int8Array, base: number): void {
  let norm = 0;
  for (let d = 0; d < row.length; d++) norm += row[d] * row[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < row.length; d++) {
    const q = Math.round((row[d] / norm) * QUANT_SCALE);
    out[base + d] = Math.max(-127, Math.min(127, q));
  }
}

/**
 * The vision tower, imported only once there is work for it.
 *
 * `@huggingface/transformers` is an optional dependency (AGENTS.md,
 * "@huggingface/transformers is OPTIONAL"), so a machine that runs the demo
 * perfectly well may not have it. The message says which machine can do this job
 * rather than reporting an unresolvable specifier.
 */
async function loadVisionTower(): Promise<typeof import('@huggingface/transformers')> {
  try {
    return withClipCache(await import('@huggingface/transformers'));
  } catch (err: any) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    // Tagged `expected` for main()'s handler. Deciding that by sniffing the
    // error's shape there would swallow the stack of every real bug that happens
    // to look similar.
    throw Object.assign(new Error(
      'This tool needs @huggingface/transformers, which is an optional dependency and is ' +
        'not installed here.\n' +
        'It pulls in onnxruntime-node, which publishes binaries for Windows, macOS and Linux ' +
        'only - so on Android/Termux, or any other platform it does not build for, npm skips ' +
        'it and the rest of the install still succeeds.\n' +
        'Generate embeddings.bin on a supported machine and copy it into the corpus directory; ' +
        'the demo server reads the blob and does not need this package. Search still works ' +
        'without it, ranking by keywords and story rather than by CLIP.'
    ), { expected: true });
  }
}

/** The previous run's blob, with each cached row's content hash and byte offset by filename. */
interface EmbeddingCache {
  dim: number;
  bin: Buffer;
  rows: Map<string, { hash: string; offset: number }>;
}

/**
 * Load the previous run's cache, or null when there is nothing to reuse: no
 * sidecar or blob, either unreadable, a sidecar whose model or dtype is not this
 * run's, or a byte count that is not `order.length x dim`.
 *
 * A model mismatch drops the whole cache. Rows from another model are
 * incomparable to what this run writes, so no per-file reuse is safe there. See
 * `MODEL_ID`.
 */
async function loadCache(binPath: string, jsonPath: string): Promise<EmbeddingCache | null> {
  let sidecar;
  try {
    sidecar = JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch {
    return null;
  }
  if (sidecar?.model !== MODEL_ID || sidecar?.dtype !== 'int8' || !Array.isArray(sidecar.order)) return null;

  let bin;
  try {
    bin = await readFile(binPath);
  } catch {
    return null;
  }
  if (bin.byteLength !== sidecar.order.length * sidecar.dim) return null;

  const rows = new Map<string, { hash: string; offset: number }>();
  sidecar.order.forEach((file: string, i: number) => {
    const hash = sidecar.hashes?.[file];
    if (hash) rows.set(file, { hash, offset: i * sidecar.dim });
  });
  return { dim: sidecar.dim, bin, rows };
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const imagesDir = argv.images ?? 'assets/corpus-sample';
  const outDir = argv.out ?? imagesDir;
  // Must match the server's `--shared-dir` (packages/server/index.ts, which
  // defaults to `assets` too), or the room set embedded here and the set the
  // server ranks against drift. Rows are matched by order, so a drift ranks the
  // wrong rooms.
  const sharedDir = argv['shared-dir'] ?? 'assets';

  // One source of truth for which files are rooms and in what id order.
  const manifest = await scanDirectory(imagesDir, { center: argv.center, sharedDir });
  const files = manifest.rooms.map((r) => r.file);
  if (!files.length) throw new Error(`no corpus rooms in ${imagesDir}`);
  console.log(`${files.length} rooms (center tile: ${manifest.shared.center?.file ?? '(none)'}), model ${MODEL_ID}`);

  const binPath = join(outDir, 'embeddings.bin');
  const jsonPath = join(outDir, 'embeddings.json');
  const cache = await loadCache(binPath, jsonPath);

  const indexOf = new Map(files.map((f, i) => [f, i]));
  const hashes = new Map<string, string>(); // filename -> content hash, for this run's sidecar
  const stale: string[] = []; // filenames needing a fresh inference
  for (const file of files) {
    const hash = await contentHash(join(imagesDir, file));
    hashes.set(file, hash);
    if (!cache || cache.rows.get(file)?.hash !== hash) stale.push(file);
  }
  const staleSet = new Set(stale);

  const dim = cache?.dim ?? 0;
  let quant: Int8Array | null = dim ? new Int8Array(files.length * dim) : null; // sized once dim is known

  // Rows carried over untouched: copy the bytes, no re-inference.
  let cached = 0;
  if (quant) {
    for (const file of files) {
      if (staleSet.has(file)) continue;
      const row = cache!.rows.get(file)!;
      quant.set(cache!.bin.subarray(row.offset, row.offset + dim), indexOf.get(file)! * dim);
      cached++;
    }
  }

  if (stale.length) {
    console.log(`${stale.length} new/changed, ${files.length - stale.length} cached`);
    const { AutoProcessor, CLIPVisionModelWithProjection, RawImage } = await loadVisionTower();
    const processor = await AutoProcessor.from_pretrained(MODEL_ID);
    const model = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'fp32' });

    for (let start = 0; start < stale.length; start += BATCH) {
      const chunk = stale.slice(start, start + BATCH);
      const images = await Promise.all(chunk.map((f) => RawImage.read(join(imagesDir, f))));
      const inputs = await processor(images);
      const { image_embeds } = await model(inputs);
      const rows: number[][] = image_embeds.tolist(); // [chunk.length][dim]

      if (!quant) quant = new Int8Array(files.length * rows[0].length);
      const finalQuant = quant;
      const rowDim = finalQuant.byteLength / files.length;
      rows.forEach((row, i) => quantiseInto(row, finalQuant, indexOf.get(chunk[i])! * rowDim));
      console.log(`  ${Math.min(start + BATCH, stale.length)}/${stale.length}`);
    }
  } else {
    console.log(`all ${files.length} rows unchanged, nothing to embed`);
  }

  const finalDim = quant!.byteLength / files.length;
  await writeFile(binPath, Buffer.from(quant!.buffer, quant!.byteOffset, quant!.byteLength));
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        model: MODEL_ID,
        dim: finalDim,
        count: files.length,
        dtype: 'int8',
        scale: QUANT_SCALE,
        layout: 'row-major',
        order: files,
        hashes: Object.fromEntries(hashes),
      },
      null,
      2
    ) + '\n'
  );

  const kb = (quant!.byteLength / 1024).toFixed(1);
  console.log(`wrote ${binPath} (${kb} KB) and ${jsonPath} (${cached} cached, ${stale.length} embedded)`);
}

main().catch((err: any) => {
  console.error(err?.expected ? err.message : err);
  process.exit(1);
});
