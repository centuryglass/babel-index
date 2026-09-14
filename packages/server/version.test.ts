import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCommit } from './version.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** A throwaway directory with whatever `.git` contents a case needs. */
async function checkout(
  files: Record<string, string>,
  run: (root: string) => void | Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'babel-version-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      const path = join(root, name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, body);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('BABEL_COMMIT wins over the checkout, for deployments with no working tree', async () => {
  await checkout({ '.git/HEAD': `${B}\n` }, (root) => {
    assert.equal(resolveCommit(root, { BABEL_COMMIT: A }), A);
    assert.equal(resolveCommit(root, { BABEL_COMMIT: `  ${A.toUpperCase()}  ` }), A);
  });
});

test('a malformed BABEL_COMMIT falls through to the checkout rather than being reported', async () => {
  await checkout({ '.git/HEAD': `${B}\n` }, (root) => {
    assert.equal(resolveCommit(root, { BABEL_COMMIT: 'HEAD' }), B);
    assert.equal(resolveCommit(root, { BABEL_COMMIT: 'abc123' }), B);
    assert.equal(resolveCommit(root, { BABEL_COMMIT: '' }), B);
  });
});

test('a detached HEAD holds the sha itself', async () => {
  await checkout({ '.git/HEAD': `${A}\n` }, (root) => {
    assert.equal(resolveCommit(root, {}), A);
  });
});

test('a branch is followed to its loose ref file', async () => {
  await checkout({ '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': `${A}\n` }, (root) => {
    assert.equal(resolveCommit(root, {}), A);
  });
});

test('a packed ref is followed too - a packed checkout has no loose file left', async () => {
  await checkout(
    {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/packed-refs': [
        '# pack-refs with: peeled fully-peeled sorted',
        `${B} refs/heads/other`,
        `${A} refs/heads/main`,
        `${B} refs/tags/v1`,
        `^${A}`,
        '',
      ].join('\n'),
    },
    (root) => {
      assert.equal(resolveCommit(root, {}), A);
    }
  );
});

test('a loose ref wins over a stale packed one', async () => {
  await checkout(
    {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/refs/heads/main': `${A}\n`,
      '.git/packed-refs': `${B} refs/heads/main\n`,
    },
    (root) => {
      assert.equal(resolveCommit(root, {}), A);
    }
  );
});

test('anything it cannot establish is null, never a throw', async () => {
  // No .git at all - a container, or a tarball deploy.
  await checkout({}, (root) => assert.equal(resolveCommit(root, {}), null));
  // A ref that resolves nowhere: HEAD names a branch with no file and no
  // packed entry (a freshly `git init`ed directory).
  await checkout({ '.git/HEAD': 'ref: refs/heads/main\n' }, (root) =>
    assert.equal(resolveCommit(root, {}), null)
  );
  // A worktree or submodule, where `.git` is a file pointing elsewhere.
  await checkout({ '.git': 'gitdir: /somewhere/else\n' }, (root) =>
    assert.equal(resolveCommit(root, {}), null)
  );
  // Garbage in HEAD.
  await checkout({ '.git/HEAD': 'not a ref\n' }, (root) => assert.equal(resolveCommit(root, {}), null));
});
