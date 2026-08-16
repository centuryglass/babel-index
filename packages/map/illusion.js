/**
 * Rearranging the map without admitting that the grid is not a space.
 *
 * The map's cells are walls, not slots on a board - the generic room is as much
 * a wall as a corpus room is, and 80% of them being identical is a fact about
 * the art, not a licence to treat them as empty. So a room cannot cross the map
 * by gliding over the wallpaper: that reads as tiles floating above a backdrop
 * and the grid stops being somewhere you are standing.
 *
 * What a real sliding puzzle does instead is move a whole line at once. A row
 * or a column rotates, every tile in it travels together, and nothing is
 * traversed - which is exactly the illusion worth keeping, and it survives at
 * any zoom because it never depends on which cells the viewer can resolve.
 *
 * ### The move set is the guarantee
 *
 * Three moves, and the constraint is structural rather than checked:
 *
 *   - `shiftRow` / `shiftCol` rotate a whole line, anywhere on the board. A
 *     rotation looks like sliding wherever the camera happens to be pointing,
 *     so these are always legal.
 *   - `swap` exchanges two cells, which reads as teleportation, so it is legal
 *     only when both ends are outside the camera's rectangle.
 *
 * "Preserve the illusion" therefore reduces to "emit only legal moves", and the
 * planner's whole job becomes getting the right values into the on-camera cells
 * using nothing but rotations. Nothing downstream has to inspect the result:
 * a plan that type-checks is a plan that cannot be caught cheating.
 *
 * ### Values repeat, so this asks about supply, never about identity
 *
 * Most of the board holds the same value - the generic room - so there is no
 * canonical permutation to invert and no such thing as "where does *this* tile
 * go". Every question here is "where can I find a tile holding the value this
 * cell needs", answered against a live index of the simulated board. That is
 * what makes the wallpaper a non-issue rather than a special case.
 *
 * ### Board, not map
 *
 * The map is infinite; a board is not. The caller cuts a finite window out of
 * the map and hands it over, and the rotations are toroidal within that window.
 * That is sound only because the wrap happens off camera - see `board.js`,
 * which is the half that knows about rooms, layouts and viewports. This file
 * knows about values in a rectangle and nothing else, which is what keeps it
 * testable against an independent replay.
 *
 * Ported from the reference solver, with its phase structure and its invariant
 * intact; `illusion.test.mjs` carries the independent verifier that checks the
 * emitted list rather than trusting this file's own bookkeeping.
 */

/**
 * Reduce a cyclic distance to the shorter signed direction.
 *
 * A shift of +97 on a 100-wide board is the same permutation as -3, but only
 * one of them animates sensibly. Correctness is unaffected either way, which is
 * why this is a presentation detail applied on the way out.
 */
export function normaliseDistance(d, n) {
  const m = ((d % n) + n) % n;
  return m > n >> 1 ? m - n : m;
}

/**
 * Plan a legal transformation of one board into another.
 *
 * @param {{width: number, height: number, cells: Array}} start
 * @param {{width: number, height: number, cells: Array}} end   a reordering of
 *   `start` - the two must agree as multisets, which `board.js` is responsible
 *   for arranging
 * @param {{xmin: number, xmax: number, ymin: number, ymax: number}} bounds
 *   the on-camera rectangle, inclusive. Must lie strictly inside the board and
 *   cover less than a quarter of it
 * @param {{x: number, y: number}} fixed a cell that must never move, holding
 *   the same value in both boards
 * @returns {Array<object>} moves, in order:
 *   `{type: 'shiftRow', row, distance}` - the value at column x moves to
 *      column (x + distance) mod width; positive is rightward
 *   `{type: 'shiftCol', col, distance}` - the value at row y moves to
 *      row (y + distance) mod height; positive is downward
 *   `{type: 'swap', a: {x, y}, b: {x, y}}` - both ends outside `bounds`
 */
export function planMoves(start, end, bounds, fixed) {
  const { width: W, height: H } = start;
  const { xmin, xmax, ymin, ymax } = bounds;
  const fx = fixed.x;
  const fy = fixed.y;

  validate(start, end, bounds, fixed);

  // The board is simulated as we go rather than reasoned about symbolically:
  // every primitive below both records a move and applies it, so at any line
  // `board` is exactly what the client would be showing. That is what lets the
  // supply logic ask live questions instead of tracking a permutation.
  const board = start.cells.slice();
  const target = end.cells;
  const moves = [];

  const at = (x, y) => y * W + x;
  const xOf = (p) => p % W;
  const yOf = (p) => (p - (p % W)) / W;
  const inside = (x, y) => x >= xmin && x <= xmax && y >= ymin && y <= ymax;
  const insideAt = (p) => inside(xOf(p), yOf(p));
  const outsideColumn = (p) => {
    const x = xOf(p);
    return x < xmin || x > xmax;
  };

  // `locked` marks cells holding their final value; they are never moved again
  // by any mechanism. The per-line counters let the shift primitives reject a
  // rotation that would displace one in O(1), which is how the fixed tile's
  // row and column become unshiftable without ever being special-cased.
  //
  // `index` maps a value to the UNLOCKED positions holding it. Locking evicts a
  // cell from it, and that single mechanism is what keeps a finalized tile from
  // being cannibalized as a source later.
  const locked = new Uint8Array(W * H);
  const lockedInRow = new Int32Array(H);
  const lockedInCol = new Int32Array(W);
  const index = new Map();

  const idxAdd = (p) => {
    let bucket = index.get(board[p]);
    if (!bucket) index.set(board[p], (bucket = new Set()));
    bucket.add(p);
  };
  const idxDel = (p) => index.get(board[p])?.delete(p);

  for (let p = 0; p < board.length; p++) idxAdd(p);

  function lock(p) {
    idxDel(p);
    locked[p] = 1;
    lockedInRow[yOf(p)]++;
    lockedInCol[xOf(p)]++;
  }

  // Locking the fixed tile up front is what forbids every shift of its row and
  // column: the primitives refuse any line containing a locked cell, so the
  // constraint is enforced once, structurally, and never checked again. Its
  // value is already correct, by precondition.
  lock(at(fx, fy));

  // --- primitives: each simulates its own effect and appends to `moves` -----

  function shiftRow(r, d) {
    const dist = ((d % W) + W) % W;
    if (dist === 0) return;
    if (lockedInRow[r] !== 0) throw new Error('shiftRow would displace a finalized tile');
    const base = r * W;
    const old = board.slice(base, base + W);
    for (let x = 0; x < W; x++) idxDel(base + x);
    for (let x = 0; x < W; x++) board[base + x] = old[(x - dist + W) % W];
    for (let x = 0; x < W; x++) idxAdd(base + x);
    moves.push({ type: 'shiftRow', row: r, distance: normaliseDistance(dist, W) });
  }

  function shiftCol(c, d) {
    const dist = ((d % H) + H) % H;
    if (dist === 0) return;
    if (lockedInCol[c] !== 0) throw new Error('shiftCol would displace a finalized tile');
    const old = new Array(H);
    for (let y = 0; y < H; y++) old[y] = board[at(c, y)];
    for (let y = 0; y < H; y++) idxDel(at(c, y));
    for (let y = 0; y < H; y++) board[at(c, y)] = old[(y - dist + H) % H];
    for (let y = 0; y < H; y++) idxAdd(at(c, y));
    moves.push({ type: 'shiftCol', col: c, distance: normaliseDistance(dist, H) });
  }

  function swap(p, q) {
    if (p === q) return;
    if (insideAt(p) || insideAt(q)) throw new Error('swap inside the illusion bounds');
    if (locked[p] || locked[q]) throw new Error('swap would move a finalized tile');
    idxDel(p);
    idxDel(q);
    const tmp = board[p];
    board[p] = board[q];
    board[q] = tmp;
    idxAdd(p);
    idxAdd(q);
    moves.push({
      type: 'swap',
      a: { x: xOf(p), y: yOf(p) },
      b: { x: xOf(q), y: yOf(q) },
    });
  }

  // --- locating values -----------------------------------------------------

  /**
   * Any unlocked cell holding `v` and satisfying `pred`, or -1.
   *
   * With duplicate values there is no correct choice among candidates - the
   * invariant guarantees any of them serves - so first match wins.
   */
  function find(v, pred) {
    const bucket = index.get(v);
    if (!bucket) return -1;
    for (const p of bucket) if (pred(p)) return p;
    return -1;
  }

  /**
   * An unlocked OFF-CAMERA cell holding `v`, rotating one out if every
   * remaining copy is on camera.
   *
   * Extraction is always possible: locked cells are absent from the index, so
   * any copy found here lives in an unfinalized line, which by definition holds
   * no locked cells and can be rotated freely. The column route is tried first
   * because phase 2 depends on row shifts having stopped once phase 1 locked
   * cells into row-crossing positions; the row route serves phase 1, where no
   * region column is locked yet.
   */
  function makeAvailable(v) {
    const free = find(v, (p) => !insideAt(p));
    if (free !== -1) return free;

    const trapped = find(v, () => true);
    if (trapped === -1) throw new Error('value missing from board (multisets differ?)');
    const x = xOf(trapped);
    const y = yOf(trapped);
    if (lockedInCol[x] === 0) {
      shiftCol(x, ymin - 1 - y); // drop it just above the region
      return at(x, ymin - 1);
    }
    if (lockedInRow[y] === 0) {
      shiftRow(y, xmin - 1 - x); // or just left of it
      return at(xmin - 1, y);
    }
    throw new Error('trapped value in a fully locked cross');
  }

  // Staged values live in columns outside [xmin, xmax]. Phase 2 shifts only
  // region columns and swaps only off-camera cells, so a parked value cannot be
  // dislodged between staging and consumption. Capacity is at least 2H against
  // a peak demand of the region's height, which is what the bounds never
  // touching an edge buys.
  const reserved = new Uint8Array(W * H);
  const parking = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (x < xmin || x > xmax) parking.push(at(x, y));
  // A cursor rather than a scan from the start: parking cells are released as
  // they are consumed, so the next free one is almost always just ahead of the
  // last, and a full pass only happens if it is not.
  let parkCursor = 0;

  function freeParking() {
    for (let i = 0; i < parking.length; i++) {
      const p = parking[(parkCursor + i) % parking.length];
      if (!locked[p] && !reserved[p]) {
        parkCursor = (parkCursor + i + 1) % parking.length;
        return p;
      }
    }
    throw new Error('no parking available');
  }

  /**
   * Stage one copy of `v` where no later shift can reach it, and reserve it.
   *
   * A copy already sitting in a non-region column is reserved in place and
   * costs no move at all; otherwise one is obtained - extracted from the region
   * if it must be - and swapped into a parking cell. The reservation is what
   * stops two staged values claiming the same copy.
   */
  function park(v) {
    let p = find(v, (q) => outsideColumn(q) && !reserved[q]);
    if (p === -1) {
      const src = makeAvailable(v);
      if (outsideColumn(src) && !reserved[src]) {
        p = src;
      } else {
        p = freeParking();
        swap(src, p);
      }
    }
    reserved[p] = 1;
    return p;
  }

  // --- phase 1: the fixed tile's column, if it crosses the region ----------
  //
  // That column can never be rotated, so its on-camera cells cannot be fed by
  // the conveyor. They are fed by row shifts instead - legal here because
  // nothing in any region row is locked yet - and they are done first so that
  // nothing later can disturb them: phase 2 shifts only columns (never this
  // one) and phase 3 swaps only off-camera cells.
  //
  // Skipped entirely when the fixed tile is in no region column, which includes
  // the common case of it being nowhere near the camera.
  if (fx >= xmin && fx <= xmax) {
    const entryX = xmin - 1;
    for (let r = ymin; r <= ymax; r++) {
      if (r === fy) continue; // the fixed tile itself: correct by precondition
      const v = target[at(fx, r)];
      if (board[at(fx, r)] !== v) {
        // Stage the value immediately left of the region, then slide the row
        // right so it lands on the fixed column. The rest of the row is
        // scrambled by that, which is fine: those cells are either off camera,
        // where phase 3 fixes them, or region cells in other columns, which
        // phase 2 fills.
        const src = makeAvailable(v);
        const entry = at(entryX, r);
        if (src !== entry) swap(src, entry);
        shiftRow(r, fx - entryX);
      }
      lock(at(fx, r));
    }
  }

  // --- phase 2: every other region column, by conveyor ---------------------
  //
  // For one column over k steps, each step being "swap a value into
  // (c, ymax + 1), then shift the column up one":
  //
  //   a value inserted at step m undergoes (k - m + 1) upward shifts, finishing
  //   at row (ymax + 1) - (k - m + 1) = ymin + m - 1
  //
  // so step 1 lands on ymin and step k on ymax, and feeding targets in
  // top-to-bottom order is correct. Meanwhile the k values originally on camera
  // leave one per step through (c, ymin - 1). Entry and exit are both off
  // camera, so all the viewer sees is a column sliding steadily upward.
  //
  // Note this never needs the column emptied first, which matters because a
  // legal region may be taller than half the board.
  const k = ymax - ymin + 1;
  for (let c = xmin; c <= xmax; c++) {
    if (c === fx) continue; // handled in phase 1

    // Stage all k values before inserting any: extracting a later one can
    // rotate the column holding an earlier one, so gather-as-you-go is wrong.
    const parked = new Array(k);
    for (let i = 0; i < k; i++) parked[i] = park(target[at(c, ymin + i)]);

    const entry = at(c, ymax + 1);
    for (let i = 0; i < k; i++) {
      const src = parked[i];
      if (src !== entry) swap(src, entry);
      reserved[src] = 0; // that parking cell is free again
      shiftCol(c, -1);
    }

    for (let y = ymin; y <= ymax; y++) lock(at(c, y));
  }

  // --- phase 3: everything off camera, by cycle sort -----------------------
  //
  // Every region cell is locked by now, so every unlocked cell is off camera
  // and swaps are unrestricted. The invariant guarantees a source exists for
  // each, and `find` returns only unlocked positions, so nothing already
  // finalized is robbed.
  for (let p = 0; p < board.length; p++) {
    if (locked[p] || insideAt(p)) continue;
    const v = target[p];
    if (board[p] !== v) {
      const src = find(v, (q) => !insideAt(q));
      if (src === -1) throw new Error('invariant violated: no source off camera');
      swap(src, p);
    }
    lock(p);
  }

  return moves;
}

/**
 * Apply one move to a board in place.
 *
 * Exported for the renderer, which advances the board a move at a time as the
 * animation reaches each one. The test carries its own independent replay, so
 * this is never the thing that decides whether a plan is correct.
 */
export function applyMove(board, move) {
  const { width: W, height: H, cells } = board;
  if (move.type === 'shiftRow') {
    const d = ((move.distance % W) + W) % W;
    if (d === 0) return board;
    const base = move.row * W;
    const old = cells.slice(base, base + W);
    for (let x = 0; x < W; x++) cells[base + x] = old[(x - d + W) % W];
  } else if (move.type === 'shiftCol') {
    const d = ((move.distance % H) + H) % H;
    if (d === 0) return board;
    const old = new Array(H);
    for (let y = 0; y < H; y++) old[y] = cells[y * W + move.col];
    for (let y = 0; y < H; y++) cells[y * W + move.col] = old[(y - d + H) % H];
  } else if (move.type === 'swap') {
    const p = move.a.y * W + move.a.x;
    const q = move.b.y * W + move.b.x;
    const tmp = cells[p];
    cells[p] = cells[q];
    cells[q] = tmp;
  } else {
    throw new Error(`unknown move ${move.type}`);
  }
  return board;
}

/**
 * The preconditions the algorithm leans on, checked once and loudly.
 *
 * Every one of these is a thing `board.js` has to arrange, and each failure
 * mode is silent if it is not caught here: a region touching an edge makes the
 * "just outside" cells wrap around to the far side of the board, and a region
 * covering too much of it starves the parking pool mid-plan.
 */
function validate(start, end, bounds, fixed) {
  const { width: W, height: H } = start;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 10 || H < 10)
    throw new RangeError(`board must be at least 10x10; got ${W}x${H}`);
  if (start.cells.length !== W * H || end.cells.length !== W * H)
    throw new RangeError('board cells do not match the stated dimensions');
  if (end.width !== W || end.height !== H)
    throw new RangeError('start and end boards differ in size');

  const { xmin, xmax, ymin, ymax } = bounds;
  if (!(xmin >= 1 && xmax <= W - 2 && xmin <= xmax))
    throw new RangeError(`illusion bounds must leave a column either side: ${xmin}-${xmax} of ${W}`);
  if (!(ymin >= 1 && ymax <= H - 2 && ymin <= ymax))
    throw new RangeError(`illusion bounds must leave a row above and below: ${ymin}-${ymax} of ${H}`);

  const region = (xmax - xmin + 1) * (ymax - ymin + 1);
  if (region * 4 >= W * H)
    throw new RangeError(`illusion bounds cover ${region} of ${W * H} cells; must be under a quarter`);

  const { x: fx, y: fy } = fixed;
  if (!(fx >= 0 && fx < W && fy >= 0 && fy < H))
    throw new RangeError('fixed tile is off the board');
  if (start.cells[fy * W + fx] !== end.cells[fy * W + fx])
    throw new RangeError('fixed tile does not hold the same value in both boards');
}
