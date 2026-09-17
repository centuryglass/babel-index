/**
 * Naming what the reader is standing in, in their own words.
 *
 * What a screen reader announces on arrival at a cell, and the label the
 * room card and the ranked listbox both reuse - one implementation, more
 * than one consumer, the same split `picking.ts` and `center.ts` already
 * make for hit-testing. Pure, no DOM, no runtime imports, so the words a
 * reader hears can be asserted without a browser.
 *
 * `describeCell` names a cell and `describeRoom` names a room the caller
 * already holds; the announcement builders (`describeArrangement`,
 * `describeCatalog`, `describeSort`) say what the library just became.
 *
 * The name stays short - it is read on every arrival, not opened on
 * request - so a room's keywords go in and its story does not. The story is
 * the `description`, read separately (a card's body, a listbox option's
 * extra text), and it is honest when there is nothing to say: a room with
 * no metadata is ranked like any other and must not be described as though
 * it had a story it does not.
 *
 * ### `picture`
 *
 * `picture` is the third and rarest field: the sidecar's optional `alt`,
 * one sentence about the image rather than about the room (see
 * `metadata.ts` for how it is written). For a real room it is never
 * generated at runtime - it arrives with the corpus or it does not arrive
 * at all. A generic cell is the one exception: every generic tile shows the
 * same kind of image (a shelf wall of illegible spines) no matter which of
 * the placeholder files is drawn, so one fixed sentence in `describeCell`
 * covers all of them. A real per-tile caption is deferred, not rejected:
 * `assets/generic/` is placeholder art meant to be swapped for real
 * inpainting output, and a caption written against art that is not the
 * shipping art describes nothing.
 */

import type { MapLayout } from './ordering.ts';
import type { RoomMeta } from './metadata.ts';

/** What a reader can be told about one cell or room: a name, its story, and a caption for the picture. */
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
      // Unlike the center, a generic cell gets a `description` too - it is
      // shown in the dialog opened on it (`RoomOverlay`/`RoomDetails`), and
      // the thing worth telling a reader who opens one is that it is
      // wallpaper, not an unindexed room.
      description:
        'A library wall, plain and identical to countless others, its shelves filled with nonsense. There is nothing to find here.',
      // The one place `picture` is generated rather than read from a
      // sidecar (preamble, "`picture`"). Every unique room's own alt text
      // is written to assume this base scene is already known and skip
      // re-describing it - see `tools/curation/babel_index_review/core.py`'s
      // `BASE_SCENE` and `default_alt_prompt` - so this is the one place in
      // the app that scene gets spelled out for a reader who has not
      // necessarily opened a unique room yet. If `BASE_SCENE` ever changes,
      // this needs to change with it - nothing enforces that automatically
      // across the Python/TypeScript split.
      picture:
        'A wooden bookshelf built into a dark wood-panelled wall: five shelves of ' +
        'identical books with dull red spines and illegible gold lettering, a round ' +
        'wall-mounted lamp glowing above the shelf, and a plain wooden column on ' +
        'either side. This is the plain, unmodified scene every unique room is a ' +
        'variation on, repeated here as filler with nothing of its own to find.',
    };

  return describeRoom(at.id, at.rank, order.length, metadata?.[at.id] ?? null);
}

/**
 * The same naming, for a caller that already knows which room it is holding.
 *
 * `describeCell` resolves a cell and then calls this; the catalog, which has
 * no cells at all, calls it directly. One implementation of "what a room is
 * called" serves the spatial reading and the linear one, so the two views
 * cannot drift apart. Nothing about a cell, a layout or a board reaches in
 * here.
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
    // What the picture shows, as against what the room is - the sidecar's
    // optional `alt`. Separate from `description`: the story is fiction
    // about the room and the caption is a report of the image, and
    // collapsing them would let a reader take one for the other. Null far
    // more often than not - most corpora do not carry the field at all -
    // and every consumer has to read as well without it as with it.
    picture: entry?.alt ?? null,
  };
}

/**
 * What the library just became, for the moment it rearranges under a reader
 * who cannot watch it happen.
 *
 * The slide is spectacle carrying no information a non-sighted reader can
 * use; what carries the information is the search made spatial, and that is
 * a fact the layout already knows. `gradedCount` is the size of the cluster
 * the density gradient lifted above the baseline - so "9 clustered near the
 * center" versus "spread evenly" says in one clause whether the corpus
 * could answer the query, which is what the motion was for.
 *
 * Says nothing about the animation, or about whether there was one: reduced
 * motion rebuilds the map at once and the outcome is identical, so an
 * announcement that mentioned sliding would describe the optional half.
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
  /** what ranked the list, in `useSearch.ts`'s `describeSignals` words */
  note?: string;
}

/**
 * What the catalog is showing, for the live region a mode switch or a search
 * writes to.
 *
 * A sibling of `describeArrangement`, not a reuse: that one talks about
 * clustering near the center, and the catalog has no center - the map is
 * where you are standing, the catalog is the ranking. Its own sentence keeps
 * the shared claim from being borrowed into a place where it is false.
 */
export function describeCatalog({ total, query = '', note = '' }: DescribeCatalogOptions): string {
  const head = query.trim()
    ? `the catalog, ${total} rooms ranked for “${query.trim()}”`
    : `the catalog, ${total} rooms in alphabetical order`;
  return [head, note].filter(Boolean).join('. ');
}

/**
 * What just happened when a reader changed the sort - said after the
 * rearrangement lands, like every other arrangement sentence here.
 *
 * The count is the point of the `'mine'` reading: a sort that moved nothing
 * because nothing is favorited yet looks identical on the map, and this is
 * the only thing that can say so.
 */
export function describeSort(mode: 'relevance' | 'mine' | 'count' | 'random', mineCount: number): string {
  if (mode === 'mine')
    return mineCount
      ? `sorted by your favorites — ${mineCount} ${mineCount === 1 ? 'room' : 'rooms'} first`
      : 'sorted by your favorites — you have not favorited any rooms yet';
  if (mode === 'count') return 'sorted by how often each room has been favorited';
  if (mode === 'random') return 'shuffled into a new random order';
  return 'sorted by search ranking again';
}
