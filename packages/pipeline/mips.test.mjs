import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { LEVELS } from '../web/src/pyramid.js';
import { mipPlan, writeMips, sourceImages, checkAspects, contentHash } from './mips.mjs';

/** A JPEG of the given size, synthesised - nothing here reads the sample corpus. */
async function makeImage(path, w, h, background = { r: 40, g: 34, b: 28 }) {
  const buf = await sharp({
    create: { width: w, height: h, channels: 3, background },
  })
    .jpeg()
    .toBuffer();
  await writeFile(path, buf);
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mips-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- the plan --------------------------------------------------------------

test('the plan follows the ladder, dividing both axes together', () => {
  const plan = mipPlan({ w: 1024, h: 1024 });
  assert.equal(plan.length, LEVELS.length);
  assert.deepEqual(
    plan.map((p) => p.w),
    [1024, 512, 256, 128, 64]
  );
  for (const step of plan) assert.equal(step.w, step.h, 'a square source stays square');
});

test('a non-square source keeps its aspect at every level', () => {
  const source = { w: 1280, h: 720 };
  const plan = mipPlan(source);
  const aspect = source.w / source.h;
  for (const step of plan)
    assert.ok(
      Math.abs(step.w / step.h - aspect) < 0.05,
      `level ${step.level} is ${step.w}x${step.h}, off the source aspect`
    );
  assert.deepEqual(
    plan.map((p) => `${p.w}x${p.h}`),
    ['1280x720', '640x360', '320x180', '160x90', '80x45']
  );
});

test('the directory is named for the width, which identifies the level', () => {
  for (const step of mipPlan({ w: 900, h: 675 })) assert.equal(step.dir, String(step.w));
});

test('a source too small for the ladder yields fewer levels, never duplicates', () => {
  // Divisors that round to the same width would write the same directory
  // twice - the second pass silently overwriting the first at the wrong size.
  const plan = mipPlan({ w: 4, h: 4 });
  const widths = plan.map((p) => p.w);
  assert.equal(new Set(widths).size, widths.length, `duplicate widths: ${widths}`);
  assert.ok(plan.length < LEVELS.length, `4px cannot support all ${LEVELS.length} levels`);

  // 20px still can, though - rounding keeps every rung distinct, so the tool
  // must not drop levels it is capable of writing.
  assert.equal(mipPlan({ w: 20, h: 20 }).length, LEVELS.length);
});

// --- writing ---------------------------------------------------------------

test('every level below 0 is written, at the planned size', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, '000.jpg');
    await makeImage(file, 256, 256);

    const { plan, written } = await writeMips({ file, outDir: dir, inPlace: true });
    assert.equal(written, plan.length - 1, 'every level but 0');

    for (const step of plan.slice(1)) {
      const meta = await sharp(join(dir, step.dir, '000.jpg')).metadata();
      assert.equal(meta.width, step.w, `level ${step.level} width`);
      assert.equal(meta.height, step.h, `level ${step.level} height`);
    }
  });
});

test('in place, level 0 is left alone rather than duplicated', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, '000.jpg');
    await makeImage(file, 256, 256);
    const { plan, skipped } = await writeMips({ file, outDir: dir, inPlace: true });

    assert.equal(skipped, 1);
    const entries = await readdir(dir);
    assert.ok(!entries.includes(String(plan[0].w)), 'a level-0 directory would double the bytes');
    assert.ok(entries.includes('000.jpg'), 'the source must stay where it was');
  });
});

test('to a separate directory, level 0 is copied byte for byte', async () => {
  await withTempDir(async (dir) => {
    const out = join(dir, 'pyramid');
    const file = join(dir, '000.jpg');
    await makeImage(file, 256, 256);

    const { plan, written } = await writeMips({ file, outDir: out, inPlace: false });
    assert.equal(written, plan.length, 'including level 0');

    // Copied, not re-encoded: the source art must not be requantised on its way
    // through the pipeline.
    const [src, dst] = await Promise.all([
      sharp(file).toBuffer(),
      sharp(join(out, String(plan[0].w), '000.jpg')).toBuffer(),
    ]);
    assert.deepEqual(dst, src);
  });
});

test('a non-square source survives a real resize', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'wall.jpg');
    await makeImage(file, 320, 180);
    const { plan } = await writeMips({ file, outDir: dir, inPlace: true });

    for (const step of plan.slice(1)) {
      const meta = await sharp(join(dir, step.dir, 'wall.jpg')).metadata();
      assert.equal(`${meta.width}x${meta.height}`, `${step.w}x${step.h}`);
    }
  });
});

// --- content-hash caching ----------------------------------------------------

test('a second run against an unchanged source rewrites nothing', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, '000.jpg');
    await makeImage(file, 256, 256);

    const first = await writeMips({ file, outDir: dir, inPlace: true });
    const second = await writeMips({ file, outDir: dir, inPlace: true });

    assert.ok(first.written > 0, 'the first run actually wrote levels');
    assert.equal(second.written, 0, 'nothing needed regenerating');
    assert.equal(second.cached, first.written, 'every scaled level was recognised as current');
  });
});

test('a changed source invalidates the levels scaled from it', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, '000.jpg');
    await makeImage(file, 256, 256, { r: 40, g: 34, b: 28 });
    const first = await writeMips({ file, outDir: dir, inPlace: true });

    await makeImage(file, 256, 256, { r: 200, g: 10, b: 10 }); // same size, different content
    const second = await writeMips({ file, outDir: dir, inPlace: true });

    assert.equal(second.cached, 0, 'the old hash no longer matches');
    assert.equal(second.written, first.written, 'every scaled level is regenerated');
  });
});

test('a file at the target path with no embedded hash is treated as stale', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, '000.jpg');
    await makeImage(file, 256, 256);
    const plan = mipPlan({ w: 256, h: 256 });
    const scaled = plan.find((p) => p.level !== 0);

    // A plain image with no EXIF at all, as if dropped there by something else.
    await mkdir(join(dir, scaled.dir), { recursive: true });
    await makeImage(join(dir, scaled.dir, '000.jpg'), scaled.w, scaled.h);

    const result = await writeMips({ file, outDir: dir, inPlace: true });
    assert.equal(result.cached, 0, 'an unstamped file is never trusted');
    assert.equal(result.written, result.plan.length - 1);
  });
});

test('the embedded hash matches a plain hash of the source bytes', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, '000.jpg');
    await makeImage(file, 128, 128);
    await writeMips({ file, outDir: dir, inPlace: true });

    const plan = mipPlan({ w: 128, h: 128 });
    const scaled = plan.find((p) => p.level !== 0);
    const meta = await sharp(join(dir, scaled.dir, '000.jpg')).metadata();
    const hash = await contentHash(file);

    assert.ok(meta.exif.toString('latin1').includes(hash));
  });
});

// --- scanning the source ---------------------------------------------------

test('the level directories are not mistaken for source images', async () => {
  await withTempDir(async (dir) => {
    await makeImage(join(dir, '001.jpg'), 128, 128);
    await makeImage(join(dir, '000.jpg'), 128, 128);
    await writeMips({ file: join(dir, '000.jpg'), outDir: dir, inPlace: true });

    // Re-running must resize the two originals, not the levels it just wrote -
    // otherwise every run compounds, resizing already-resized images.
    assert.deepEqual(await sourceImages(dir), ['000.jpg', '001.jpg']);
  });
});

test('non-images are ignored', async () => {
  await withTempDir(async (dir) => {
    await makeImage(join(dir, '000.jpg'), 64, 64);
    await writeFile(join(dir, 'notes.txt'), 'not an image');
    await writeFile(join(dir, 'manifest.json'), '{}');
    assert.deepEqual(await sourceImages(dir), ['000.jpg']);
  });
});

// --- aspect agreement ------------------------------------------------------

test('one shared aspect passes, whatever the sizes', () => {
  const { aspect, outliers } = checkAspects([
    { file: 'a', w: 1280, h: 720 },
    { file: 'b', w: 640, h: 360 },
  ]);
  assert.equal(outliers.length, 0);
  assert.ok(Math.abs(aspect - 16 / 9) < 1e-9);
});

test('a room of the wrong shape is named, not silently stretched', () => {
  const { outliers } = checkAspects([
    { file: 'a', w: 1024, h: 1024 },
    { file: 'b', w: 1024, h: 1024 },
    { file: 'odd', w: 1280, h: 720 },
  ]);
  assert.deepEqual(
    outliers.map((o) => o.file),
    ['odd']
  );
});

test('encoder rounding is not treated as a different shape', () => {
  // A resize can land a pixel off; that is not a corpus problem.
  const { outliers } = checkAspects([
    { file: 'a', w: 1280, h: 720 },
    { file: 'b', w: 1281, h: 720 },
  ]);
  assert.equal(outliers.length, 0);
});
