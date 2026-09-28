import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initLibraryState,
  overlayRank,
  reduce,
  type LibraryAction,
  type LibraryInit,
  type LibraryState,
} from './libraryState.ts';
import { HISTORY_SLOT_COUNT } from './center.ts';

const rooms = [
  { id: 0, file: 'oak' },
  { id: 1, file: 'gilt' },
  { id: 2, file: 'ash' },
];

function init(
  overrides: Partial<Omit<LibraryInit, 'stored'>> = {},
  stored: Partial<LibraryInit['stored']> = {},
): LibraryState {
  return initLibraryState({
    route: null,
    rooms,
    total: rooms.length,
    map: { contentRatio: 0.4, slotSeed: 7 },
    now: 1000,
    ...overrides,
    stored: { history: [], blockedTags: [], paging: 'scroll', seenHelpHint: true, ...stored },
  });
}

/** `state` after each of `actions` in turn. */
function run(state: LibraryState, ...actions: LibraryAction[]): LibraryState {
  return actions.reduce(reduce, state);
}

/** `count` distinct search terms, newest first. */
function terms(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `term ${i}`);
}

const room = { id: 1, rank: 2, x: 3, y: -1 };

test('a plain / opens with config and the mount time for the layout, relevance, the stored reader state and nothing open', () => {
  assert.deepEqual(init({}, { history: ['brass'], blockedTags: ['gore'], paging: 'pages' }), {
    roomCount: 3,
    contentRatio: 0.4,
    seed: 7,
    orderSeed: 1000,
    sortMode: 'relevance',
    randomSortSeed: 1000,
    history: ['brass'],
    blockedTags: ['gore'],
    paging: 'pages',
    card: null,
    overlay: null,
    catalogSpotlightId: null,
    helpOpen: false,
    showHelpHint: false,
    artistStatementOpen: false,
  });
});

test('a stored history longer than the wall keeps its newest entries', () => {
  const stored = terms(HISTORY_SLOT_COUNT + 3);
  assert.deepEqual(init({}, { history: stored }).history, stored.slice(0, HISTORY_SLOT_COUNT));
});

test('a room permalink opens its overlay in either reading, with no row rank of its own', () => {
  assert.deepEqual(init({ route: { mode: 'catalog', room: 'oak' } }).overlay, { id: 0, rank: null });
  assert.deepEqual(init({ route: { mode: 'map', room: 'gilt' } }).overlay, { id: 1, rank: null });
});

test('an unknown stem, or a catalog route with no room, opens no overlay', () => {
  assert.equal(init({ route: { mode: 'catalog', room: 'nowhere' } }).overlay, null);
  assert.equal(init({ route: { mode: 'catalog' } }).overlay, null);
});

test("an overlay shows its row's rank, or a permalinked room's place in the live order", () => {
  assert.equal(overlayRank({ id: 0, rank: 5 }, [2, 0, 1]), 5);
  assert.equal(overlayRank({ id: 0, rank: null }, [2, 0, 1]), 1);
  // A blocked room is filtered out of the order, and reads as rank 0.
  assert.equal(overlayRank({ id: 2, rank: null }, [0, 1]), 0);
});

test('/help and /about open their dialogs at mount', () => {
  assert.equal(init({ route: { mode: 'help' } }).helpOpen, true);
  assert.equal(init({ route: { mode: 'about' } }).artistStatementOpen, true);
  assert.equal(init({ route: { mode: 'about' } }).helpOpen, false);
});

test('the help hint shows only to a reader who has never been shown it', () => {
  assert.equal(init({}, { seenHelpHint: false }).showHelpHint, true);
  assert.equal(init({}, { seenHelpHint: true }).showHelpHint, false);
});

test('opening help clears the hint for good; closing it does not bring the hint back', () => {
  let state = init({}, { seenHelpHint: false });
  state = reduce(state, { type: 'openHelp' });
  assert.equal(state.helpOpen, true);
  assert.equal(state.showHelpHint, false);
  state = reduce(state, { type: 'closeHelp' });
  assert.equal(state.helpOpen, false);
  assert.equal(state.showHelpHint, false);
});

test('a pick opens the card, and a null pick (the center cell) closes it', () => {
  let state = reduce(init(), { type: 'openCard', card: room });
  assert.deepEqual(state.card, room);
  state = reduce(state, { type: 'openCard', card: null });
  assert.equal(state.card, null);
});

test('a keyword search closes both the card and the overlay', () => {
  const state = run(
    init(),
    { type: 'openCard', card: room },
    { type: 'openOverlay', room: { id: 0, rank: 1 } },
    { type: 'keywordSearch' },
  );
  assert.equal(state.card, null);
  assert.equal(state.overlay, null);
});

test('show in the catalog spotlights the row and closes the card or overlay that named it', () => {
  const fromCard = run(init(), { type: 'openCard', card: room }, { type: 'showInCatalog', id: 1 });
  assert.equal(fromCard.card, null);
  assert.equal(fromCard.catalogSpotlightId, 1);

  const fromOverlay = run(init(), { type: 'openOverlay', room: { id: 0, rank: 1 } }, { type: 'showInCatalog', id: 0 });
  assert.equal(fromOverlay.overlay, null);
  assert.equal(fromOverlay.catalogSpotlightId, 0);

  assert.equal(reduce(fromOverlay, { type: 'spotlightHandled' }).catalogSpotlightId, null);
});

test('a mode switch closes the map card but leaves the overlay, which renders in both readings', () => {
  const state = run(
    init(),
    { type: 'openCard', card: room },
    { type: 'openOverlay', room: { id: 0, rank: 1 } },
    { type: 'modeChange' },
  );
  assert.equal(state.card, null);
  assert.deepEqual(state.overlay, { id: 0, rank: 1 });
});

test('closing one dialog leaves the others as they were', () => {
  const state = run(init(), { type: 'openArtistStatement' }, { type: 'openHelp' }, { type: 'closeArtistStatement' });
  assert.equal(state.artistStatementOpen, false);
  assert.equal(state.helpOpen, true);
});

test('a search moves its term to the front of the history once, so the shelf offers it again [SR-39]', () => {
  let state = init({}, { history: ['brass', 'spiral staircase'] });
  state = reduce(state, { type: 'searchStarted', term: 'spiral staircase' });
  assert.deepEqual(state.history, ['spiral staircase', 'brass']);
  state = reduce(state, { type: 'searchStarted', term: 'oak' });
  assert.deepEqual(state.history, ['oak', 'spiral staircase', 'brass']);
});

test('a search past a full wall drops the oldest entry', () => {
  const full = terms(HISTORY_SLOT_COUNT);
  const { history } = reduce(init({}, { history: full }), { type: 'searchStarted', term: 'newest' });
  assert.deepEqual(history, ['newest', ...full.slice(0, HISTORY_SLOT_COUNT - 1)]);
});

test('starting a search ends any sort, favorite or random [SR-41]', () => {
  for (const mode of ['mine', 'count', 'random'] as const) {
    const state = run(init(), { type: 'setSort', mode, randomSeed: 5 }, { type: 'searchStarted', term: 'brass' });
    assert.equal(state.sortMode, 'relevance', `a search left '${mode}' in force`);
  }
});

test("a switch into 'random' draws a fresh shuffle, and no other switch touches it", () => {
  let state = reduce(init(), { type: 'setSort', mode: 'random', randomSeed: 42 });
  assert.equal(state.sortMode, 'random');
  assert.equal(state.randomSortSeed, 42);
  state = reduce(state, { type: 'setSort', mode: 'mine', randomSeed: 43 });
  assert.equal(state.sortMode, 'mine');
  assert.equal(state.randomSortSeed, 42);
  state = reduce(state, { type: 'setSort', mode: 'random', randomSeed: 44 });
  assert.equal(state.randomSortSeed, 44);
});

test("choosing 'random' while it is in force is no switch, so the order on screen stays", () => {
  const state = reduce(init(), { type: 'setSort', mode: 'random', randomSeed: 42 });
  assert.equal(reduce(state, { type: 'setSort', mode: 'random', randomSeed: 43 }), state);
});

test('the shuffle button rerolls both seeds and returns any sort to relevance', () => {
  for (const mode of ['relevance', 'mine', 'count', 'random'] as const) {
    const before = reduce(init(), { type: 'setSort', mode, randomSeed: 5 });
    const after = reduce(before, { type: 'reorder' });
    assert.equal(after.sortMode, 'relevance', `the shuffle left '${mode}' in force`);
    assert.notEqual(after.seed, before.seed);
    assert.notEqual(after.orderSeed, before.orderSeed);
  }
});

test('rescatter rerolls which cells are content slots and keeps the order and the sort', () => {
  const before = reduce(init(), { type: 'setSort', mode: 'mine', randomSeed: 5 });
  const after = reduce(before, { type: 'rescatter' });
  assert.notEqual(after.seed, before.seed);
  assert.equal(after.orderSeed, before.orderSeed);
  assert.equal(after.sortMode, 'mine');
});

test('forgetting searches empties the whole history at once', () => {
  assert.deepEqual(reduce(init({}, { history: ['brass', 'oak'] }), { type: 'forgetSearches' }).history, []);
});

test('toggling a tag blocks or unblocks it and leaves the other blocked tags as they were', () => {
  let state = init({}, { blockedTags: ['gore'] });
  state = reduce(state, { type: 'toggleBlockedTag', tag: 'spiders' });
  assert.deepEqual(state.blockedTags, ['gore', 'spiders']);
  state = reduce(state, { type: 'toggleBlockedTag', tag: 'gore' });
  assert.deepEqual(state.blockedTags, ['spiders']);
});

test('the sliders and the paging choice change their own value and nothing else', () => {
  const before = init();
  const after = run(
    before,
    { type: 'setRoomCount', count: 2 },
    { type: 'setContentRatio', ratio: 1 },
    { type: 'setPaging', paging: 'pages' },
  );
  assert.deepEqual(after, { ...before, roomCount: 2, contentRatio: 1, paging: 'pages' });
});

test('an action that changes nothing returns the same state, so React skips the re-render', () => {
  const state = init({}, { history: ['brass'] });
  assert.equal(reduce(state, { type: 'closeCard' }), state);
  assert.equal(reduce(state, { type: 'modeChange' }), state);
  assert.equal(reduce(state, { type: 'spotlightHandled' }), state);
  assert.equal(reduce(state, { type: 'setSort', mode: 'relevance', randomSeed: 5 }), state);
  assert.equal(reduce(state, { type: 'setPaging', paging: 'scroll' }), state);
  // The newest search again, with no sort to end.
  assert.equal(reduce(state, { type: 'searchStarted', term: 'brass' }), state);
  const empty = init();
  assert.equal(reduce(empty, { type: 'forgetSearches' }), empty);
  assert.notEqual(reduce(state, { type: 'openHelp' }), state);
});
