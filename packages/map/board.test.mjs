import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, shuffledOrder } from './ordering.js';
import { buildRearrangement, CENTER, GENERIC } from './board.js';
import { planMoves, applyMove } from './illusion.js';

const ASPECT = 0.75; // the 4:3 tile's cell
const VIEW = { x0: -4, y0: -3, x1: 5, y1: 4 }; // ~1920x1080 at the default zoom

const arrangement = (roomCount, order, density = null) => ({
  layout: createLayout({ roomCount, contentRatio: 0.2, seed: 1, aspect: ASPECT, density }),
  order,
});

/** A certainty profile shaped like a search that found something. */
const certaintyFor = (n, reach) => Array.from({ length: n }, (_, i) => Math.max(0, 1 - i / reach));

/**
 * Plan a rearrangement and check the only thing that finally matters: after
 * every move, the cells the viewer can see hold what the new arrangement says
 * they should. Everything else - the legality of each move, the fixed tile - is
 * `illusion.test.mjs`'s business; this is the join between the two halves.
 */
function planAndCheck(before, after, view = VIEW) {
  const built = buildRearrangement({ before, after, view, aspect: ASPECT });
  assert.ok(built, 'expected this rearrangement to be animatable');

  const moves = planMoves(built.start, built.end, built.bounds, built.fixed);
  const live = { width: built.width, height: built.height, cells: built.start.cells.slice() };
  for (const mv of moves) applyMove(live, mv);

  for (let my = view.y0; my <= view.y1; my++)
    for (let mx = view.x0; mx <= view.x1; mx++) {
      const p = (my + built.origin.y) * built.width + (mx + built.origin.x);
      const cell = after.layout.roomAt(mx, my, after.order);
      const want = cell.center ? CENTER : cell.generic ? GENERIC : cell.id;
      assert.equal(live.cells[p], want, `visible cell (${mx}, ${my}) is wrong after the plan`);
    }

  return { built, moves };
}

test('a shuffle is animatable, and lands the visible cells exactly', () => {
  const n = 200;
  const before = arrangement(n, shuffledOrder(n, 1));
  const after = arrangement(n, shuffledOrder(n, 2));
  const { built } = planAndCheck(before, after);

  // The center never moves, and holds the center room at both ends.
  const c = built.origin.y * built.width + built.origin.x;
  assert.equal(built.start.cells[c], CENTER);
  assert.equal(built.end.cells[c], CENTER);
});

test('a search moves the slots themselves, and that is still animatable', () => {
  // The density gradient makes certainty an input to placement, so this is not
  // a permutation over fixed slots: cells that were wallpaper become rooms and
  // the other way round. That is the case the cross-fade design predates.
  const n = 200;
  const before = arrangement(n, shuffledOrder(n, 1));
  const after = arrangement(n, shuffledOrder(n, 7), {
    certainty: certaintyFor(n, 30),
    peak: 1,
    floor: 0.05,
  });
  assert.notEqual(
    before.layout.rankOf(1, 0) === -1,
    after.layout.rankOf(1, 0) === -1,
    'expected the gradient to change which cells are content at all'
  );
  planAndCheck(before, after);
});

test('the board holds every slot of both layouts', () => {
  // A room the new order wants on camera has to be findable, and after a search
  // it may have been at the far edge a moment ago.
  const n = 400;
  const before = arrangement(n, shuffledOrder(n, 1));
  const after = arrangement(n, shuffledOrder(n, 2), {
    certainty: certaintyFor(n, 40), peak: 1, floor: 0.05,
  });
  const built = buildRearrangement({ before, after, view: VIEW, aspect: ASPECT });

  for (const { layout, order } of [before, after])
    for (let rank = 0; rank < n; rank++) {
      const { x, y } = layout.cellOfRank(rank);
      assert.ok(
        Math.abs(x) <= built.origin.x && Math.abs(y) <= built.origin.y,
        `rank ${rank} at (${x}, ${y}) falls outside the board`
      );
      assert.ok(order.length > rank);
    }
});

test('the board satisfies the planner preconditions on a tiny corpus', () => {
  // 26 rooms span barely more than the viewport, so here it is the quarter-board
  // rule that decides the size, not the slot extent. Both directions matter and
  // this is the one that a "board = slot extent" shortcut would get wrong.
  const n = 26;
  const built = buildRearrangement({
    before: arrangement(n, shuffledOrder(n, 1)),
    after: arrangement(n, shuffledOrder(n, 2)),
    view: VIEW,
    aspect: ASPECT,
  });
  const { bounds, width, height } = built;
  const region = (bounds.xmax - bounds.xmin + 1) * (bounds.ymax - bounds.ymin + 1);
  assert.ok(region * 4 < width * height, 'region is not under a quarter of the board');
  assert.ok(bounds.xmin >= 1 && bounds.xmax <= width - 2, 'region touches a vertical edge');
  assert.ok(bounds.ymin >= 1 && bounds.ymax <= height - 2, 'region touches a horizontal edge');
  assert.ok(width >= 10 && height >= 10);
  // And it plans, which is the real assertion.
  planAndCheck(arrangement(n, shuffledOrder(n, 1)), arrangement(n, shuffledOrder(n, 2)));
});

test('the region covers more than the viewport, so the entry cell stays hidden', () => {
  const built = buildRearrangement({
    before: arrangement(50, shuffledOrder(50, 1)),
    after: arrangement(50, shuffledOrder(50, 2)),
    view: VIEW,
    aspect: ASPECT,
  });
  // The planner swaps into the cell just below the region and then slides it in.
  // If the region only reached the last visible cell, that swap would happen on
  // screen and the illusion would break along the bottom edge.
  assert.ok(built.bounds.ymin < VIEW.y0 + built.origin.y, 'no margin above the viewport');
  assert.ok(built.bounds.ymax > VIEW.y1 + built.origin.y, 'no margin below the viewport');
  assert.ok(built.bounds.xmin < VIEW.x0 + built.origin.x, 'no margin left of the viewport');
  assert.ok(built.bounds.xmax > VIEW.x1 + built.origin.x, 'no margin right of the viewport');
  assert.throws(
    () => buildRearrangement({
      before: arrangement(50, shuffledOrder(50, 1)),
      after: arrangement(50, shuffledOrder(50, 2)),
      view: VIEW, aspect: ASPECT, margin: 0,
    }),
    RangeError
  );
});

test('visible work is bounded by the viewport, not by the corpus', () => {
  // The reason a board big enough for a large corpus costs nothing to animate:
  // everything outside the region is a swap, and swaps are never seen.
  let bounds;
  const counts = [50, 200, 800].map((n) => {
    const { moves, built } = planAndCheck(
      arrangement(n, shuffledOrder(n, 1)),
      arrangement(n, shuffledOrder(n, 2))
    );
    bounds = built.bounds;
    return moves.filter((m) => m.type !== 'swap').length;
  });

  // The claim is that this does not GROW with the corpus, which is what the
  // board size rests on. It is not flat: a value with no copy off camera has to
  // be rotated out of the region first, and a small corpus needs more of those,
  // because more of its distinct rooms are on screen at once. So the count
  // drifts mildly the other way, and the biggest corpus is never the dearest.
  assert.ok(
    Math.max(...counts) / Math.min(...counts) < 1.5,
    `slide counts vary too much with corpus size: ${counts}`
  );
  assert.ok(
    counts[counts.length - 1] <= Math.max(...counts),
    `the largest corpus was the most expensive: ${counts}`
  );

  // The conveyor's own cost: one row shift per region row to feed the center
  // column, then one column step per region cell. Extractions add a few on top,
  // and even doubled that stays far under the region's area.
  const rows = bounds.ymax - bounds.ymin + 1;
  const cols = bounds.xmax - bounds.xmin + 1;
  const conveyor = rows - 1 + (cols - 1) * rows;
  assert.ok(
    Math.max(...counts) <= conveyor * 1.5,
    `${Math.max(...counts)} slides against a conveyor cost of ${conveyor}`
  );
});

test('a corpus smaller than the placed set cannot be animated, and says so', () => {
  // The "rooms on the map" slider: a reorder then changes WHICH rooms are
  // placed, so a room the new order wants on camera may never have been on the
  // board. Sliding it in would mean a tile changing its face off camera.
  const total = 300;
  const n = 60;
  const before = arrangement(n, shuffledOrder(total, 1));
  const after = arrangement(n, shuffledOrder(total, 2));
  assert.equal(buildRearrangement({ before, after, view: VIEW, aspect: ASPECT }), null);

  // The same corpus at full size is fine, which is what makes this a fallback
  // for one control rather than a limit on the feature.
  const full = (seed) => arrangement(total, shuffledOrder(total, seed));
  assert.ok(buildRearrangement({ before: full(1), after: full(2), view: VIEW, aspect: ASPECT }));
});

test('a narrow viewport is a legal region too', () => {
  // A phone at the default zoom: about 2 cells across and 5 down. The region is
  // then taller than it is wide, which is the shape that breaks any approach
  // assuming a region line can be cleared in one rotation.
  planAndCheck(
    arrangement(120, shuffledOrder(120, 1)),
    arrangement(120, shuffledOrder(120, 2)),
    { x0: -1, y0: -3, x1: 2, y1: 4 }
  );
});
