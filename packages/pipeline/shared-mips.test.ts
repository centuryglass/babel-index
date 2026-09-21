import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { writeSharedMips } from './shared-mips.ts';

async function makeImage(path: string, w: number, h: number): Promise<void> {
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 34, b: 28 } } })
    .jpeg()
    .toBuffer();
  await writeFile(path, buf);
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'shared-mips-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('pyramids the center render, every generic tile, and every distill alternate, in place', async () => {
  await withTempDir(async (dir) => {
    await makeImage(join(dir, 'center_tile.png'), 256, 256);
    await mkdir(join(dir, 'generic'), { recursive: true });
    await makeImage(join(dir, 'generic', 'g1.jpg'), 256, 256);
    await makeImage(join(dir, 'generic', 'g2.jpg'), 256, 256);
    await mkdir(join(dir, 'generic_distill'), { recursive: true });
    await makeImage(join(dir, 'generic_distill', 'g1.jpg'), 256, 256);

    const result = await writeSharedMips({ sharedDir: dir });

    assert.equal(result.center?.file, 'center_tile.png');
    assert.ok(result.center!.written > 0, 'the center gets levels below 0');
    assert.deepEqual(result.generic.map((g) => g.file), ['g1.jpg', 'g2.jpg']);
    for (const g of result.generic) assert.ok(g.written > 0);
    assert.deepEqual(result.genericDistill.map((g) => g.file), ['g1.jpg']);
    for (const g of result.genericDistill) assert.ok(g.written > 0);

    // Written beside the source, the same per-file layout mips.ts uses.
    const centerLevel = (await sharp(join(dir, '128', 'center_tile.png')).metadata());
    assert.equal(centerLevel.width, 128);
    const genericLevel = await sharp(join(dir, 'generic', '128', 'g1.jpg')).metadata();
    assert.equal(genericLevel.width, 128);
    const distillLevel = await sharp(join(dir, 'generic_distill', '128', 'g1.jpg')).metadata();
    assert.equal(distillLevel.width, 128);
  });
});

test('other shared-directory art is never mistaken for the center tile', async () => {
  await withTempDir(async (dir) => {
    // Badges, toggles and the rest of the fixed app art sit right beside the
    // center render at the top level - only the center-naming rule may match.
    await makeImage(join(dir, 'center.jpg'), 256, 256);
    await makeImage(join(dir, 'fav_on.png'), 32, 32);
    await makeImage(join(dir, 'distill_off.png'), 32, 32);

    const result = await writeSharedMips({ sharedDir: dir });
    assert.equal(result.center?.file, 'center.jpg');

    // The badges never got a pyramid of their own.
    let threw = false;
    try {
      await sharp(join(dir, '128', 'fav_on.png')).metadata();
    } catch {
      threw = true;
    }
    assert.ok(threw, 'no pyramid was written for the badge art');
  });
});

test('no center file found is a null result, not an error', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'generic'), { recursive: true });
    await makeImage(join(dir, 'generic', 'g1.jpg'), 256, 256);

    const result = await writeSharedMips({ sharedDir: dir });
    assert.equal(result.center, null);
    assert.equal(result.generic.length, 1);
  });
});

test('an absent generic directory yields no generic results, not a throw', async () => {
  await withTempDir(async (dir) => {
    await makeImage(join(dir, 'center.jpg'), 128, 128);
    const result = await writeSharedMips({ sharedDir: dir });
    assert.deepEqual(result.generic, []);
  });
});

test('an absent generic_distill directory yields no distill results, not a throw', async () => {
  await withTempDir(async (dir) => {
    await makeImage(join(dir, 'center.jpg'), 128, 128);
    await mkdir(join(dir, 'generic'), { recursive: true });
    await makeImage(join(dir, 'generic', 'g1.jpg'), 128, 128);
    const result = await writeSharedMips({ sharedDir: dir });
    assert.deepEqual(result.genericDistill, []);
  });
});

test('a second run against unchanged tiles rewrites nothing', async () => {
  await withTempDir(async (dir) => {
    await makeImage(join(dir, 'center.jpg'), 128, 128);
    await mkdir(join(dir, 'generic'), { recursive: true });
    await makeImage(join(dir, 'generic', 'g1.jpg'), 128, 128);

    const first = await writeSharedMips({ sharedDir: dir });
    const second = await writeSharedMips({ sharedDir: dir });

    assert.ok(first.center!.written > 0);
    assert.equal(second.center!.written, 0);
    assert.equal(second.generic[0].written, 0);
  });
});

test('--center names the file explicitly, same as scan.ts', async () => {
  await withTempDir(async (dir) => {
    await makeImage(join(dir, 'render_002.png'), 128, 128);
    const result = await writeSharedMips({ sharedDir: dir, center: 'render_002.png' });
    assert.equal(result.center?.file, 'render_002.png');
  });
});
