/**
 * The search fixture: a committed snapshot of a real collection's search
 * inputs, with a fixed query set and its precomputed CLIP text vectors.
 *
 * Search's unit tests build tiny collections by hand to assert one rule at a
 * time. This fixture answers the other question, how the blend behaves on the
 * real distribution, and `buildReport` turns that into a committed file whose
 * diff shows what a weight or formula change did. It lives in
 * `packages/map/search-fixture/` (`FIXTURE_DIR`), whose `README.md` covers the
 * query groups and the refresh workflow.
 *
 * It carries no image bytes, only what `rankHybrid` reads:
 *   metadata.json            each room's title, keyword texts and story
 *                            (`trimMetadata`), in `metadata.json`'s own shape
 *   embeddings.bin/.json     the collection's image rows, as `tools/embed`
 *                            writes them, minus the per-file hashes
 *   queries.json             the query set by group, hand-edited
 *   query-embeddings.bin     one float32 little-endian row per distinct query
 *                            text, fp32 text tower, L2-normalised
 *   query-embeddings.json    that blob's model, dim and row order
 *   report.json              `buildReport` over the above
 *
 * Query vectors are committed because tests never load CLIP: the package is
 * optional and `npm test` runs without network.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinMetadata, type RoomMeta } from '../../packages/map/metadata.ts';
import type { Room } from '../../packages/map/manifest.ts';
import { buildSearchIndex, rankHybrid } from '../../packages/map/scoring.ts';
import type { RankHybridResult, SearchIndex } from '../../packages/map/searchResult.ts';
import { DEFAULTS, type Config } from '../../packages/config/config.ts';
import { percentileOf } from '../embed/cosine-stats.ts';

export const FIXTURE_DIR = fileURLToPath(new URL('../../packages/map/search-fixture/', import.meta.url));

/**
 * What each group of `queries.json` is for; `packages/map/search-fixture/README.md`
 * says what a test may assume of each.
 */
export const QUERY_GROUPS = ['universal', 'irrelevant', 'keyword', 'title', 'story', 'concept', 'partial'] as const;
export type QueryGroup = (typeof QUERY_GROUPS)[number];

/** One entry of `queries.json`, flattened. */
export interface QuerySpec {
  group: QueryGroup;
  text: string;
}

export interface FixtureQuery extends QuerySpec {
  vector: Float32Array;
}

/** The fixture as `rankHybrid` consumes it. */
export interface SearchFixture {
  /** Room filenames, in id order. */
  files: string[];
  metadata: (RoomMeta | null)[];
  model: string;
  dim: number;
  scale: number;
  embeddings: Int8Array;
  queries: FixtureQuery[];
}

/** The fields of one `metadata.json` entry that `buildSearchIndex` reads. */
export interface TrimmedEntry {
  title?: string;
  keywords: { text: string }[];
  story?: string;
}

/** The `embeddings.json` fields the fixture keeps. */
export interface EmbeddingsSidecar {
  model: string;
  dim: number;
  count: number;
  dtype: 'int8';
  scale: number;
  order: string[];
}

/** `query-embeddings.json`: row `i` of the blob embeds `queries[i]`. */
export interface QuerySidecar {
  model: string;
  dim: number;
  dtype: 'float32le';
  queries: string[];
}

/**
 * Flatten and validate `queries.json`: an object of group name -> string list.
 *
 * Throws on an unknown group, a non-string entry, or a text listed twice,
 * since a duplicate would report the same query twice under two names.
 */
export function readQueryList(raw: unknown): QuerySpec[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('queries.json must be an object of group -> query list');
  const specs: QuerySpec[] = [];
  const seen = new Set<string>();
  for (const [group, list] of Object.entries(raw)) {
    if (!(QUERY_GROUPS as readonly string[]).includes(group))
      throw new Error(`queries.json: unknown group "${group}" (expected one of ${QUERY_GROUPS.join(', ')})`);
    if (!Array.isArray(list)) throw new Error(`queries.json: group "${group}" must be a list`);
    for (const text of list) {
      if (typeof text !== 'string' || !text.trim()) throw new Error(`queries.json: group "${group}" holds a non-string or empty entry`);
      if (seen.has(text)) throw new Error(`queries.json: "${text}" is listed twice`);
      seen.add(text);
      specs.push({ group: group as QueryGroup, text });
    }
  }
  return specs;
}

/**
 * Keep only what search reads from a collection's `metadata.json`, for the
 * files in `order`, in that order.
 *
 * A file with no entry is left out, as `joinMetadata` tolerates. Keyword
 * `type`, `alt`, sensitive-content tags and curation fields are dropped: none
 * of them feed `buildSearchIndex`.
 */
export function trimMetadata(raw: unknown, order: string[]): Record<string, TrimmedEntry> {
  const table = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, TrimmedEntry> = {};
  for (const file of order) {
    if (!Object.hasOwn(table, file)) continue;
    const entry = table[file] as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') continue;
    const trimmed: TrimmedEntry = { keywords: [] };
    if (typeof entry.title === 'string') trimmed.title = entry.title;
    if (Array.isArray(entry.keywords))
      for (const k of entry.keywords)
        if (k && typeof k.text === 'string') trimmed.keywords.push({ text: k.text });
    if (typeof entry.story === 'string') trimmed.story = entry.story;
    out[file] = trimmed;
  }
  return out;
}

/** Decode `query-embeddings.bin`. */
export function decodeQueryVectors(bin: Uint8Array, dim: number, count: number): Float32Array[] {
  if (bin.byteLength !== count * dim * 4)
    throw new Error(`query-embeddings.bin has ${bin.byteLength} bytes, expected ${count * dim * 4} (${count} x ${dim} float32)`);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  return Array.from({ length: count }, (_, row) => {
    const v = new Float32Array(dim);
    for (let d = 0; d < dim; d++) v[d] = view.getFloat32((row * dim + d) * 4, true);
    return v;
  });
}

/** Encode rows for `query-embeddings.bin`. */
export function encodeQueryVectors(rows: Float32Array[], dim: number): Uint8Array {
  const out = new Uint8Array(rows.length * dim * 4);
  const view = new DataView(out.buffer);
  rows.forEach((row, r) => {
    if (row.length !== dim) throw new Error(`query vector ${r} has ${row.length} dims, expected ${dim}`);
    for (let d = 0; d < dim; d++) view.setFloat32((r * dim + d) * 4, row[d], true);
  });
  return out;
}

const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'));

/**
 * Read and cross-check the committed fixture.
 *
 * Throws when the pieces disagree: a blob size that is not `count x dim`, a
 * query blob embedded by another model, or a `queries.json` edited without
 * regenerating the vectors. Each of those would rank against the wrong
 * numbers silently.
 */
export async function loadFixture(dir: string = FIXTURE_DIR): Promise<SearchFixture> {
  const sidecar: EmbeddingsSidecar = await readJson(join(dir, 'embeddings.json'));
  const bin = await readFile(join(dir, 'embeddings.bin'));
  const embeddings = new Int8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  if (embeddings.length !== sidecar.count * sidecar.dim || sidecar.order.length !== sidecar.count)
    throw new Error(`${dir}: embeddings.bin/.json disagree on the row count`);

  const files = sidecar.order;
  const rooms = files.map((file, id) => ({ id, file }) as Room);
  const metadata = joinMetadata(rooms, await readJson(join(dir, 'metadata.json')));

  const specs = readQueryList(await readJson(join(dir, 'queries.json')));
  const querySidecar: QuerySidecar = await readJson(join(dir, 'query-embeddings.json'));
  const regenerate = 'run `npm run generate:search-fixture`';
  if (querySidecar.model !== sidecar.model || querySidecar.dim !== sidecar.dim)
    throw new Error(`${dir}: query vectors are ${querySidecar.model}/${querySidecar.dim}, image rows ${sidecar.model}/${sidecar.dim} - ${regenerate}`);
  const vectors = decodeQueryVectors(
    await readFile(join(dir, 'query-embeddings.bin')), querySidecar.dim, querySidecar.queries.length
  );
  const byText = new Map(querySidecar.queries.map((text, i) => [text, vectors[i]]));
  const queries = specs.map((spec) => {
    const vector = byText.get(spec.text);
    if (!vector) throw new Error(`${dir}: no vector for query "${spec.text}" - ${regenerate}`);
    return { ...spec, vector };
  });

  return { files, metadata, model: sidecar.model, dim: sidecar.dim, scale: sidecar.scale, embeddings, queries };
}

/** Rank one fixture query the way `useSearch.ts` ranks a live one. */
export function rankFixtureQuery(
  fixture: SearchFixture,
  query: FixtureQuery,
  search: Config['search'] = DEFAULTS.search,
  index: SearchIndex = buildSearchIndex(fixture.metadata, { minLength: search.minTokenLength })
): RankHybridResult {
  return rankHybrid({
    query: query.text,
    count: fixture.files.length,
    weights: search.weights,
    minTokenLength: search.minTokenLength,
    embeddings: fixture.embeddings,
    dim: fixture.dim,
    scale: fixture.scale,
    vector: query.vector,
    index,
    clipStrength: { centre: search.density.clipCentre, high: search.density.clipHigh },
  });
}

/** Rooms a query's top list names in `report.json`. */
export const REPORT_TOP = 5;

/** Four decimals: well above float32 noise, well below any change worth reviewing. */
const round = (v: number): number => Math.round(v * 1e4) / 1e4;

/** One query's line in `report.json`. */
export interface QueryReport {
  group: QueryGroup;
  query: string;
  signals: { clip: boolean; keyword: boolean; title: boolean; story: boolean };
  /** Raw CLIP cosine over every room; null when the query had no vector. */
  cosine: { p50: number; p99: number; max: number } | null;
  /** How many rooms reach each strength mark `search.density` defines. */
  rooms: { aboveFloor: number; atHalf: number; atPeak: number };
  strength: { p50: number; p90: number; p99: number; max: number };
  top: { file: string; strength: number }[];
}

export interface Report {
  model: string;
  rooms: number;
  /** The config the numbers were computed under, so a re-tune shows in the diff. */
  search: { weights: Config['search']['weights']; density: Config['search']['density'] };
  queries: QueryReport[];
}

/**
 * Summarise every fixture query's result: what the density gradient would
 * see (how many rooms clear `floor`, 0.5 and `peakAt`), the shape of the
 * strength and cosine distributions, and the top rooms.
 *
 * @param ranked each query's `rankFixtureQuery` result under `search`,
 *   parallel to `fixture.queries`; computed here when omitted
 */
export function buildReport(
  fixture: SearchFixture,
  search: Config['search'] = DEFAULTS.search,
  ranked?: RankHybridResult[]
): Report {
  const index = ranked ? null : buildSearchIndex(fixture.metadata, { minLength: search.minTokenLength });
  const { floor, peakAt } = search.density;
  const queries = fixture.queries.map((query, i): QueryReport => {
    const result = ranked ? ranked[i] : rankFixtureQuery(fixture, query, search, index!);
    const ascending = Float64Array.from(result.strength).sort();
    const count = (min: number, inclusive: boolean) =>
      result.strength.reduce((n, s) => n + ((inclusive ? s >= min : s > min) ? 1 : 0), 0);
    const cosines = Float64Array.from(result.breakdown.cosine).sort();
    return {
      group: query.group,
      query: query.text,
      signals: result.signals,
      cosine: result.signals.clip
        ? { p50: round(percentileOf(cosines, 50)), p99: round(percentileOf(cosines, 99)), max: round(cosines[cosines.length - 1]) }
        : null,
      rooms: { aboveFloor: count(floor, false), atHalf: count(0.5, true), atPeak: count(peakAt, true) },
      strength: {
        p50: round(percentileOf(ascending, 50)),
        p90: round(percentileOf(ascending, 90)),
        p99: round(percentileOf(ascending, 99)),
        max: round(ascending[ascending.length - 1]),
      },
      top: result.order.slice(0, REPORT_TOP).map((id, rank) => ({ file: fixture.files[id], strength: round(result.strength[rank]) })),
    };
  });
  return {
    model: fixture.model,
    rooms: fixture.files.length,
    search: { weights: search.weights, density: search.density },
    queries,
  };
}
