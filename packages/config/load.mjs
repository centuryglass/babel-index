/**
 * Reading `config.json` off disk, kept apart from the defaults and validation in
 * `config.mjs` so that file needs no filesystem to be tested.
 *
 * The overlay is optional and partial. Absent, the app runs on `DEFAULTS`
 * exactly; present, it need only carry the keys being changed - which is what
 * keeps `DEFAULTS` the single statement of every default rather than a second
 * copy of a committed file. That is also why no `config.json` is committed:
 * one that spelled out every value would silently become the real tuning
 * surface, and editing the documented defaults would stop having any effect.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveConfig } from './config.mjs';

export const CONFIG_FILE = 'config.json';

/**
 * Load and resolve the config.
 *
 * A missing file is the normal case and says nothing. A file that exists but
 * cannot be read or parsed *does* say something - it was meant to take effect
 * and did not - so it lands in `notes` rather than being swallowed.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] overlay path; defaults to `config.json` in cwd
 * @param {{min: number, max: number}} [opts.zoomLimits]
 * @returns {Promise<object>} the resolved config, plus `source` and `notes`
 */
export async function loadConfig({ path, zoomLimits } = {}) {
  const file = resolve(process.cwd(), path ?? CONFIG_FILE);

  let raw = {};
  let source = null;
  const problems = [];
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
    source = file;
  } catch (err) {
    if (err.code !== 'ENOENT') problems.push(`could not read ${file}: ${err.message}; using defaults`);
    // An explicitly requested file that is not there is worth saying, since the
    // caller asked for it by name. The default path being absent is not.
    else if (path) problems.push(`no such config file: ${file}; using defaults`);
  }

  const config = resolveConfig(raw, { zoomLimits });
  return { ...config, source, notes: [...problems, ...config.notes] };
}
