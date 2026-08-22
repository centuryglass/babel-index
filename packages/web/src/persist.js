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
 * Two things earn an exception, both of them the reader's own choices rather
 * than the map's state: which way they page the catalog, and what they have
 * searched for. The second is the consequential one - the search history titles
 * the centre room's shelf, so persisting it means the wall of books becomes a
 * record of what this reader has asked the library instead of resetting to
 * keyword tags every session.
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

/** Everything this app stores is under one prefix, so it is greppable and clearable. */
const PREFIX = 'babel:';

export const KEYS = {
  /** Past searches, newest first - the centre shelf's book titles. */
  history: `${PREFIX}history`,
  /** 'scroll' or 'pages' - how the catalog advances. */
  paging: `${PREFIX}paging`,
};

/**
 * The storage to use, or null if there is none.
 *
 * Reading `window.localStorage` can itself throw, which is why this is a
 * function call in a try rather than a module-scope constant.
 */
function storage(override) {
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
 * @param {string} key one of `KEYS`
 * @param {*} fallback
 * @param {object} [opts]
 * @param {(value: *) => boolean} [opts.validate]
 * @param {Storage|null} [opts.store] injected, for tests
 */
export function load(key, fallback, { validate = () => true, store } = {}) {
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
 * @returns {boolean}
 */
export function save(key, value, { store } = {}) {
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
export function clear(key, { store } = {}) {
  const s = storage(store);
  if (!s) return false;
  try {
    s.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
