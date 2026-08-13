/**
 * The cost model's invariants - not its dollar figures.
 *
 * The numbers in `report.mjs` are meant to move: the traffic mix is a guess,
 * the prices are Cloudflare's to change, and the camera paths are illustrative.
 * What must not move is the reasoning the recommendation rests on, which is
 * what this file pins:
 *
 *   - a visit is bounded by the corpus, so no one visitor can run up a bill,
 *   - repeats are free, because the model counts distinct urls,
 *   - the knobs point the way the doc says they do (warm-coarser costs,
 *     sheets save),
 *   - and sheets keyed by room ID survive a re-rank, which is the property
 *     that makes them worth the complexity at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, shuffledOrder } from '../../packages/map/ordering.js';
import { createPyramid } from '../../packages/web/src/pyramid.js';
import { createSession, runArchetype, TILE } from './sessions.mjs';

const ROOMS = 400; // small enough to be quick, large enough to fill a screen
const LEVELS = 5;

const fixture = (atlas = new Map()) => {
  const pyramid = createPyramid({ base: TILE });
  const layout = createLayout({
    roomCount: ROOMS,
    contentRatio: 0.2,
    seed: 1,
    aspect: TILE.h / TILE.w,
  });
  const order = shuffledOrder(ROOMS, 1);
  return { pyramid, layout, order, session: createSession({ layout, order, pyramid, atlas }) };
};

test('a visit cannot cost more than the corpus itself', () => {
  const { session } = fixture();
  // Tour every level at every reachable zoom, then wander.
  for (const zoom of [26, 40, 60, 120, 220, 500, 900]) {
    session.visit({ x: 0.5, y: 0.5, zoom });
    session.panTo({ x: 0.5, y: 0.5, zoom }, { x: 30, y: 20, zoom });
  }
  // Every room at every level, plus the generic room at every level.
  assert.ok(
    session.ops() <= ROOMS * LEVELS + LEVELS,
    `${session.ops()} ops exceeds the ceiling of ${ROOMS * LEVELS + LEVELS}`
  );
});

test('revisiting a camera costs nothing - repeats are browser-cache hits', () => {
  const { session } = fixture();
  const cam = { x: 0.5, y: 0.5, zoom: 220 };
  session.visit(cam);
  const once = session.ops();
  session.visit(cam);
  session.visit(cam);
  assert.equal(session.ops(), once);
});

test('the warm-coarser pass costs operations, never saves them', () => {
  for (const name of ['glance', 'browse']) {
    const warm = runArchetype(name, { roomCount: ROOMS });
    const cold = runArchetype(name, { roomCount: ROOMS, warmCoarser: false });
    assert.ok(
      cold.ops <= warm.ops,
      `${name}: no-warm ${cold.ops} should not exceed warm ${warm.ops}`
    );
  }
});

test('sheets cut operations at the level they cover', () => {
  const perSheet = Math.ceil(ROOMS / 4);
  const plain = runArchetype('survey', { roomCount: ROOMS });
  const sheeted = runArchetype('survey', {
    roomCount: ROOMS,
    atlas: new Map([[4, perSheet]]),
  });
  assert.ok(
    sheeted.ops < plain.ops,
    `sheeted ${sheeted.ops} should be below per-room ${plain.ops}`
  );
  // Level 4 collapses to at most the number of sheets, plus the generic room.
  assert.ok((sheeted.byLevel.get(4) ?? 0) <= 4 + 1);
});

test('a re-rank refetches the screen when rooms are served per room', () => {
  const { session } = fixture();
  const cam = { x: 0.5, y: 0.5, zoom: 26 }; // zoomed out, the worst case
  session.visit(cam);
  const before = session.ops();
  session.rerank(cam, shuffledOrder(ROOMS, 99));
  assert.ok(
    session.ops() > before,
    'a new order should put unfetched rooms on screen'
  );
});

test('a re-rank costs nothing at a level served as whole-corpus sheets', () => {
  // The reason sheets are keyed by room ID and not by map position: the
  // arrangement is mutable, the ID is not, so re-ranking cannot invalidate one.
  const perSheet = Math.ceil(ROOMS / 4);
  const { session } = fixture(new Map([[4, perSheet]]));
  const cam = { x: 0.5, y: 0.5, zoom: 26 };
  session.visit(cam);
  const before = session.ops();
  session.rerank(cam, shuffledOrder(ROOMS, 99));
  assert.equal(session.ops(), before);
});
