import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initLibraryState, reduce, type LibraryInit, type LibraryState } from './libraryState.ts';

const rooms = [
  { id: 0, file: 'oak' },
  { id: 1, file: 'gilt' },
  { id: 2, file: 'ash' },
];

function init(overrides: Partial<LibraryInit> = {}): LibraryState {
  return initLibraryState({ route: null, rooms, order: [2, 0, 1], seenHelpHint: true, ...overrides });
}

const room = { id: 1, rank: 2, x: 3, y: -1 };

test('a plain / opens with nothing open', () => {
  assert.deepEqual(init(), {
    card: null,
    overlay: null,
    catalogSpotlightId: null,
    helpOpen: false,
    showHelpHint: false,
    artistStatementOpen: false,
  });
});

test('a room permalink opens its overlay at its rank in the mount order, in either reading', () => {
  assert.deepEqual(init({ route: { mode: 'catalog', room: 'oak' } }).overlay, { id: 0, rank: 1 });
  assert.deepEqual(init({ route: { mode: 'map', room: 'gilt' } }).overlay, { id: 1, rank: 2 });
});

test('a permalink to a room the order does not hold opens at rank 0; an unknown stem opens nothing', () => {
  assert.deepEqual(init({ route: { mode: 'map', room: 'ash' }, order: [0, 1] }).overlay, { id: 2, rank: 0 });
  assert.equal(init({ route: { mode: 'catalog', room: 'nowhere' } }).overlay, null);
  assert.equal(init({ route: { mode: 'catalog' } }).overlay, null);
});

test('/help and /about open their dialogs at mount', () => {
  assert.equal(init({ route: { mode: 'help' } }).helpOpen, true);
  assert.equal(init({ route: { mode: 'about' } }).artistStatementOpen, true);
  assert.equal(init({ route: { mode: 'about' } }).helpOpen, false);
});

test('the help hint shows only to a reader who has never been shown it', () => {
  assert.equal(init({ seenHelpHint: false }).showHelpHint, true);
  assert.equal(init({ seenHelpHint: true }).showHelpHint, false);
});

test('opening help clears the hint for good; closing it does not bring the hint back', () => {
  let state = init({ seenHelpHint: false });
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
  let state = reduce(init(), { type: 'openCard', card: room });
  state = reduce(state, { type: 'openOverlay', room: { id: 0, rank: 1 } });
  state = reduce(state, { type: 'keywordSearch' });
  assert.equal(state.card, null);
  assert.equal(state.overlay, null);
});

test('show in the catalog spotlights the row and closes the card or overlay that named it', () => {
  const fromCard = reduce(reduce(init(), { type: 'openCard', card: room }), { type: 'showInCatalog', id: 1 });
  assert.equal(fromCard.card, null);
  assert.equal(fromCard.catalogSpotlightId, 1);

  const fromOverlay = reduce(
    reduce(init(), { type: 'openOverlay', room: { id: 0, rank: 1 } }),
    { type: 'showInCatalog', id: 0 },
  );
  assert.equal(fromOverlay.overlay, null);
  assert.equal(fromOverlay.catalogSpotlightId, 0);

  assert.equal(reduce(fromOverlay, { type: 'spotlightHandled' }).catalogSpotlightId, null);
});

test('a mode switch closes the map card but leaves the overlay, which renders in both readings', () => {
  let state = reduce(init(), { type: 'openCard', card: room });
  state = reduce(state, { type: 'openOverlay', room: { id: 0, rank: 1 } });
  state = reduce(state, { type: 'modeChange' });
  assert.equal(state.card, null);
  assert.deepEqual(state.overlay, { id: 0, rank: 1 });
});

test('closing one dialog leaves the others as they were', () => {
  let state = reduce(init(), { type: 'openArtistStatement' });
  state = reduce(state, { type: 'openHelp' });
  state = reduce(state, { type: 'closeArtistStatement' });
  assert.equal(state.artistStatementOpen, false);
  assert.equal(state.helpOpen, true);
});

test('an action that changes nothing returns the same state, so React skips the re-render', () => {
  const state = init();
  assert.equal(reduce(state, { type: 'closeCard' }), state);
  assert.equal(reduce(state, { type: 'modeChange' }), state);
  assert.equal(reduce(state, { type: 'spotlightHandled' }), state);
  assert.notEqual(reduce(state, { type: 'openHelp' }), state);
});
