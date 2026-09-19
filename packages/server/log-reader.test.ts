import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecentLogs } from './log-reader.ts';
import { rotatedPath } from './log-file.ts';

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'babel-log-reader-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const line = (level: number, msg: string) => JSON.stringify({ level, msg, time: 0 }) + '\n';

test('reads entries from the current file, oldest first', () =>
  withTempDir(async (dir) => {
    const path = join(dir, 'server.log');
    await writeFile(path, line(30, 'a') + line(30, 'b'));
    const entries = readRecentLogs({ path });
    assert.deepEqual(
      entries.map((e) => (e as { msg?: string }).msg),
      ['a', 'b']
    );
  }));

test('prepends the rotated file when present', () =>
  withTempDir(async (dir) => {
    const path = join(dir, 'server.log');
    await writeFile(rotatedPath(path), line(30, 'older'));
    await writeFile(path, line(30, 'newer'));
    const entries = readRecentLogs({ path });
    assert.deepEqual(
      entries.map((e) => (e as { msg?: string }).msg),
      ['older', 'newer']
    );
  }));

test('missing file(s) read as no entries rather than throwing', () =>
  withTempDir(async (dir) => {
    const entries = readRecentLogs({ path: join(dir, 'nope.log') });
    assert.deepEqual(entries, []);
  }));

test('a line that is not JSON comes back as { raw } instead of being dropped', () =>
  withTempDir(async (dir) => {
    const path = join(dir, 'server.log');
    await writeFile(path, 'not json\n' + line(30, 'a'));
    const entries = readRecentLogs({ path });
    assert.deepEqual(entries[0], { raw: 'not json' });
  }));

test('limit keeps only the most recent N entries', () =>
  withTempDir(async (dir) => {
    const path = join(dir, 'server.log');
    await writeFile(path, line(30, 'a') + line(30, 'b') + line(30, 'c'));
    const entries = readRecentLogs({ path, limit: 2 });
    assert.deepEqual(
      entries.map((e) => (e as { msg?: string }).msg),
      ['b', 'c']
    );
  }));

test('minLevel filters parsed entries below the threshold but keeps raw lines', () =>
  withTempDir(async (dir) => {
    const path = join(dir, 'server.log');
    await writeFile(path, 'unparseable\n' + line(20, 'debug') + line(50, 'error'));
    const entries = readRecentLogs({ path, minLevel: 50 });
    assert.deepEqual(entries, [{ raw: 'unparseable' }, { level: 50, msg: 'error', time: 0 }]);
  }));
