/**
 * Compute CLIP image embeddings for a corpus of room images, offline.
 *
 * This is Phase 4's expensive half (docs/implementation-plan.md): the image
 * tower runs here, once, and ships as a static blob the browser ranks against.
 * Only the text tower runs at request time, in the demo server's /api/search.
 *
 * It is deliberately the *same* transformers.js model the server loads for the
 * text tower (Xenova/clip-vit-base-patch32). Same files, same space: an image
 * vector and a text vector are directly comparable, which is the only thing
 * that makes the ranking mean anything. Change the model here and you must
 * change it there, and regenerate this blob.
 *
 * Emits, next to the images by default:
 *   embeddings.bin   int8, row-major, one row per room, `count * dim` bytes
 *   embeddings.json  the sidecar: model, dim, count, scale, and the file order
 *
 * Row order is the contract. It comes from scanDirectory() - the exact same
 * scan the server assigns room ids from - so row i is always room id i. We do
 * not re-derive the ordering here; we borrow the one source of truth.
 *
 * Vectors are L2-normalised (so an int8 dot product approximates cosine) and
 * quantised symmetrically at scale 127 (the int8 half-range). Dequantise as
 * v / 127.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AutoProcessor, CLIPVisionModelWithProjection, RawImage } from '@huggingface/transformers';
import { scanDirectory } from '../../packages/server/scan.mjs';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const QUANT_SCALE = 127; // int8 half-range; see file header
const BATCH = 16;

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

/** L2-normalise a row in place, then symmetric int8 quantise into `out`. */
function quantiseInto(row, out, base) {
  let norm = 0;
  for (const x of row) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < row.length; d++) {
    const q = Math.round((row[d] / norm) * QUANT_SCALE);
    out[base + d] = Math.max(-127, Math.min(127, q));
  }
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const imagesDir = argv.images ?? 'assets/corpus-sample';
  const outDir = argv.out ?? imagesDir;

  // One source of truth for which files are rooms and in what id order.
  const manifest = await scanDirectory(imagesDir, { base: argv.base });
  const files = manifest.rooms.map((r) => r.file);
  if (!files.length) throw new Error(`no corpus rooms in ${imagesDir}`);
  console.log(`${files.length} rooms (generic: ${manifest.generic.file}), model ${MODEL_ID}`);

  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  const model = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'fp32' });

  let dim = 0;
  let quant = null; // Int8Array, sized once we know dim

  for (let start = 0; start < files.length; start += BATCH) {
    const chunk = files.slice(start, start + BATCH);
    const images = await Promise.all(chunk.map((f) => RawImage.read(join(imagesDir, f))));
    const inputs = await processor(images);
    const { image_embeds } = await model(inputs);
    const rows = image_embeds.tolist(); // [chunk.length][dim]

    if (!quant) {
      dim = rows[0].length;
      quant = new Int8Array(files.length * dim);
    }
    rows.forEach((row, i) => quantiseInto(row, quant, (start + i) * dim));
    console.log(`  ${Math.min(start + BATCH, files.length)}/${files.length}`);
  }

  const binPath = join(outDir, 'embeddings.bin');
  const jsonPath = join(outDir, 'embeddings.json');
  await writeFile(binPath, Buffer.from(quant.buffer, quant.byteOffset, quant.byteLength));
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        model: MODEL_ID,
        dim,
        count: files.length,
        dtype: 'int8',
        scale: QUANT_SCALE,
        layout: 'row-major',
        order: files,
      },
      null,
      2
    ) + '\n'
  );

  const kb = (quant.byteLength / 1024).toFixed(1);
  console.log(`wrote ${binPath} (${kb} KB) and ${jsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
