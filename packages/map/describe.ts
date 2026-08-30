/**
 * Naming what the reader is standing in, in their own words.
 *
 * This is what a screen reader announces on arrival at a cell, and it is the
 * label the room card and the ranked listbox both reuse - one implementation,
 * more than one consumer (accessibility-plan.md phase B), the same split
 * `picking.ts` and `center.js` already make for hit-testing. Pure, no DOM, no
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
 *
 * A generic cell gets a `description` too, unlike the center room - it is
 * shown in the room card opened on it (`RoomCard`/`RoomDetails`), and the one
 * thing worth telling a reader who opens it is that it's wallpaper, not an
 * unindexed room.
 */

import type { MapLayout } from './ordering.ts';
import type { RoomMeta } from './metadata.ts';

export interface Description {
  kind: 'center' | 'generic' | 'room';
  name: string;
  description: string | null;
  picture: string | null;
}

export interface DescribeCellOptions {
  layout: MapLayout;
  /** room ids, best first - the ranking on the map */
  order: number[];
  /** indexed by room id, as `joinMetadata()` returns; omitted or a miss both read as "no metadata" */
  metadata?: (RoomMeta | null)[] | null;
}

export function describeCell(x: number, y: number, { layout, order, metadata = null }: DescribeCellOptions): Description {
  const at = layout.roomAt(x, y, order);

  if (at.center)
    return { kind: 'center', name: 'the center of the library', description: null, picture: null };
  if (at.generic)
    return {
      kind: 'generic',
      name: 'a library wall',
      // Borges's identical hexagons: this is a placeholder, not an unindexed
      // room, and a reader who opens it should be pointed back at a search
      // rather than left wondering if they missed something.
      description:
        'A library wall, plain and identical to countless others, its shelves filled with nonsense. There is nothing to find here.',
      picture: null,
    };

  return describeRoom(at.id, at.rank, order.length, metadata?.[at.id] ?? null);
}

/**
 * The same naming, for a caller that already knows which room it is holding.
 *
 * `describeCell` resolves a cell and then calls this; the catalog, which has no
 * cells at all, calls it directly. Splitting it out is what keeps "what a room
 * is called" a single implementation across a spatial reading and a linear one
 * - the premise this whole file rests on. Nothing about a cell, a layout or a
 * board reaches in here.
 *
 * @param id room id
 * @param rank position in the ranking, 0-based
 * @param total how many rooms are ranked
 * @param entry the room's metadata, as `joinMetadata()` returns
 */
export function describeRoom(id: number, rank: number, total: number, entry: RoomMeta | null = null): Description {
  const keywords = entry?.keywords?.length ? entry.keywords.map((k) => k.text).join(', ') : null;

  return {
    kind: 'room',
    name: `Room ${id}, rank ${rank + 1} of ${total} — ${keywords ?? 'no description recorded'}`,
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
 * "9 clustered near the center" versus "spread evenly" is the difference
 * between a query the corpus could answer and one it could not, said in one
 * clause rather than shown in one second of motion.
 *
 * Deliberately says nothing about the animation, or about whether there was
 * one: reduced motion rebuilds the map at once and the outcome is identical,
 * so an announcement that mentioned sliding would be describing the half of
 * this that is optional.
 */
export function describeArrangement(layout: Pick<MapLayout, 'roomCount' | 'gradedCount'>): string {
  const rooms = `${layout.roomCount} rooms on the map`;
  return layout.gradedCount
    ? `rearranged - ${rooms}, ${layout.gradedCount} clustered near the center`
    : `rearranged - ${rooms}, spread evenly`;
}

export interface DescribeCatalogOptions {
  /** rooms in the list */
  total: number;
  /** the search the list is ordered by, if any */
  query?: string;
  /** `describeSignals`' account of what ranked it */
  note?: string;
}

/**
 * What the catalog is showing, for the live region a mode switch or a search
 * writes to.
 *
 * A sibling of `describeArrangement` rather than a reuse of it, because that
 * one talks about clustering near the center and there is no center here. The
 * catalog answers a different question - the map is where you are standing, the
 * catalog is the ranking - so it gets its own sentence rather than a borrowed
 * one that would be subtly false.
 */
export function describeCatalog({ total, query = '', note = '' }: DescribeCatalogOptions): string {
  const head = query.trim()
    ? `the catalog, ${total} rooms ranked for “${query.trim()}”`
    : `the catalog, ${total} rooms in alphabetical order`;
  return [head, note].filter(Boolean).join('. ');
}

/**
 * What just happened when a reader changed the sort.
 *
 * Said after the rearrangement lands, like every other arrangement sentence
 * here. The count is the point of the "mine" reading - a sort that moved
 * nothing because nothing is favorited yet looks identical on the map, and
 * this is the only thing that can say so.
 */
export function describeSort(mode: 'relevance' | 'mine' | 'count', mineCount: number): string {
  if (mode === 'mine')
    return mineCount
      ? `sorted by your favorites — ${mineCount} ${mineCount === 1 ? 'room' : 'rooms'} first`
      : 'sorted by your favorites — you have not favorited any rooms yet';
  if (mode === 'count') return 'sorted by how often each room has been favorited';
  return 'sorted by search ranking again';
}
