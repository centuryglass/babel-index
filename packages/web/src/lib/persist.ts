/**
 * The few things that survive a reload, and the reason so few do.
 *
 * Everything in this app is runtime state by default - the camera, the current
 * ranking, the mode, the dev sliders. That is deliberate, not unfinished:
 * restoring a reader to a camera position they cannot remember choosing is
 * disorienting, and the opening view is derived from the display (`fitZoom`,
 * `main.tsx`) so it is right on whatever device is in front of them rather
 * than on the one they used last. The exceptions are the entries in `KEYS`,
 * mostly the reader's own choices rather than the map's state; each key's
 * comment carries why it earns storage.
 *
 * ### Why every call is wrapped
 *
 * `localStorage` is not a safe object. Safari in private mode throws on
 * `setItem`, a browser configured to block site data throws on the accessor
 * itself, and stored JSON can be anything by the time it is read back. None of
 * those are reasons for a search to fail, so a read that throws returns the
 * fallback and a write that throws is dropped: with storage unavailable the app
 * behaves as if nothing was ever stored, which is the whole requirement.
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
  /** 'scroll' or 'pages' - how the catalog advances; a reading preference, not session state. */
  paging: `${PREFIX}paging`,
  /**
   * Sensitive-content tags a reader has chosen to block, from HelpDialog's
   * panel - a standing choice about what they do not want to see, so it
   * survives a reload the same way the choice to unblock would.
   */
  blockedTags: `${PREFIX}blockedTags`,
  /**
   * The reader's own favorites, as room filenames.
   *
   * Kept here rather than on the server: the server records global counts and
   * nothing per-visitor (`packages/server/favorites.ts`), so a personal list
   * is only ever kept by the person it belongs to. Filenames rather than room
   * ids because ids are positional - `scan.ts` sorts filenames and indexes
   * them, so one image added to the corpus renumbers every id after it and a
   * stored id would silently come back pointing at a different room.
   */
  favorites: `${PREFIX}favorites`,
  /**
   * Whether the one-time nudge toward the "READ ME" book has already been
   * shown - not a choice, just so the nudge shows once rather than every
   * visit.
   */
  seenHelpHint: `${PREFIX}seenHelpHint`,
  /**
   * This browser's own random id for global favorite writes - the token the
   * server hashes, with the room's filename, into the room's favorite set
   * (`packages/server/favorites.ts`). It has to survive a reload or every
   * visit would look like a new visitor.
   */
  favoriteClientId: `${PREFIX}favoriteClientId`,
};

/**
 * This browser's id for favorite writes, generating and persisting one on
 * first use.
 *
 * With no storage the id is not stable: a fresh id every call would make
 * every write from that session look like a different visitor, which is worse
 * than one id that happens not to survive a reload. Callers that need one id
 * for the page's lifetime call this once and hold the result, which is what
 * `useFavorites.ts` does.
 */
export function getOrCreateFavoriteClientId({ store }: { store?: StorageLike | null } = {}): string {
  const existing = load<string>(KEYS.favoriteClientId, '', {
    validate: (v) => typeof v === 'string' && v.length >= 8,
    store,
  });
  if (existing) return existing;
  const id = globalThis.crypto?.randomUUID?.() ?? randomFallbackId();
  save(KEYS.favoriteClientId, id, { store });
  return id;
}

/** Used only where `crypto.randomUUID` is unavailable - old browsers, non-secure contexts. */
function randomFallbackId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

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
 * same as "it is what this release expects". A value that fails it reads as
 * one that was never written.
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
 * Returns whether it landed, for a caller that wants to know - no current
 * caller does, because there is nothing useful to tell a reader whose browser
 * declines to remember their paging preference.
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
