/**
 * Global favorite counts: the first piece of state this server has ever owned.
 *
 * A room's count is the SIZE OF A SET, not a number anyone increments. That is
 * the whole design (concept.md, 8/30/26): `add` and `remove` are set operations
 * keyed on who is asking, so hammering either endpoint moves a count by at most
 * one, and nothing an endpoint accepts can zero a room out or run it up.
 *
 * ### What is stored, and what deliberately is not
 *
 * Per room, a set of hashes - never an address, never a session, never a
 * timestamp. The hash is HMAC(salt, file + NUL + clientId), and it is keyed PER
 * ROOM on purpose: the same visitor hashes differently in every room's set, so
 * two sets cannot be joined to reconstruct one person's favorites. The cost is
 * that this store cannot count distinct visitors, which is a thing we do not
 * want to be able to do. Hashing is not a security control here and is not
 * claimed as one - it is the shape that makes the per-visitor data useless
 * while still letting a set de-duplicate.
 *
 * `clientId` is an opaque token the browser generates and keeps in
 * `localStorage` (see `useFavorites.ts`), not an IP address - an address
 * collides real visitors behind shared NAT/CGNAT together and reassigns
 * itself out from under one visitor on a rotating connection, either of which
 * reads here as a favorite that silently didn't register or one that silently
 * came back. A generated token fixes both, at the cost of being exactly as
 * easy to regenerate as clearing site data already was - which only ever
 * reverts a visitor to "not yet favorited," never lets one push a count past
 * one or pull it below zero, since that guarantee lives in the set semantics
 * above, not in how hard the identity is to obtain.
 *
 * The salt is random per store and lives in the file, so counts survive a
 * restart. Delete the file and every count is gone: there is no second copy,
 * and a salt rotation is indistinguishable from a reset.
 *
 * ### Why a JSON file rather than a database
 *
 * The data is one small map of string sets, written by one process, read on
 * page load. A file it is - held in memory, snapshotted with an atomic
 * tmp+rename on a debounce, so a burst of favorites costs one write rather than
 * one per click. `FavoriteStore` is an interface rather than this module's
 * shape directly, so a Postgres-backed implementation can replace it without
 * `app.ts` or the client learning anything new.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** How much of the HMAC is kept. 64 bits is far past collision range for a set of this size, and short files read better. */
const HASH_CHARS = 16;

/** The on-disk snapshot's shape. `version` exists so a future format change can be recognised rather than guessed at. */
interface Snapshot {
  version: 1;
  salt: string;
  rooms: Record<string, string[]>;
}

/**
 * What `app.ts` is handed. Everything is by room FILE, never by room id - ids
 * are positional (scan.ts sorts filenames and indexes them), so adding one
 * image to a corpus would silently renumber every favorite recorded against
 * an id.
 */
export interface FavoriteStore {
  /** Every room with at least one favorite. Rooms with none are absent, not zero. */
  counts(): Record<string, number>;
  /** @returns the room's new count */
  add(file: string, clientId: string): number;
  /** @returns the room's new count */
  remove(file: string, clientId: string): number;
  /** Write any pending changes now. Called on shutdown; the debounce handles the rest. */
  flush(): Promise<void>;
}

export interface JsonStoreOptions {
  /** where the snapshot lives */
  path: string;
  /** how long a change waits for company before the file is rewritten */
  flushMs?: number;
}

/**
 * A store backed by one JSON file.
 *
 * A missing file is an empty store with a fresh salt, which is the ordinary
 * first-run case. An unreadable or malformed one is NOT: it throws, because
 * silently starting empty over a file that exists would replace real counts
 * with nothing on the next write.
 */
export async function createJsonFavoriteStore({ path, flushMs = 1000 }: JsonStoreOptions): Promise<FavoriteStore> {
  const { salt, rooms } = await read(path);

  let timer: NodeJS.Timeout | null = null;
  // Writes are serialised through this rather than fired in parallel: two
  // renames onto the same path from two overlapping writes can land in either
  // order, and the loser is a stale snapshot with no way to tell.
  let writing: Promise<void> = Promise.resolve();
  let dirty = false;

  const write = (): Promise<void> => {
    if (!dirty) return writing;
    dirty = false;
    const snapshot: Snapshot = {
      version: 1,
      salt,
      rooms: Object.fromEntries([...rooms].map(([file, set]) => [file, [...set]])),
    };
    writing = writing.then(async () => {
      const tmp = `${path}.${process.pid}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, JSON.stringify(snapshot));
      // Atomic on the same filesystem, so a crash mid-write leaves the previous
      // snapshot intact rather than a truncated one.
      await rename(tmp, path);
    });
    return writing;
  };

  const touch = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void write().catch((err) => console.error(`favorites: could not write ${path}:`, err));
    }, flushMs);
    // Never hold the process open for a pending snapshot - `flush()` on
    // shutdown is what guarantees the write, not the event loop.
    timer.unref?.();
  };

  const hash = (file: string, clientId: string) =>
    createHmac('sha256', salt).update(`${file}\0${clientId}`).digest('hex').slice(0, HASH_CHARS);

  return {
    counts() {
      const out: Record<string, number> = {};
      for (const [file, set] of rooms) if (set.size) out[file] = set.size;
      return out;
    },

    add(file, clientId) {
      let set = rooms.get(file);
      if (!set) rooms.set(file, (set = new Set<string>()));
      const before = set.size;
      set.add(hash(file, clientId));
      if (set.size !== before) touch();
      return set.size;
    },

    remove(file, clientId) {
      const set = rooms.get(file);
      if (!set) return 0;
      if (set.delete(hash(file, clientId))) {
        // An emptied room is dropped rather than left as an empty array, so the
        // snapshot does not accumulate a key per room anyone ever touched.
        if (!set.size) rooms.delete(file);
        touch();
      }
      return set.size;
    },

    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await write();
      await writing;
    },
  };
}

/** The snapshot on disk, or a fresh empty store if there is nothing there yet. */
async function read(path: string): Promise<{ salt: string; rooms: Map<string, Set<string>> }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { salt: randomBytes(32).toString('hex'), rooms: new Map() };
    throw err;
  }

  const parsed = JSON.parse(raw) as Snapshot;
  if (parsed?.version !== 1 || typeof parsed.salt !== 'string' || !parsed.salt)
    throw new Error(`${path} is not a favorites snapshot this version understands`);

  const rooms = new Map<string, Set<string>>();
  for (const [file, hashes] of Object.entries(parsed.rooms ?? {}))
    if (Array.isArray(hashes) && hashes.length) rooms.set(file, new Set(hashes));
  return { salt: parsed.salt, rooms };
}
