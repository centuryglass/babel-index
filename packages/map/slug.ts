/**
 * Room permalinks: the slug in `catalog/<slug>` (also reachable at
 * `map/<slug>`, opening the same room in the other reading - see `roomPath`),
 * and the table that resolves one back to a room.
 *
 * A room's public name is its title, folded to ASCII - `catalog/unparsed-light`
 * says what a reader gets before they follow it. Titles are corpus data and can
 * be rewritten, so every room also answers to its filename stem
 * (`catalog/00121`), which `scan.ts` reads off the directory and nothing here
 * ever changes. The stem is the canonical slug for a room with no title, and a
 * permanent alias for every room that has one.
 *
 * Room ids never appear in a path. They are positional
 * (docs/agents/favorites.md, "Favorites"), so an id in a shared url comes back
 * pointing at a different room once the corpus grows.
 *
 * No DOM, so it runs on both sides: `app.ts` resolves an incoming path with
 * this and `main.tsx` builds the copy-link url with it. One implementation
 * keeps the two from drifting.
 */
import { fold } from './scoring.ts';
import type { Room } from './manifest.ts';
import type { RoomMeta } from './metadata.ts';

/**
 * Where a room's permalink sits, relative to `<base href>`.
 *
 * Takes an already url-safe slug - everything `buildSlugTable` produces is one
 * - so nothing here re-encodes and no caller has to decide whether to.
 *
 * `mode` picks which reading the link opens into once JS runs - `'catalog'`
 * (the default) for the linear list, `'map'` for the pannable map with this
 * room's overlay already open. Both are the same room at the same slug; only
 * the path segment in front of it differs, and `app.ts`'s two SSR routes are
 * otherwise identical (see its own comment on why).
 */
export function roomPath(slug: string, mode: 'catalog' | 'map' = 'catalog'): string {
  return `${mode}/${slug}`;
}

/**
 * One path segment from human text: folded to ASCII, with every run of
 * anything else collapsed to a single hyphen.
 *
 * `fold` (`scoring.ts`) is the same normalisation search matches on, so a
 * title and a query for that title agree on what its letters are. Returns ''
 * when nothing survives folding; callers decide what to use instead.
 */
export function slugify(text: string): string {
  return fold(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A filename without its final extension: `00121.webp` -> `00121`. */
export function fileStem(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/**
 * The path a room falls back on when it has no usable title.
 *
 * The percent-encoded stem is the last rung, for a filename whose every
 * character folds away. It is the one path this module can produce that is not
 * a bare slug, and it is still unique per file, which is all the lookup asks
 * of it.
 */
function stemSlug(file: string): string {
  const stem = fileStem(file);
  return slugify(stem) || encodeURIComponent(stem);
}

/** Rooms that asked for the same path, and what each one ended up with. */
export interface SlugCollision {
  /** The path they all asked for. */
  wanted: string;
  /** Each room in the group, in the corpus's own filename order. */
  rooms: { file: string; slug: string }[];
}

export interface SlugTable {
  /** Each room's canonical slug, indexed by room id. */
  slugs: string[];
  /** Every path that resolves: canonical slugs, plus filename stems as aliases. */
  lookup: Map<string, number>;
  /**
   * Rooms that wanted one path between them. Empty for a corpus whose titles
   * are unique, which is the generator's job to keep true - this is the report
   * that says when it stopped being.
   */
  collisions: SlugCollision[];
}

/**
 * Every room's canonical slug and the reverse lookup, in one pass over the
 * corpus.
 *
 * @param metadata indexed by room id, as `joinMetadata` returns it; null
 *   before the client's sidecar fetch lands, which gives every room its stem.
 */
export function buildSlugTable(rooms: Room[], metadata: (RoomMeta | null)[] | null): SlugTable {
  const stems = rooms.map((r) => stemSlug(r.file));
  const titles = rooms.map((r) => slugify(metadata?.[r.id]?.title ?? ''));

  // What each room asks for before anything is disambiguated. Grouping on this
  // rather than on the titles alone is what catches a titled room and an
  // untitled one converging on the same path.
  const wanted = rooms.map((_, i) => titles[i] || stems[i]);
  const claims = new Map<string, number[]>();
  for (let i = 0; i < rooms.length; i++) {
    const claimed = claims.get(wanted[i]);
    if (claimed) claimed.push(i);
    else claims.set(wanted[i], [i]);
  }

  // A collided title keeps its words and takes its room's stem as a suffix, so
  // both rooms stay reachable and both stay readable. Rooms with no title and
  // the same stem have nothing left to tell them apart: the first in filename
  // order takes the path, and `collisions` is how anyone finds out.
  const slugs = rooms.map((_, i) =>
    claims.get(wanted[i])!.length > 1 && titles[i] ? `${titles[i]}-${stems[i]}` : wanted[i]
  );

  const lookup = new Map<string, number>();
  for (let i = 0; i < rooms.length; i++) if (!lookup.has(slugs[i])) lookup.set(slugs[i], i);
  // Stems go in after every canonical slug, so an alias can never shadow the
  // room that holds a path outright.
  for (let i = 0; i < rooms.length; i++) if (!lookup.has(stems[i])) lookup.set(stems[i], i);

  const collisions: SlugCollision[] = [];
  for (const [path, ids] of claims)
    if (ids.length > 1)
      collisions.push({ wanted: path, rooms: ids.map((i) => ({ file: rooms[i].file, slug: slugs[i] })) });

  return { slugs, lookup, collisions };
}
