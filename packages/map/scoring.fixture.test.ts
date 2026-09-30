/**
 * Search against the committed snapshot of the real collection
 * (`packages/map/search-fixture/`, read by `tools/search-fixture/fixture.ts`).
 *
 * `scoring.test.ts` asserts each rule on a hand-built collection. This file
 * asserts the rules whose truth depends on the real distribution, one query
 * group at a time (the fixture's `README.md` says what each group promises),
 * and that `report.json` is current, so a change to search's weights or
 * formula lands as a reviewed diff of that file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSearchIndex, fold, rankHybrid } from './scoring.ts';
import type { RankHybridResult } from './searchResult.ts';
import { DEFAULTS } from '../config/config.ts';
import {
  FIXTURE_DIR,
  buildReport,
  loadFixture,
  rankFixtureQuery,
  type FixtureQuery,
  type QueryGroup,
  type SearchFixture,
} from '../../tools/search-fixture/fixture.ts';

const SEARCH = DEFAULTS.search;
const fixture = await loadFixture();
const index = buildSearchIndex(fixture.metadata, { minLength: SEARCH.minTokenLength });
const results = new Map(fixture.queries.map((q) => [q, rankFixtureQuery(fixture, q, SEARCH, index)]));

const inGroup = (group: QueryGroup): FixtureQuery[] => fixture.queries.filter((q) => q.group === group);

/** A result's strengths, indexed by room id rather than by rank. */
function strengthById(result: RankHybridResult): Float32Array {
  const byId = new Float32Array(result.order.length);
  result.order.forEach((id, rank) => (byId[id] = result.strength[rank]));
  return byId;
}

/** The strongest room no text signal touched: where CLIP alone placed it. */
function clipOnlyMax(result: RankHybridResult): number {
  const { tag, title, story, clip } = result.breakdown;
  let max = 0;
  for (let rank = 0; rank < result.order.length; rank++)
    if (!tag[rank] && !title[rank] && !story[rank]) max = Math.max(max, clip[rank]);
  return max;
}

type IndexEntry = NonNullable<(typeof index)[number]>;

/**
 * Room ids `match` picks out of the search index (keywords and title already
 * folded), asserted non-empty so a stale query cannot pass vacuously.
 */
function roomsWhere(query: FixtureQuery, match: (entry: IndexEntry, id: number) => boolean): number[] {
  const ids = index.flatMap((entry, id) => (entry && match(entry, id) ? [id] : []));
  assert.ok(ids.length, `no fixture room fits "${query.text}" - queries.json has drifted from the snapshot`);
  return ids;
}

test('the fixture covers every room with metadata and every query group', () => {
  assert.equal(fixture.metadata.filter(Boolean).length, fixture.files.length);
  for (const group of ['universal', 'irrelevant', 'keyword', 'title', 'story'] as const)
    assert.ok(inGroup(group).length, `queries.json has no "${group}" queries`);
});

test('report.json is what the current search produces over the fixture', async () => {
  const committed = JSON.parse(await readFile(join(FIXTURE_DIR, 'report.json'), 'utf8'));
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildReport(fixture, SEARCH, fixture.queries.map((q) => results.get(q)!)))),
    committed,
    'search behaves differently on the fixture: run `npm run generate:search-fixture` and review the report.json diff'
  );
});

test('typing a real keyword reports every room carrying it at full strength [SR-18]', () => {
  for (const query of inGroup('keyword')) {
    const strength = strengthById(results.get(query)!);
    const folded = fold(query.text);
    for (const id of roomsWhere(query, (entry) => entry.keywords.includes(folded)))
      assert.equal(strength[id], 1, `"${query.text}": ${fixture.files[id]} carries it but reports ${strength[id]}`);
  }
});

test('an exact keyword, title or story clause outranks every room CLIP alone placed [SR-10]', () => {
  const cases: [QueryGroup, (q: FixtureQuery) => Parameters<typeof roomsWhere>[1]][] = [
    ['keyword', (q) => (entry) => entry.keywords.includes(fold(q.text))],
    ['title', (q) => (entry) => entry.title === fold(q.text)],
    ['story', (q) => (_, id) => Boolean(fixture.metadata[id]?.story?.includes(q.text))],
  ];
  for (const [group, matcher] of cases)
    for (const query of inGroup(group)) {
      const result = results.get(query)!;
      const strength = strengthById(result);
      const ceiling = clipOnlyMax(result);
      for (const id of roomsWhere(query, matcher(query)))
        assert.ok(
          strength[id] > ceiling,
          `${group} "${query.text}": ${fixture.files[id]} at ${strength[id]} does not clear CLIP-only ${ceiling}`
        );
    }
});

test('a concept the collection never depicts packs no room at the density peak [SR-19]', () => {
  for (const query of inGroup('irrelevant')) {
    const top = results.get(query)!.strength[0];
    assert.ok(top < SEARCH.density.peakAt, `"${query.text}" tops out at ${top}, at or past peakAt ${SEARCH.density.peakAt}`);
  }
});

test('image content alone clusters most of the collection for what every room shows [SR-11]', () => {
  for (const query of inGroup('universal')) {
    const clipOnly = rankHybrid({
      query: query.text,
      count: fixture.files.length,
      weights: SEARCH.weights,
      embeddings: fixture.embeddings,
      dim: fixture.dim,
      scale: fixture.scale,
      vector: query.vector,
      clipStrength: { centre: SEARCH.density.clipCentre, high: SEARCH.density.clipHigh },
    });
    const strong = clipOnly.strength.filter((s) => s >= 0.5).length;
    assert.ok(strong > fixture.files.length / 2, `"${query.text}": CLIP alone puts only ${strong} rooms at 0.5 or more`);
  }
});

test('a room reports the same strength whatever else is in the collection [SR-16]', () => {
  // Every other room, rebuilt as a smaller collection of its own.
  const kept = fixture.files.map((_, id) => id).filter((id) => id % 2 === 0);
  const { dim } = fixture;
  const embeddings = new Int8Array(kept.length * dim);
  kept.forEach((id, i) => embeddings.set(fixture.embeddings.subarray(id * dim, (id + 1) * dim), i * dim));
  const half: SearchFixture = {
    ...fixture,
    files: kept.map((id) => fixture.files[id]),
    metadata: kept.map((id) => fixture.metadata[id]),
    embeddings,
  };
  const halfIndex = kept.map((id) => index[id]);
  for (const group of ['universal', 'irrelevant', 'keyword', 'story'] as const) {
    const query = inGroup(group)[0];
    const full = strengthById(results.get(query)!);
    const partial = strengthById(rankFixtureQuery(half, query, SEARCH, halfIndex));
    kept.forEach((id, i) => assert.equal(partial[i], full[id], `"${query.text}": ${fixture.files[id]} moved`));
  }
});

test('the same query over the same collection gives the same order, ties included [SR-15]', () => {
  // The real collection ties often (every exact tag at 1, every saturated
  // CLIP room at `weights.clip`), which is where an unstable sort would show.
  for (const group of ['universal', 'keyword'] as const) {
    const query = inGroup(group)[0];
    assert.deepEqual(rankFixtureQuery(fixture, query, SEARCH, index).order, results.get(query)!.order);
  }
});
