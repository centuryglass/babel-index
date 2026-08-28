import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { imageSize, scanDirectory, discoverLevels } from './scan.ts';
import * as fixture from './image-fixtures.ts';

/**
 * A throwaway corpus in a temp directory. Names may contain a `/`, which is how
 * a test builds the pyramid's `<width>/` level directories.
 * @param {Record<string, Buffer|string>} files
 */
async function corpus(files, run) {
  const dir = await mkdtemp(join(tmpdir(), 'babel-scan-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      const path = join(dir, name);
      if (name.includes('/')) await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const sized = (buf, name = 'x.bin') => corpus({ [name]: buf }, (dir) => imageSize(join(dir, name)));

// --- header parsing ---------------------------------------------------------

test('reads PNG dimensions from IHDR', async () => {
  assert.deepEqual(await sized(fixture.png(1024, 768)), { w: 1024, h: 768 });
  assert.deepEqual(await sized(fixture.png(1, 1)), { w: 1, h: 1 });
});

test('reads JPEG dimensions by walking to the frame header', async () => {
  assert.deepEqual(await sized(fixture.jpeg(1024, 1024)), { w: 1024, h: 1024 });
  // A wide image: proves width and height are not transposed, which a square
  // test corpus would never catch.
  assert.deepEqual(await sized(fixture.jpeg(1920, 1080)), { w: 1920, h: 1080 });
  // Progressive JPEGs use SOF2, and are most of what a diffusion pipeline emits.
  assert.deepEqual(await sized(fixture.jpeg(640, 480, { marker: 0xc2 })), { w: 640, h: 480 });
});

test('JPEG walking skips the markers that share the SOF range', async () => {
  // 0xc4 (DHT), 0xc8 (JPG) and 0xcc (DAC) sit inside 0xc0..0xcf but are not
  // frame headers. Reading one as a frame yields plausible-looking garbage.
  const buf = fixture.jpeg(1200, 900, { before: [0xe0, 0xc4, 0xcc, 0xc8, 0xe1] });
  assert.deepEqual(await sized(buf), { w: 1200, h: 900 });
});

test('reads all three WebP flavours', async () => {
  assert.deepEqual(await sized(fixture.webpVp8(1024, 1024)), { w: 1024, h: 1024 });
  assert.deepEqual(await sized(fixture.webpVp8l(800, 600)), { w: 800, h: 600 });
  assert.deepEqual(await sized(fixture.webpVp8x(4096, 2160)), { w: 4096, h: 2160 });
});

test('unreadable headers give null rather than throwing or guessing', async () => {
  // Size is an optimisation - the client falls back to the natural size once
  // the image loads - so being wrong is worse than admitting ignorance.
  assert.equal(await sized(fixture.truncatedJpeg()), null);
  assert.equal(await sized(fixture.notAnImage()), null);
  assert.equal(await sized(Buffer.alloc(0)), null);
  assert.equal(await sized(Buffer.from([0xff, 0xd8])), null);
  // RIFF, but not a WebP.
  assert.equal(await sized(Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(64)])), null);
});

test('a corrupt header does not hang the scan', async () => {
  // A segment length of zero would walk backwards forever if the parser
  // trusted it.
  const evil = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]), Buffer.alloc(64, 0xff)]);
  assert.equal(await sized(evil), null);
});

// --- directory rules --------------------------------------------------------

const three = () => ({
  '001.jpg': fixture.jpeg(512, 512),
  '002.png': fixture.png(256, 256),
  '003.webp': fixture.webpVp8(128, 128),
});

test('scans a directory into a manifest', async () => {
  await corpus({ ...three(), 'center.png': fixture.png(1024, 1024) }, async (dir) => {
    const m = await scanDirectory(dir);
    assert.equal(m.mode, 'offline');
    assert.equal(m.directory, dir);
    assert.equal(m.count, 3);
    assert.equal(m.rooms.length, m.count);
    assert.deepEqual(
      m.rooms.map((r) => r.file),
      ['001.jpg', '002.png', '003.webp']
    );
    assert.deepEqual(m.rooms.map((r) => r.id), [0, 1, 2]);
    for (const room of m.rooms) {
      assert.equal(room.url, `/images/${room.file}`);
      assert.ok(room.bytes > 0);
    }
    assert.deepEqual(m.rooms[0], {
      id: 0, file: '001.jpg', url: '/images/001.jpg', bytes: m.rooms[0].bytes, w: 512, h: 512,
    });
  });
});

test('the center tile is center.* by default, and is not also a corpus room', async () => {
  await corpus({ ...three(), 'center.png': fixture.png(1024, 1024) }, async (dir) => {
    const m = await scanDirectory(dir);
    assert.equal(m.shared.center.file, 'center.png');
    // Served from /shared, even when the shared directory is the corpus directory.
    assert.deepEqual(m.shared.center, { file: 'center.png', url: '/shared/center.png', w: 1024, h: 1024 });
    // Being both the generic wallpaper and a search result would put the same
    // picture everywhere and in the ranking too.
    assert.ok(!m.rooms.some((r) => r.file === 'center.png'));
  });
});

test('--center picks the center tile, by filename or by stem', async () => {
  for (const center of ['002.png', '002']) {
    await corpus(three(), async (dir) => {
      const m = await scanDirectory(dir, { center });
      assert.equal(m.shared.center.file, '002.png', `--center ${center}`);
      assert.deepEqual(m.rooms.map((r) => r.file), ['001.jpg', '003.webp']);
      assert.deepEqual(m.rooms.map((r) => r.id), [0, 1], 'ids stay contiguous');
    });
  }
});

test('with no center at all, the first file stands in - but only when it lives with the corpus', async () => {
  await corpus(three(), async (dir) => {
    const m = await scanDirectory(dir);
    assert.equal(m.shared.center.file, '001.jpg');
    assert.equal(m.count, 2);
  });
});

test('a --center that matches nothing falls back rather than failing', async () => {
  await corpus({ ...three(), 'center.png': fixture.png(1024, 1024) }, async (dir) => {
    const m = await scanDirectory(dir, { center: 'nope.jpg' });
    assert.equal(m.shared.center.file, 'center.png');
  });
});

test('the generic tiles are the sorted generic folder, served from /shared', async () => {
  await corpus(
    {
      ...three(),
      'center_tile.png': fixture.png(1024, 768),
      'generic/v2.webp': fixture.webpVp8(1024, 768),
      'generic/v1.webp': fixture.webpVp8(1024, 768),
      'generic/notes.txt': 'ignored',
    },
    async (dir) => {
      const m = await scanDirectory(dir);
      assert.deepEqual(
        m.shared.generic.map((v) => [v.file, v.url]),
        [
          ['v1.webp', '/shared/generic/v1.webp'],
          ['v2.webp', '/shared/generic/v2.webp'],
        ]
      );
      // The generic tiles are wallpaper, not corpus - they never become rooms.
      assert.ok(!m.rooms.some((r) => r.file.startsWith('v')));
    }
  );
});

test('no generic folder means no generic tiles, not a failure', async () => {
  await corpus({ ...three(), 'center_tile.png': fixture.png(1024, 768) }, async (dir) => {
    const m = await scanDirectory(dir);
    assert.deepEqual(m.shared.generic, []);
  });
});

test('a shared directory outside the corpus leaves every corpus image a room', async () => {
  // The demo shape: --images points at the rooms, --shared-dir at the shared
  // assets. Nothing in the corpus is a generic tile, so nothing is excluded.
  await corpus(
    {
      'rooms/001.jpg': fixture.jpeg(512, 512),
      'rooms/002.jpg': fixture.jpeg(512, 512),
      'center_tile.png': fixture.png(1024, 768),
      'generic/v1.webp': fixture.webpVp8(1024, 768),
    },
    async (dir) => {
      const m = await scanDirectory(join(dir, 'rooms'), { sharedDir: dir });
      assert.deepEqual(m.rooms.map((r) => r.file), ['001.jpg', '002.jpg']);
      assert.equal(m.count, 2, 'the shared tiles do not steal a corpus slot');
      assert.equal(m.shared.center.file, 'center_tile.png');
      assert.deepEqual(m.shared.generic.map((v) => v.file), ['v1.webp']);
    }
  );
});

test('ids are stable across scans, because the map keys slots on them', async () => {
  await corpus(three(), async (dir) => {
    const a = await scanDirectory(dir);
    const b = await scanDirectory(dir);
    assert.deepEqual(a.rooms, b.rooms);

    // Adding a room must not renumber the ones already placed... unless it
    // sorts ahead of them, which is why ingest should append, not interleave.
    await writeFile(join(dir, '004.jpg'), fixture.jpeg(64, 64));
    const c = await scanDirectory(dir);
    assert.deepEqual(c.rooms.slice(0, a.rooms.length), a.rooms);
    assert.equal(c.count, a.count + 1);
  });
});

test('non-image files are ignored, whatever their case', async () => {
  await corpus(
    {
      '001.JPG': fixture.jpeg(512, 512),
      '002.JPEG': fixture.jpeg(512, 512),
      'notes.txt': 'not a room',
      'manifest.json': '{}',
      '.DS_Store': 'junk',
    },
    async (dir) => {
      const m = await scanDirectory(dir);
      assert.deepEqual(m.rooms.map((r) => r.file), ['002.JPEG']);
      assert.equal(m.shared.center.file, '001.JPG');
    }
  );
});

test('subdirectories are not walked into', async () => {
  await corpus(three(), async (dir) => {
    await mkdir(join(dir, 'thumbs'));
    await writeFile(join(dir, 'thumbs', '900.jpg'), fixture.jpeg(64, 64));
    const m = await scanDirectory(dir);
    assert.equal(m.count, 2);
    assert.ok(!m.rooms.some((r) => r.file.includes('900')));
  });
});

test('filenames that need escaping survive the round trip into a url', async () => {
  await corpus(
    { 'center.png': fixture.png(8, 8), 'a room #1.jpg': fixture.jpeg(32, 32), 'x&y=2.png': fixture.png(16, 16) },
    async (dir) => {
      const m = await scanDirectory(dir);
      const byFile = Object.fromEntries(m.rooms.map((r) => [r.file, r.url]));
      assert.equal(byFile['a room #1.jpg'], '/images/a%20room%20%231.jpg');
      assert.equal(byFile['x&y=2.png'], '/images/x%26y%3D2.png');
      for (const [file, url] of Object.entries(byFile))
        assert.equal(decodeURIComponent(url.slice('/images/'.length)), file);
    }
  );
});

test('a room whose header cannot be read still appears, without a size', async () => {
  await corpus({ 'center.png': fixture.png(8, 8), '001.jpg': fixture.truncatedJpeg() }, async (dir) => {
    const m = await scanDirectory(dir);
    assert.equal(m.count, 1);
    assert.equal(m.rooms[0].file, '001.jpg');
    assert.ok(!('w' in m.rooms[0]), 'no size is better than a wrong one');
    assert.ok(m.rooms[0].bytes > 0);
  });
});

test('an empty directory fails with a message naming it', async () => {
  await corpus({}, async (dir) => {
    await assert.rejects(scanDirectory(dir), (err) => err.message.includes(dir));
  });
  await corpus({ 'readme.txt': 'no images here' }, async (dir) => {
    await assert.rejects(scanDirectory(dir), /no images found/);
  });
});

test('a missing directory fails rather than returning an empty corpus', async () => {
  await assert.rejects(scanDirectory(join(tmpdir(), 'babel-does-not-exist-9e3779b1')));
});

test('a directory with one image serves it as the center tile and has no rooms', async () => {
  await corpus({ 'only.png': fixture.png(64, 64) }, async (dir) => {
    const m = await scanDirectory(dir);
    assert.equal(m.shared.center.file, 'only.png');
    assert.deepEqual(m.rooms, []);
    assert.equal(m.count, 0);
  });
});

// --- the resolution pyramid on disk -----------------------------------------

/** A corpus of 1024x768 rooms, plus whatever level directories are asked for. */
const pyramid = (extra = {}) => ({
  'center.jpg': fixture.jpeg(1024, 768),
  '001.jpg': fixture.jpeg(1024, 768),
  '002.jpg': fixture.jpeg(1024, 768),
  ...extra,
});

test('a flat corpus is a valid level 0 and reports nothing else', async () => {
  // "Point it at a directory of images" has to keep working for a corpus that
  // has never been through the pipeline.
  await corpus(pyramid(), async (dir) => {
    const { levels } = await scanDirectory(dir);
    assert.deepEqual(levels, [{ level: 0, w: 1024, h: 768, dir: null }]);
  });
});

test('generated levels are discovered, with their sizes', async () => {
  await corpus(
    pyramid({
      '512/001.jpg': fixture.jpeg(512, 384),
      '256/001.jpg': fixture.jpeg(256, 192),
      '128/001.jpg': fixture.jpeg(128, 96),
      '64/001.jpg': fixture.jpeg(64, 48),
    }),
    async (dir) => {
      const { levels } = await scanDirectory(dir);
      assert.deepEqual(
        levels.map((l) => [l.level, l.w, l.h, l.dir]),
        [
          [0, 1024, 768, null],
          [1, 512, 384, '512'],
          [2, 256, 192, '256'],
          [3, 128, 96, '128'],
          [4, 64, 48, '64'],
        ]
      );
    }
  );
});

test('a half-generated pyramid reports only the rungs that exist', async () => {
  // Interrupt the generator and this is what is on disk. Claiming a level that
  // is not there would make every cell at that zoom a 404.
  await corpus(pyramid({ '512/001.jpg': fixture.jpeg(512, 384), '128/001.jpg': fixture.jpeg(128, 96) }), async (dir) => {
    const { levels } = await scanDirectory(dir);
    assert.deepEqual(levels.map((l) => l.level), [0, 1, 3]);
  });
});

test('an empty level directory is not a level', async () => {
  await corpus(pyramid({ '512/notes.txt': 'nothing to serve here' }), async (dir) => {
    const { levels } = await scanDirectory(dir);
    assert.deepEqual(levels.map((l) => l.level), [0], 'a directory with no images is not a rung');
  });
});

test('a directory that is not on the ladder is ignored', async () => {
  await corpus(pyramid({ '300/001.jpg': fixture.jpeg(300, 225) }), async (dir) => {
    const { levels } = await scanDirectory(dir);
    assert.deepEqual(levels.map((l) => l.level), [0], '300 is not a width the ladder produces');
  });
});

test('level directories are not mistaken for rooms', async () => {
  await corpus(pyramid({ '512/001.jpg': fixture.jpeg(512, 384) }), async (dir) => {
    const m = await scanDirectory(dir);
    assert.deepEqual(m.rooms.map((r) => r.file), ['001.jpg', '002.jpg']);
    assert.equal(m.count, 2, 'the pyramid must not inflate the corpus');
  });
});

test('the ladder is measured off the rooms, not off the generic', async () => {
  // The generic is one file and may be any shape; the rooms are what the map is
  // made of, so they are what the level widths have to match.
  await corpus(
    { 'center.jpg': fixture.jpeg(640, 480), '001.jpg': fixture.jpeg(1024, 768), '512/001.jpg': fixture.jpeg(512, 384) },
    async (dir) => {
      const { levels } = await scanDirectory(dir);
      assert.deepEqual(levels.map((l) => [l.level, l.w]), [[0, 1024], [1, 512]]);
    }
  );
});

test('an unreadable source size degrades to level 0 rather than guessing', async () => {
  assert.deepEqual(await discoverLevels('/nonexistent', null), [
    { level: 0, w: null, h: null, dir: null },
  ]);
});

// --- embeddings blob --------------------------------------------------------

test('a corpus without a blob reports no embeddings', async () => {
  await corpus({ 'center.png': fixture.png(8, 8), '001.jpg': fixture.jpeg(8, 8) }, async (dir) => {
    assert.equal((await scanDirectory(dir)).embeddings, null);
  });
});

test('an embeddings sidecar is surfaced with a servable url', async () => {
  await corpus(
    {
      'center.png': fixture.png(8, 8),
      '001.jpg': fixture.jpeg(8, 8),
      '002.jpg': fixture.jpeg(8, 8),
      'embeddings.json': JSON.stringify({ model: 'Xenova/clip-vit-base-patch32', dim: 512, count: 2 }),
    },
    async (dir) => {
      const { embeddings } = await scanDirectory(dir);
      assert.deepEqual(embeddings, {
        url: '/images/embeddings.bin',
        dim: 512,
        count: 2,
        model: 'Xenova/clip-vit-base-patch32',
      });
    }
  );
});

test('a stale blob whose count no longer matches the corpus is ignored', async () => {
  // The rows are keyed on room ids; a wrong-length blob would rank the wrong
  // rooms, so a mismatch must degrade to the stub rather than be trusted.
  await corpus(
    {
      'center.png': fixture.png(8, 8),
      '001.jpg': fixture.jpeg(8, 8),
      '002.jpg': fixture.jpeg(8, 8),
      'embeddings.json': JSON.stringify({ dim: 512, count: 5 }),
    },
    async (dir) => {
      assert.equal((await scanDirectory(dir)).embeddings, null, 'count 5 != 2 rooms');
    }
  );
});

// --- keyword/story sidecar --------------------------------------------------

test('a corpus without a sidecar reports no metadata', async () => {
  await corpus({ 'center.png': fixture.png(8, 8), '001.jpg': fixture.jpeg(8, 8) }, async (dir) => {
    assert.equal((await scanDirectory(dir)).metadata, null);
  });
});

test('a metadata sidecar is surfaced with a servable url and its coverage', async () => {
  await corpus(
    {
      'center.png': fixture.png(8, 8),
      '001.jpg': fixture.jpeg(8, 8),
      '002.jpg': fixture.jpeg(8, 8),
      'metadata.json': JSON.stringify({
        '001.jpg': { keywords: ['brutalism'], story: 'A room of unread indices.' },
      }),
    },
    async (dir) => {
      assert.deepEqual((await scanDirectory(dir)).metadata, {
        url: '/images/metadata.json',
        matched: 1,
        entries: 1,
      });
    }
  );
});

test('a sidecar covering only some rooms is kept, unlike a stale blob', async () => {
  // The asymmetry is the point. A blob's rows are positional, so a mismatch has
  // to be thrown away wholesale; this is joined per filename, so a partial one
  // is simply partial and every entry that does match still lands.
  await corpus(
    {
      'center.png': fixture.png(8, 8),
      '001.jpg': fixture.jpeg(8, 8),
      '002.jpg': fixture.jpeg(8, 8),
      '003.jpg': fixture.jpeg(8, 8),
      'metadata.json': JSON.stringify({ '002.jpg': { story: 'only this one' } }),
    },
    async (dir) => {
      const { metadata } = await scanDirectory(dir);
      assert.equal(metadata.matched, 1);
      assert.equal(metadata.entries, 1);
    }
  );
});

test('a sidecar that matches nothing is reported rather than hidden', async () => {
  // matched 0 against entries 2 is the signal that the keys have drifted; from
  // the map it is indistinguishable from having no sidecar at all.
  await corpus(
    {
      'center.png': fixture.png(8, 8),
      '001.jpg': fixture.jpeg(8, 8),
      'metadata.json': JSON.stringify({ 'a.jpg': { story: 'x' }, 'b.jpg': { story: 'y' } }),
    },
    async (dir) => {
      const { metadata } = await scanDirectory(dir);
      assert.equal(metadata.matched, 0);
      assert.equal(metadata.entries, 2);
    }
  );
});

test('a malformed sidecar degrades to no metadata rather than throwing', async () => {
  await corpus(
    {
      'center.png': fixture.png(8, 8),
      '001.jpg': fixture.jpeg(8, 8),
      'metadata.json': '{ not json',
    },
    async (dir) => {
      assert.equal((await scanDirectory(dir)).metadata, null);
    }
  );
});
