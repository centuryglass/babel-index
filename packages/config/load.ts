/**
 * Reading `config.json` off disk, kept apart from the defaults and validation in
 * `config.ts` so that file needs no filesystem to be tested.
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
import { resolveConfig, type Config, type ZoomLimits } from './config.ts';

export const CONFIG_FILE = 'config.json';

export interface LoadConfigOptions {
  /** overlay path; defaults to `config.json` in cwd */
  path?: string;
  zoomLimits?: ZoomLimits;
}

export type LoadedConfig = Config & { source: string | null };

/**
 * Load and resolve the config.
 *
 * A missing file is the normal case and says nothing. A file that exists but
 * cannot be read or parsed *does* say something - it was meant to take effect
 * and did not - so it lands in `notes` rather than being swallowed.
 *
 * @returns the resolved config, plus `source` (where the overlay came from, if anywhere)
 */
export async function loadConfig({ path, zoomLimits }: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const file = resolve(process.cwd(), path ?? CONFIG_FILE);

  let raw: unknown = {};
  let source: string | null = null;
  const problems: string[] = [];
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
    source = file;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = (err as Error).message;
    if (code !== 'ENOENT') problems.push(`could not read ${file}: ${message}; using defaults`);
    // An explicitly requested file that is not there is worth saying, since the
    // caller asked for it by name. The default path being absent is not.
    else if (path) problems.push(`no such config file: ${file}; using defaults`);
  }

  const config = resolveConfig(raw, { zoomLimits });
  return { ...config, source, notes: [...problems, ...config.notes] };
}
