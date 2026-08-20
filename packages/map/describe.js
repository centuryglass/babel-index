/**
 * Naming one cell in the reader's own words.
 *
 * This is what a screen reader announces on arrival at a cell, and it is the
 * label the room card and the ranked listbox both reuse - one implementation,
 * more than one consumer (accessibility-plan.md phase B), the same split
 * `picking.js` and `centre.js` already make for hit-testing. Pure, no DOM, no
 * imports, so the words a reader hears can be asserted without a browser.
 *
 * The name is short on purpose - it is read on every arrival, not opened on
 * request - so a room's keywords go in, its story does not. The story is the
 * `description`, read separately (a card's body, a listbox option's extra
 * text), and it is honest when there is nothing to say: a room with no
 * metadata is ranked exactly like any other and must not be described as
 * though it had a story it does not.
 */

/**
 * @param {number} x world cell x
 * @param {number} y world cell y
 * @param {object} opts
 * @param {object} opts.layout from `packages/map/ordering.js`'s `createLayout()`
 * @param {number[]} opts.order room ids, best first - the ranking on the map
 * @param {(object|null)[]} [opts.metadata] indexed by room id, as
 *   `joinMetadata()` returns; omitted or a miss both read as "no metadata"
 * @returns {{kind: 'centre'|'generic'|'room', name: string, description: string|null}}
 */
export function describeCell(x, y, { layout, order, metadata = null }) {
  const at = layout.roomAt(x, y, order);

  if (at.centre) return { kind: 'centre', name: 'the centre of the library', description: null };
  if (at.generic) return { kind: 'generic', name: 'a blank wall', description: null };

  const entry = metadata?.[at.id] ?? null;
  const keywords = entry?.keywords?.length ? entry.keywords.map((k) => k.text).join(', ') : null;

  return {
    kind: 'room',
    name: `Room ${at.id}, rank ${at.rank + 1} of ${order.length} — ${keywords ?? 'no description recorded'}`,
    description: entry?.story ?? null,
  };
}
