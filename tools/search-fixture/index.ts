/**
 * `npm run generate:search-fixture` - refresh `packages/map/search-fixture/`.
 *
 *   npm run generate:search-fixture -- --tile-collection <dir>
 *       Snapshot <dir>'s metadata.json and embeddings.bin/.json into the
 *       fixture, then do everything the bare form does.
 *   npm run generate:search-fixture
 *       Embed any query in queries.json that has no vector yet, drop vectors
 *       no query uses, and rewrite report.json. Run after editing
 *       queries.json or changing search's weights or formula.
 *   npm run generate:search-fixture -- --check <dir>
 *       Compare the fixture against <dir> and print what drifted. Writes
 *       nothing; exits 1 on drift.
 *
 * Only a query without a vector needs `@huggingface/transformers`, so
 * rewriting the report works on any machine. A model change in the snapshot
 * re-embeds every query, since vectors from two models are incomparable.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTextTower, embedStrings } from '../embed/text-tower.ts';
import {
  FIXTURE_DIR,
  buildReport,
  decodeQueryVectors,
  encodeQueryVectors,
  loadFixture,
  readQueryList,
  trimMetadata,
  type EmbeddingsSidecar,
  type QuerySidecar,
} from './fixture.ts';

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

const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

/** A collection's search inputs, trimmed to what the fixture commits. */
async function snapshotOf(dir: string): Promise<{ sidecar: EmbeddingsSidecar; bin: Buffer; metadata: string }> {
  const full = await readJson(join(dir, 'embeddings.json'));
  const bin = await readFile(join(dir, 'embeddings.bin'));
  if (bin.byteLength !== full.count * full.dim || full.order?.length !== full.count)
    throw new Error(`${dir}: embeddings.bin/.json disagree on the row count`);
  const sidecar: EmbeddingsSidecar = {
    model: full.model,
    dim: full.dim,
    count: full.count,
    dtype: full.dtype,
    scale: full.scale,
    order: full.order,
  };
  const metadata = JSON.stringify(trimMetadata(await readJson(join(dir, 'metadata.json')), full.order), null, 1) + '\n';
  return { sidecar, bin, metadata };
}

/** Print how `dir` differs from the committed fixture; true when anything did. */
async function checkDrift(dir: string): Promise<boolean> {
  const fresh = await snapshotOf(dir);
  const old: EmbeddingsSidecar = await readJson(join(FIXTURE_DIR, 'embeddings.json'));
  const oldBin = await readFile(join(FIXTURE_DIR, 'embeddings.bin'));
  const oldMeta = await readJson(join(FIXTURE_DIR, 'metadata.json'));
  const newMeta = JSON.parse(fresh.metadata);

  const oldRow = new Map(old.order.map((f, i) => [f, oldBin.subarray(i * old.dim, (i + 1) * old.dim)]));
  const added = fresh.sidecar.order.filter((f) => !oldRow.has(f));
  const removed = old.order.filter((f) => !fresh.sidecar.order.includes(f));
  const kept = fresh.sidecar.order.filter((f) => oldRow.has(f));
  const reembedded = fresh.sidecar.model !== old.model
    ? kept
    : kept.filter((f) => {
      const i = fresh.sidecar.order.indexOf(f);
      return !oldRow.get(f)!.equals(fresh.bin.subarray(i * fresh.sidecar.dim, (i + 1) * fresh.sidecar.dim));
    });
  const rewritten = kept.filter((f) => JSON.stringify(oldMeta[f]) !== JSON.stringify(newMeta[f]));

  console.log(`fixture: ${old.count} rooms, ${old.model}; ${dir}: ${fresh.sidecar.count} rooms, ${fresh.sidecar.model}`);
  console.log(`  ${added.length} added, ${removed.length} removed, ${reembedded.length} re-embedded, ${rewritten.length} with changed metadata`);
  return Boolean(added.length || removed.length || reembedded.length || rewritten.length || fresh.sidecar.model !== old.model);
}

/**
 * Bring `query-embeddings.*` in line with `queries.json`: reuse every vector
 * whose text and model match, embed the rest, drop the unused.
 */
async function refreshQueryVectors(): Promise<void> {
  const { model, dim }: EmbeddingsSidecar = await readJson(join(FIXTURE_DIR, 'embeddings.json'));
  const texts = readQueryList(await readJson(join(FIXTURE_DIR, 'queries.json'))).map((q) => q.text);

  const cached = new Map<string, Float32Array>();
  try {
    const old: QuerySidecar = await readJson(join(FIXTURE_DIR, 'query-embeddings.json'));
    if (old.model === model && old.dim === dim) {
      const rows = decodeQueryVectors(await readFile(join(FIXTURE_DIR, 'query-embeddings.bin')), dim, old.queries.length);
      old.queries.forEach((text, i) => cached.set(text, rows[i]));
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const missing = texts.filter((t) => !cached.has(t));
  if (missing.length) {
    console.log(`embedding ${missing.length} quer${missing.length === 1 ? 'y' : 'ies'} with ${model}`);
    const tower = await loadTextTower(model);
    // One string per call, as `/api/search` embeds a live query, so no
    // batch padding can separate a fixture vector from a live one.
    for (const text of missing) {
      const [vector] = await embedStrings(tower, [text]);
      if (vector.length !== dim) throw new Error(`text tower returned ${vector.length} dims, image rows have ${dim}`);
      cached.set(text, vector);
    }
  }

  const sidecar: QuerySidecar = { model, dim, dtype: 'float32le', queries: texts };
  await writeFile(join(FIXTURE_DIR, 'query-embeddings.bin'), encodeQueryVectors(texts.map((t) => cached.get(t)!), dim));
  await writeJson(join(FIXTURE_DIR, 'query-embeddings.json'), sidecar);
  console.log(`${texts.length} query vectors (${texts.length - missing.length} reused)`);
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.check) {
    const drifted = await checkDrift(argv.check);
    if (drifted) console.log('refresh with: npm run generate:search-fixture -- --tile-collection ' + argv.check);
    process.exit(drifted ? 1 : 0);
  }

  if (argv['tile-collection']) {
    const { sidecar, bin, metadata } = await snapshotOf(argv['tile-collection']);
    await writeFile(join(FIXTURE_DIR, 'embeddings.bin'), bin);
    await writeJson(join(FIXTURE_DIR, 'embeddings.json'), sidecar);
    await writeFile(join(FIXTURE_DIR, 'metadata.json'), metadata);
    console.log(`snapshot: ${sidecar.count} rooms from ${argv['tile-collection']}`);
  }

  await refreshQueryVectors();
  const report = buildReport(await loadFixture());
  await writeJson(join(FIXTURE_DIR, 'report.json'), report);
  console.log(`wrote report.json (${report.queries.length} queries over ${report.rooms} rooms)`);
}

main().catch((err) => {
  console.error(err?.expected ? err.message : err);
  process.exit(1);
});
