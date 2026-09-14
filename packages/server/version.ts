/**
 * Which revision this process is running, for `/api/health` to report.
 *
 * The deploy workflow (`.github/workflows/deploy.yml`) asks the live server
 * which commit it is serving and compares it against the one it just pushed.
 * That comparison is what makes a deploy verified rather than "something
 * answered on the port": a restart that left the old process alive, a
 * checkout in a directory the unit file doesn't point at, a second copy of
 * the repo on the box - each of those answers 200, and none of them answers
 * with the right sha.
 *
 * `BABEL_COMMIT` is read first so a container image or any other deployment
 * with no working tree can still state its own revision (the Dockerfile
 * copies sources, not `.git`). Otherwise the checkout's own `.git` is read
 * directly rather than shelling out to `git rev-parse` - one synchronous file
 * read at startup, and no dependency on git being installed at all on a box
 * that only ever runs the server.
 *
 * A `.git` FILE rather than a directory - a worktree or a submodule checkout -
 * reads as null instead of following the indirection, because `BABEL_COMMIT`
 * already covers every deployment shape that lacks a plain `.git` directory.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHA = /^[0-9a-f]{40}$/;

/** File contents, or null for anything unreadable - a missing `.git` is the
 *  ordinary case here (a tarball deploy, a container), not an error. */
function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The full commit sha this checkout is at, or null if it cannot be
 * established. Never throws: a server that cannot name its revision still
 * serves the library, it just cannot have its deploy verified.
 *
 * @param repoRoot the directory holding `.git`
 * @param env      overridable for tests
 */
export function resolveCommit(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const declared = env.BABEL_COMMIT?.trim().toLowerCase();
  if (declared && SHA.test(declared)) return declared;

  const gitDir = join(repoRoot, '.git');
  const head = read(join(gitDir, 'HEAD'))?.trim();
  if (!head) return null;

  // A detached HEAD holds the sha itself; otherwise it names the ref to follow.
  if (SHA.test(head)) return head;
  if (!head.startsWith('ref: ')) return null;
  const ref = head.slice('ref: '.length).trim();
  if (!ref.startsWith('refs/')) return null;

  const loose = read(join(gitDir, ref))?.trim();
  if (loose && SHA.test(loose)) return loose;

  // `git gc` (and `git pack-refs`) moves refs out of their own files into one
  // packed list, so a long-lived checkout may have no `.git/refs/heads/main`
  // to read at all - reading only the loose file would report null on exactly
  // the boxes that have been up longest.
  for (const line of read(join(gitDir, 'packed-refs'))?.split('\n') ?? []) {
    // '#' is the header, '^' the peeled target of the tag on the line above.
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  return null;
}
