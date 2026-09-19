import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRotatingFileStream, rotatedPath } from './log-file.ts';

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'babel-log-file-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('appends writes to the file', () =>
  withTempDir(async (dir) => {
    const path = join(dir, 'server.log');
    const stream = createRotatingFileStream(path, 1_000_000);
    stream.write('one\n');
    stream.write('two\n');
    assert.equal(await readFile(path, 'utf8'), 'one\ntwo\n');
  }));

test('rotates once the file reaches maxBytes, overwriting the previous rotation', () =>
  withTempDir(async (dir) => {
    const path = join(dir, 'server.log');
    const stream = createRotatingFileStream(path, 10);
    stream.write('1234567890'); // exactly maxBytes - rotates after this write
    assert.equal(existsSync(path), false);
    assert.equal(await readFile(rotatedPath(path), 'utf8'), '1234567890');

    stream.write('abcde'); // fresh file, under threshold - no second rotation yet
    assert.equal(await readFile(path, 'utf8'), 'abcde');
    assert.equal(await readFile(rotatedPath(path), 'utf8'), '1234567890');

    stream.write('fghij'); // now over threshold again - .1 gets overwritten
    assert.equal(existsSync(path), false);
    assert.equal(await readFile(rotatedPath(path), 'utf8'), 'abcdefghij');
  }));

test('picks up an existing file size rather than assuming empty', () =>
  withTempDir(async (dir) => {
    const path = join(dir, 'server.log');
    const first = createRotatingFileStream(path, 10);
    first.write('12345');

    // A fresh stream over the same path (as a process restart would create)
    // must know the file already has 5 bytes in it, or it would take 10 more
    // bytes to rotate instead of 5.
    const second = createRotatingFileStream(path, 10);
    second.write('67890');
    assert.equal(existsSync(path), false);
    assert.equal(await readFile(rotatedPath(path), 'utf8'), '1234567890');
  }));
