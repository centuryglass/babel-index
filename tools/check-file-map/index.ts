#!/usr/bin/env node
/**
 * Fails if `docs/file_map.md` and the real tree have drifted: a path the
 * map lists that no longer exists, or a real file (other than a unit test
 * or an image - see EXCLUDE below) the map never mentions. `npm run
 * check:file-map`, and the `lint` CI job so a PR can't merge with the map
 * out of sync (see `AGENTS.md`'s Layout section on why the map is treated
 * as part of the change).
 *
 * Tracked files come from `git ls-files` rather than a recursive `fs`
 * walk, so `.gitignore`d build output and `node_modules` are never in
 * scope. A path the map resolves to a real directory is opaque - every
 * tracked file under it counts as documented, matching the map's own
 * convention for a directory bullet with no nested children (`infra`,
 * `tools/curation`, ...).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFileMap } from './lib.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FILE_MAP_PATH = 'docs/file_map.md';

// Filenames/extensions the map is never required to mention: tests (see
// AGENTS.md's "Tests sit next to the code") and images.
const TEST_RE = /\.(test\.(ts|mjs)|e2e\.ts|parity\.ts)$/;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|ico|svg)$/i;

function isExcluded(repoPath: string): boolean {
  const base = repoPath.split('/').pop() ?? repoPath;
  if (base === '.gitignore') return true;
  if (TEST_RE.test(base)) return true;
  if (IMAGE_RE.test(base)) return true;
  return false;
}

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function isSymlink(repoPath: string): boolean {
  try {
    return lstatSync(join(REPO_ROOT, repoPath)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every tracked file under `dirPath`, repo-root-relative. */
function walkTrackedDir(dirPath: string): string[] {
  const out = execFileSync('git', ['ls-files', '--', dirPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

function main(): number {
  const markdown = readFileSync(join(REPO_ROOT, FILE_MAP_PATH), 'utf8');
  const leaves = parseFileMap(markdown);

  const documented = new Set<string>();
  const missing: string[] = [];

  for (const leaf of leaves) {
    const absPath = join(REPO_ROOT, leaf.path);
    if (!existsSync(absPath)) {
      missing.push(leaf.path);
      continue;
    }
    if (statSync(absPath).isDirectory()) {
      for (const f of walkTrackedDir(leaf.path)) documented.add(f);
    } else {
      documented.add(leaf.path);
    }
  }

  const undocumented = trackedFiles().filter(
    (f) => f !== FILE_MAP_PATH && !isSymlink(f) && !isExcluded(f) && !documented.has(f),
  );

  if (missing.length > 0) {
    console.error(`${FILE_MAP_PATH} lists paths that no longer exist:`);
    for (const m of missing) console.error(`  ${m}`);
  }
  if (undocumented.length > 0) {
    console.error(`Tracked files missing from ${FILE_MAP_PATH}:`);
    for (const u of undocumented) console.error(`  ${u}`);
  }
  if (missing.length > 0 || undocumented.length > 0) {
    console.error(`\nUpdate ${FILE_MAP_PATH} to match (see AGENTS.md's Layout section).`);
    return 1;
  }

  console.log(`${FILE_MAP_PATH} matches the tree.`);
  return 0;
}

process.exitCode = main();
