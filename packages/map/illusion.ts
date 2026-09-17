/**
 * Plan a row/column sliding-tile rearrangement of the map, so no tile ever
 * appears to glide over a backdrop.
 *
 * A cell is a wall, not a slot - the generic room is as much a wall as a corpus
 * room, and 80% of them being identical is a fact about the art, not licence to
 * treat them as empty. A single tile crossing the map would read as floating
 * above wallpaper, and the grid would stop being somewhere you stand. A whole
 * row or column rotating instead carries every tile together and traverses
 * nothing, and it holds at any zoom because it never depends on which cells the
 * viewer can resolve.
 *
 * ### The move set is the guarantee
 *
 * Three moves, and legality is structural rather than checked:
 *
 *   - `shiftRow` / `shiftCol` rotate a whole line, anywhere on the board. A
 *     rotation looks like sliding wherever the camera points, so these are
 *     always legal.
 *   - `swap` exchanges two cells, which reads as teleportation, so it is legal
 *     only when both ends are outside the camera's rectangle.
 *
 * "Preserve the illusion" therefore reduces to "emit only legal moves": the
 * planner's job is to get the right values into the on-camera cells using
 * nothing but rotations. Nothing downstream re-inspects the result - a plan
 * that type-checks is a plan that cannot be caught cheating.
 *
 * ### Values repeat, so this asks about supply, never identity
 *
 * Most of the board holds the same value - the generic room - so there is no
 * canonical permutation to invert and no "where does *this* tile go". Every
 * question is "where can I find a tile holding the value this cell needs",
 * answered against a live index of the simulated board. That is what makes the
 * wallpaper a non-issue rather than a special case.
 *
 * ### Board, not map
 *
 * The map is infinite; a board is not. The caller cuts a finite window and hands
 * it over, and rotations are toroidal within it - sound only because the wrap
 * happens off camera. See `board.ts`, the half that knows rooms, layouts and
 * viewports; this file knows values in a rectangle and nothing else, which is
 * what keeps it testable against an independent replay.
 *
 * Ported from the reference solver with its phase structure and invariant
 * intact. `illusion.test.ts` replays the emitted list independently rather than
 * trusting this file's bookkeeping.
 */

import type { Board, BoardValue, Bounds, LineRef, Move, Point } from './moves.ts';

/**
 * Reduce a cyclic distance to the shorter signed direction.
 *
 * A shift of +97 on a 100-wide board is the same permutation as -3, but only
 * one of them animates sensibly. Correctness is unaffected either way, which is
 * why this is a presentation detail applied on the way out.
 */
export function normaliseDistance(d: number, n: number): number {
  const m = ((d % n) + n) % n;
  return m > n >> 1 ? m - n : m;
}

/**
 * Plan a legal transformation of one board into another.
 *
 * @param start
 * @param end   a reordering of `start` - the two must agree as multisets,
 *   which `board.ts` is responsible for arranging
 * @param bounds the on-camera rectangle, inclusive. Must lie strictly inside
 *   the board and cover less than a quarter of it
 * @param fixed a cell that must never move, holding the same value in both
 *   boards
 * @returns moves, in order:
 *   `{type: 'shiftRow', row, distance}` - the value at column x moves to
 *      column (x + distance) mod width; positive is rightward
 *   `{type: 'shiftCol', col, distance}` - the value at row y moves to
 *      row (y + distance) mod height; positive is downward
 *   `{type: 'swap', a: {x, y}, b: {x, y}}` - both ends outside `bounds`
 */
export function planMoves(start: Board, end: Board, bounds: Bounds, fixed: Point): Move[] {
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
  const moves: Move[] = [];

  const at = (x: number, y: number) => y * W + x;
  const xOf = (p: number) => p % W;
  const yOf = (p: number) => (p - (p % W)) / W;
  const inside = (x: number, y: number) => x >= xmin && x <= xmax && y >= ymin && y <= ymax;
  const insideAt = (p: number) => inside(xOf(p), yOf(p));
  const outsideColumn = (p: number) => {
    const x = xOf(p);
    return x < xmin || x > xmax;
  };

  // `locked` marks cells holding their final value; no mechanism moves them
  // again. The per-line counters let the shift primitives reject a rotation that
  // would displace one in O(1), so the fixed tile's row and column become
  // unshiftable without being special-cased.
  //
  // `index` maps a value to the unlocked positions holding it. Locking evicts a
  // cell from it, which is the single mechanism that keeps a finalized tile from
  // being reused as a source later.
  const locked = new Uint8Array(W * H);
  const lockedInRow = new Int32Array(H);
  const lockedInCol = new Int32Array(W);
  const index = new Map<BoardValue, Set<number>>();

  const idxAdd = (p: number) => {
    let bucket = index.get(board[p]);
    if (!bucket) index.set(board[p], (bucket = new Set()));
    bucket.add(p);
  };
  const idxDel = (p: number) => index.get(board[p])?.delete(p);

  for (let p = 0; p < board.length; p++) idxAdd(p);

  function lock(p: number) {
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
  //
  // Every move carries the three tags the animation schedules by:
  //
  //   - `stage` is a hard barrier: stage n must be fully applied before stage
  //     n+1 begins.
  //   - `line` is the row or column a move belongs to; a swap that belongs to
  //     none carries null and simply keeps its place in the order.
  //   - `wave` says whether the stage's moves are independent. In a waveable
  //     stage, moves on different lines partition cleanly and may be applied in
  //     any interleaving, so the renderer plays the stage as one wave rather
  //     than a queue. A non-waveable stage keeps its order: an extraction
  //     rotates a line and the swap that follows depends on it.
  //
  // This is the canonical statement of the independence rule the phases below
  // rely on. What holds it is staging: a batch's values are all parked before
  // any of them are fed, so no line's work can disturb another's, and that is
  // why a feed stage can wave and a parking stage cannot.
  //
  // `wave` is set explicitly rather than inferred from stage parity, so a phase
  // can be reshaped without the animation quietly mis-scheduling it.
  let stage = 0;
  let line: LineRef | null = null;
  let wave = false;

  function shiftRow(r: number, d: number) {
    const dist = ((d % W) + W) % W;
    if (dist === 0) return;
    if (lockedInRow[r] !== 0) throw new Error('shiftRow would displace a finalized tile');
    const base = r * W;
    const old = board.slice(base, base + W);
    for (let x = 0; x < W; x++) idxDel(base + x);
    for (let x = 0; x < W; x++) board[base + x] = old[(x - dist + W) % W];
    for (let x = 0; x < W; x++) idxAdd(base + x);
    moves.push({
      type: 'shiftRow', row: r, distance: normaliseDistance(dist, W),
      stage, wave, line: { kind: 'row', index: r },
    });
  }

  function shiftCol(c: number, d: number) {
    const dist = ((d % H) + H) % H;
    if (dist === 0) return;
    if (lockedInCol[c] !== 0) throw new Error('shiftCol would displace a finalized tile');
    const old: BoardValue[] = new Array(H);
    for (let y = 0; y < H; y++) old[y] = board[at(c, y)];
    for (let y = 0; y < H; y++) idxDel(at(c, y));
    for (let y = 0; y < H; y++) board[at(c, y)] = old[(y - dist + H) % H];
    for (let y = 0; y < H; y++) idxAdd(at(c, y));
    moves.push({
      type: 'shiftCol', col: c, distance: normaliseDistance(dist, H),
      stage, wave, line: { kind: 'col', index: c },
    });
  }

  function swap(p: number, q: number) {
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
      stage,
      wave,
      line,
    });
  }

  // --- locating values -----------------------------------------------------

  /**
   * Any unlocked cell holding `v` and satisfying `pred`, or -1.
   *
   * With duplicate values there is no correct choice among candidates - the
   * invariant guarantees any of them serves - so first match wins.
   */
  function find(v: BoardValue, pred: (p: number) => boolean): number {
    const bucket = index.get(v);
    if (!bucket) return -1;
    for (const p of bucket) if (pred(p)) return p;
    return -1;
  }

  /**
   * An unlocked off-camera cell holding `v`, rotating one out if every
   * remaining copy is on camera.
   *
   * Extraction is always possible: locked cells are absent from the index, so
   * any copy found here lives in an unfinalized line, which by definition holds
   * no locked cells and can be rotated freely. The column route is tried first
   * because phase 2 depends on row shifts having stopped once phase 1 locked
   * cells into row-crossing positions; the row route serves phase 1, where no
   * region column is locked yet.
   */
  function makeAvailable(v: BoardValue): number {
    // Never a cell already staged for something else: a copy standing by for
    // another slot could otherwise be handed back as a source and swapped away,
    // leaving that reservation pointing at a cell now holding something else.
    // The multiset invariant guarantees an unreserved copy whenever one is
    // legitimately needed, so skipping reserved ones never starves a request.
    const free = find(v, (p) => !insideAt(p) && !reserved[p]);
    if (free !== -1) return free;

    const trapped = find(v, (p) => !reserved[p]);
    if (trapped === -1) throw new Error('value missing from board (multisets differ?)');
    // Rotate it out the near side. Either exit is off camera and equally legal,
    // so taking the shorter one is free - and it matters, because an extraction
    // is a visible slide and a trapped value sitting near the bottom of the
    // region would otherwise ride all the way up past the top of it.
    const x = xOf(trapped);
    const y = yOf(trapped);
    if (lockedInCol[x] === 0) {
      const exit = y - ymin <= ymax - y ? ymin - 1 : ymax + 1;
      shiftCol(x, exit - y);
      return at(x, exit);
    }
    if (lockedInRow[y] === 0) {
      const exit = x - xmin <= xmax - x ? xmin - 1 : xmax + 1;
      shiftRow(y, exit - x);
      return at(exit, y);
    }
    throw new Error('trapped value in a fully locked cross');
  }

  /**
   * A pool of cells a staged value can wait in without being disturbed.
   *
   * Which cells those are depends on what is about to move, and getting it
   * wrong is silent - the value simply is not where it was left. Two pools are
   * needed:
   *
   *   - for the conveyor, any cell in a column outside the region. Phase 2
   *     rotates only region columns, so nothing it does can reach one.
   *   - for the fixed tile's column, a cell outside the region's columns and
   *     rows both. That phase rotates region rows, and a row rotation sweeps
   *     every column including the outside ones, so the conveyor's pool is not
   *     safe here and only the corners are.
   *
   * The cursor exists because cells are released as they are consumed, so the
   * next free one is almost always just ahead of the last.
   */
  const reserved = new Uint8Array(W * H);

  function makeParker(parkable: (p: number) => boolean) {
    const pool: number[] = [];
    for (let p = 0; p < W * H; p++) if (parkable(p)) pool.push(p);
    let cursor = 0;

    function free(): number {
      for (let i = 0; i < pool.length; i++) {
        const p = pool[(cursor + i) % pool.length];
        if (!locked[p] && !reserved[p]) {
          cursor = (cursor + i + 1) % pool.length;
          return p;
        }
      }
      throw new Error('no parking available');
    }

    /**
     * Stage one copy of `v` out of harm's way, and reserve it.
     *
     * A copy already sitting in the pool is reserved in place and costs no move
     * at all; otherwise one is obtained - extracted from the region if it must
     * be - and swapped in. The reservation is what stops two staged values
     * claiming the same copy.
     */
    return {
      capacity: pool.length,
      park(v: BoardValue): number {
        let p = find(v, (q) => parkable(q) && !reserved[q]);
        if (p === -1) {
          const src = makeAvailable(v);
          if (parkable(src) && !reserved[src]) {
            p = src;
          } else {
            p = free();
            swap(src, p);
          }
        }
        reserved[p] = 1;
        return p;
      },
    };
  }

  const conveyorPark = makeParker(outsideColumn);
  const cornerPark = makeParker((p) => {
    const y = yOf(p);
    return outsideColumn(p) && (y < ymin || y > ymax);
  });

  /**
   * Split lines into batches sized to the parking pool's capacity.
   *
   * Batch size is simply how many values can wait at once; see the staging note
   * under the primitives for why a whole batch is parked before any of it is
   * fed. A region wide enough to crowd out its own parking degrades to one line
   * per batch rather than failing.
   */
  function batched(lines: number[], perLine: number, capacity: number): number[][] {
    // A margin, because `locked` and `reserved` both eat into the pool as the
    // plan proceeds, while `capacity` is counted once, up front.
    const size = Math.max(1, Math.floor((capacity * 0.9) / Math.max(1, perLine)));
    const out: number[][] = [];
    for (let i = 0; i < lines.length; i += size) out.push(lines.slice(i, i + size));
    return out;
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
    // Which rows actually need feeding. A row already holding the right value
    // costs nothing and is simply locked with the rest.
    const rows: number[] = [];
    for (let r = ymin; r <= ymax; r++)
      if (r !== fy && board[at(fx, r)] !== target[at(fx, r)]) rows.push(r);

    // Outward from the center, so the wave leaves from where the reader is
    // standing rather than sweeping in from an edge. Within a batch the order is
    // only the order the animation staggers by; correctness does not depend on
    // it (see the staging note under the primitives).
    rows.sort((a, b) => Math.abs(a - fy) - Math.abs(b - fy));

    // Rows already holding the right value are locked immediately, not left for
    // the end. A later batch's parking can extract a trapped value by rotating a
    // region column, and an unlocked cell that merely happens to be correct is
    // fair game for it; locking is the only thing that evicts a cell from the
    // index, putting it out of reach.
    for (let r = ymin; r <= ymax; r++)
      if (r !== fy && !rows.includes(r)) lock(at(fx, r));

    for (const batch of batched(rows, 1, cornerPark.capacity)) {
      // Park the batch first, which is what makes its rows independent and
      // lets their slides run as one wave (see the staging note above).
      stage++;
      line = null;
      const parked = batch.map((r) => cornerPark.park(target[at(fx, r)]));

      // Feed each row: swap its value into the cell immediately left of the
      // region, then slide the row right so it lands on the fixed column. The
      // rest of the row is scrambled by that, which is fine - those cells are
      // either off camera, where phase 3 fixes them, or region cells in other
      // columns, which phase 2 fills.
      stage++;
      wave = true;
      batch.forEach((r, i) => {
        line = { kind: 'row', index: r };
        const entry = at(entryX, r);
        if (parked[i] !== entry) swap(parked[i], entry);
        reserved[parked[i]] = 0;
        shiftRow(r, fx - entryX);
      });
      line = null;
      wave = false;

      // Locked per batch, not at the end, for the reason given above.
      for (const r of batch) lock(at(fx, r));
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
  //
  // Columns are parked a batch at a time (see `batched`). Parking a whole column
  // before feeding it stops an extraction from rotating the column that holds an
  // earlier one's value; parking a whole batch extends that so no column in it
  // can disturb another, and the animation runs them together.
  const k = ymax - ymin + 1;
  const cols: number[] = [];
  for (let c = xmin; c <= xmax; c++) if (c !== fx) cols.push(c);
  cols.sort((a, b) => Math.abs(a - fx) - Math.abs(b - fx));

  for (const batch of batched(cols, k, conveyorPark.capacity)) {
    stage++;
    line = null;
    const parked = new Map<number, number[]>();
    for (const c of batch) {
      const forColumn: number[] = new Array(k);
      for (let i = 0; i < k; i++) forColumn[i] = conveyorPark.park(target[at(c, ymin + i)]);
      parked.set(c, forColumn);
    }

    stage++;
    wave = true;
    for (const c of batch) {
      line = { kind: 'col', index: c };
      const entry = at(c, ymax + 1);
      const forColumn = parked.get(c) as number[];
      for (let i = 0; i < k; i++) {
        const src = forColumn[i];
        if (src !== entry) swap(src, entry);
        reserved[src] = 0; // that parking cell is free again
        shiftCol(c, -1);
      }
    }
    line = null;
    wave = false;

    for (const c of batch) for (let y = ymin; y <= ymax; y++) lock(at(c, y));
  }

  stage++;
  // --- phase 3: everything off camera, by cycle sort -----------------------
  //
  // Every region cell is locked by now, so every unlocked cell is off camera
  // and swaps are unrestricted. The invariant guarantees a source exists for
  // each, and `find` returns only unlocked positions, so a finalized cell is
  // never reused as a source.
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
 *
 * @param board mutated in place
 */
export function applyMove(board: Board, move: Move): Board {
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
    const old: BoardValue[] = new Array(H);
    for (let y = 0; y < H; y++) old[y] = cells[y * W + move.col];
    for (let y = 0; y < H; y++) cells[y * W + move.col] = old[(y - d + H) % H];
  } else if (move.type === 'swap') {
    const p = move.a.y * W + move.a.x;
    const q = move.b.y * W + move.b.x;
    const tmp = cells[p];
    cells[p] = cells[q];
    cells[q] = tmp;
  } else {
    // The three branches above are exhaustive over `Move` - tsc proves `move`
    // is `never` here, so this only fires if a caller passes something the
    // type contract doesn't allow.
    throw new Error(`unknown move ${JSON.stringify(move)}`);
  }
  return board;
}

/**
 * The preconditions the algorithm leans on, checked once and loudly.
 *
 * Every one of these is a thing `board.ts` has to arrange, and each failure
 * mode is silent if it is not caught here: a region touching an edge makes the
 * "just outside" cells wrap around to the far side of the board, and a region
 * covering too much of it starves the parking pool mid-plan.
 */
function validate(start: Board, end: Board, bounds: Bounds, fixed: Point): void {
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
