import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOverlays, overlayFaceId } from './overlays.ts';

const badge = { anchor: 'top-right', scale: 'pyramid', faces: { on: 'fav_on.png', off: 'fav_off.png' } };

test('a well-formed file parses to its descriptors unchanged', () => {
  assert.deepEqual(parseOverlays({ 'favorite-badge': badge }), { 'favorite-badge': badge });
  assert.deepEqual(parseOverlays({}), {});
});

test('a malformed file throws, naming the overlay and the problem', () => {
  const bad: [unknown, RegExp][] = [
    [[], /expected an object/],
    [{ 'Bad Id': badge }, /"Bad Id".*lowercase/],
    [{ x: 'nope' }, /"x": expected an object/],
    [{ x: { ...badge, anchor: 'middle' } }, /"x": anchor/],
    [{ x: { ...badge, scale: 'stretch' } }, /"x": scale/],
    [{ x: { ...badge, faces: {} } }, /"x": faces/],
    [{ x: { ...badge, faces: { On: 'a.png' } } }, /face "On"/],
    [{ x: { ...badge, faces: { on: 7 } } }, /face "on" must be a plain filename/],
    [{ x: { ...badge, faces: { on: '../a.png' } } }, /face "on" must be a plain filename/],
    [{ x: { ...badge, faces: { on: '512/a.png' } } }, /face "on" must be a plain filename/],
  ];
  for (const [raw, message] of bad) assert.throws(() => parseOverlays(raw), message, JSON.stringify(raw));
});

test('face ids are strings, distinct per overlay and face', () => {
  assert.equal(typeof overlayFaceId('a', 'b'), 'string');
  assert.notEqual(overlayFaceId('a', 'b'), overlayFaceId('a', 'c'));
  assert.notEqual(overlayFaceId('a', 'b'), overlayFaceId('b', 'b'));
});
