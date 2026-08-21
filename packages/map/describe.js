/**
 * Naming what the reader is standing in, in their own words.
 *
 * This is what a screen reader announces on arrival at a cell, and it is the
 * label the room card and the ranked listbox both reuse - one implementation,
 * more than one consumer (accessibility-plan.md phase B), the same split
 * `picking.js` and `centre.js` already make for hit-testing. Pure, no DOM, no
 * imports, so the words a reader hears can be asserted without a browser.
 *
 * Two things get named here: a cell (`describeCell`) and a whole arrangement
 * (`describeArrangement`), and they share a file because they share the
 * discipline - short, honest, and asserted without a browser.
 *
 * The name is short on purpose - it is read on every arrival, not opened on
 * request - so a room's keywords go in, its story does not. The story is the
 * `description`, read separately (a card's body, a listbox option's extra
 * text), and it is honest when there is nothing to say: a room with no
 * metadata is ranked exactly like any other and must not be described as
 * though it had a story it does not.
 *
 * `picture` is the third and rarest: the sidecar's optional `alt`, one
 * sentence about the IMAGE rather than about the room. It is never generated
 * here or anywhere else at runtime - it arrives with the corpus or it does not
 * arrive at all.
 */

/**
 * @param {number} x world cell x
 * @param {number} y world cell y
 * @param {object} opts
 * @param {object} opts.layout from `packages/map/ordering.js`'s `createLayout()`
 * @param {number[]} opts.order room ids, best first - the ranking on the map
 * @param {(object|null)[]} [opts.metadata] indexed by room id, as
 *   `joinMetadata()` returns; omitted or a miss both read as "no metadata"
 * @returns {{kind: 'centre'|'generic'|'room', name: string, description: string|null,
 *   picture: string|null}}
 */
export function describeCell(x, y, { layout, order, metadata = null }) {
  const at = layout.roomAt(x, y, order);

  if (at.centre)
    return { kind: 'centre', name: 'the centre of the library', description: null, picture: null };
  if (at.generic) return { kind: 'generic', name: 'a blank wall', description: null, picture: null };

  const entry = metadata?.[at.id] ?? null;
  const keywords = entry?.keywords?.length ? entry.keywords.map((k) => k.text).join(', ') : null;

  return {
    kind: 'room',
    name: `Room ${at.id}, rank ${at.rank + 1} of ${order.length} — ${keywords ?? 'no description recorded'}`,
    description: entry?.story ?? null,
    // What the PICTURE shows, as against what the room is - the sidecar's
    // optional `alt` (accessibility-plan.md §3.5, phase E). Separate from
    // `description` on purpose: the story is fiction about the room and the
    // caption is a report of the image, and collapsing them would let a reader
    // take one for the other. Null far more often than not, and every consumer
    // has to read as well without it as with it, because most corpora will not
    // carry the field at all.
    picture: entry?.alt ?? null,
  };
}

/**
 * What the library just became, for the moment it rearranges under a reader
 * who cannot watch it happen (accessibility-plan.md §3.4, §8 item 4).
 *
 * The sliding-tile animation is 1.2 seconds of spectacle carrying no
 * information a non-sighted reader can use; what it is FOR is the search made
 * spatial, and that is a fact the layout already knows. `gradedCount` is the
 * size of the cluster the density gradient lifted above the baseline - so
 * "9 clustered near the centre" versus "spread evenly" is the difference
 * between a query the corpus could answer and one it could not, said in one
 * clause rather than shown in one second of motion.
 *
 * Deliberately says nothing about the animation, or about whether there was
 * one: reduced motion rebuilds the map at once and the outcome is identical,
 * so an announcement that mentioned sliding would be describing the half of
 * this that is optional.
 *
 * @param {object} layout from `createLayout()`
 * @returns {string}
 */
export function describeArrangement(layout) {
  const rooms = `${layout.roomCount} rooms on the map`;
  return layout.gradedCount
    ? `rearranged - ${rooms}, ${layout.gradedCount} clustered near the centre`
    : `rearranged - ${rooms}, spread evenly`;
}
