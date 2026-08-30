/**
 * The few things that survive a reload, and the reason so few do.
 *
 * Everything in this app is runtime state by default - the camera, the current
 * ranking, the mode, the dev sliders - and that is deliberate rather than
 * unfinished. Restoring a reader to a camera position they cannot remember
 * choosing is disorienting, and the opening view is DERIVED from the display
 * (`fitZoom` in main.jsx) precisely so it is right on whatever device is in
 * front of them rather than right on the one they used last.
 *
 * Four things earn an exception, all of them the reader's own choices rather
 * than the map's state: which way they page the catalog, what they have
 * searched for, which sensitive-content tags they have blocked, and which
 * rooms they have favorited. The
 * second is the consequential one - the search history titles the center
 * room's shelf, so persisting it means the wall of books becomes a record of
 * what this reader has asked the library instead of resetting to keyword tags
 * every session. Blocked tags are consequential in the other direction: they
 * are a standing choice about what a reader does not want to see, so it has
 * to survive a reload the same way the choice to see it again would.
 *
 * ### Why every call is wrapped
 *
 * `localStorage` is not a safe object. Safari in private mode throws on
 * `setItem`, a browser configured to block site data throws on the accessor
 * ITSELF, and stored JSON can be anything by the time it is read back. None of
 * those are reasons for a search to fail, so a read that throws returns the
 * fallback and a write that throws is dropped: with storage unavailable the app
 * behaves exactly as it did before this file existed, which is the whole
 * requirement.
 *
 * No React, no DOM beyond the one accessor, so the failure modes are assertable
 * with an injected stub.
 */

/** The slice of the `Storage` interface this module actually calls, so a test stub need not fake the rest. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Everything this app stores is under one prefix, so it is greppable and clearable. */
const PREFIX = 'babel:';

export const KEYS = {
  /** Past searches, newest first - the center shelf's book titles. */
  history: `${PREFIX}history`,
  /** 'scroll' or 'pages' - how the catalog advances. */
  paging: `${PREFIX}paging`,
  /** Sensitive-content tags a reader has chosen to block, from HelpDialog's panel. */
  blockedTags: `${PREFIX}blockedTags`,
  /**
   * The reader's own favorites, as room FILENAMES.
   *
   * Here rather than on the server on purpose (concept.md, 8/30/26): the
   * server records global counts and nothing per-visitor, so a personal list
   * is only ever kept by the person it belongs to. Filenames rather than room
   * ids because ids are positional - scan.ts sorts filenames and indexes them,
   * so one image added to the corpus renumbers every id after it and a stored
   * id would silently come back pointing at a different room.
   */
  favorites: `${PREFIX}favorites`,
};

/**
 * The storage to use, or null if there is none.
 *
 * Reading `window.localStorage` can itself throw, which is why this is a
 * function call in a try rather than a module-scope constant.
 */
function storage(override?: StorageLike | null): StorageLike | null {
  if (override !== undefined) return override;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a stored value, or `fallback` if there is nothing usable there.
 *
 * `validate` is what keeps junk from reaching the app: storage is editable by
 * hand and survives across versions of this code, so "it parsed" is not the
 * same as "it is what this release expects". A value that fails it is treated
 * exactly like a value that was never written.
 *
 * @param key one of `KEYS`
 * @param opts.store injected, for tests
 */
export function load<T>(
  key: string,
  fallback: T,
  { validate = () => true, store }: { validate?: (value: unknown) => boolean; store?: StorageLike | null } = {},
): T {
  const s = storage(store);
  if (!s) return fallback;
  try {
    const raw = s.getItem(key);
    if (raw == null) return fallback;
    const value = JSON.parse(raw);
    return validate(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Write a value, or silently do nothing if storage will not take it.
 *
 * Returns whether it landed, for a caller that wants to know - nothing in the
 * app does today, because there is no useful thing to tell a reader whose
 * browser declines to remember their paging preference.
 *
 */
export function save(key: string, value: unknown, { store }: { store?: StorageLike | null } = {}): boolean {
  const s = storage(store);
  if (!s) return false;
  try {
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Forget one stored value. Used by the panel's "forget searches" control. */
export function clear(key: string, { store }: { store?: StorageLike | null } = {}): boolean {
  const s = storage(store);
  if (!s) return false;
  try {
    s.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
