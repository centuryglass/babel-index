/**
 * Synthetic image headers, for testing the parsers in scan.ts.
 *
 * These are headers, not images: enough bytes for `imageSize` to answer, and
 * nothing that would decode. Built here rather than committed as binaries so
 * the dimensions under test are visible in the test itself, and so the tests
 * never depend on `assets/corpus-sample/` staying exactly what it is today.
 */

/** PNG: 8-byte signature, then IHDR carries the size in the first chunk. */
export function png(w: number, h: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  buf[24] = 8; // bit depth
  buf[25] = 2; // colour type: truecolour
  return buf;
}

/**
 * JPEG: SOI, then a segment chain that has to be walked to reach the frame
 * header.
 *
 * @param before markers to emit before the frame header, so the walk is
 *   exercised rather than a fixed offset. 0xc4 (DHT) shares the SOF marker
 *   range and must be skipped rather than read as a frame.
 * @param marker the frame header: 0xc0 baseline, 0xc2 progressive.
 */
export function jpeg(
  w: number,
  h: number,
  { before = [0xe0], marker = 0xc0 }: { before?: number[]; marker?: number } = {}
): Buffer {
  const parts = [Buffer.from([0xff, 0xd8])];

  for (const m of before) {
    // Segment length includes the two length bytes themselves.
    const payload = Buffer.alloc(14, 0);
    payload.write('JFIF\0', 0, 'ascii');
    const seg = Buffer.alloc(4 + payload.length);
    seg[0] = 0xff;
    seg[1] = m;
    seg.writeUInt16BE(payload.length + 2, 2);
    payload.copy(seg, 4);
    parts.push(seg);
  }

  const sof = Buffer.alloc(11);
  sof[0] = 0xff;
  sof[1] = marker;
  sof.writeUInt16BE(9, 2); // length
  sof[4] = 8; // sample precision
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 1; // one component
  parts.push(sof, Buffer.from([0xff, 0xd9]));

  return Buffer.concat(parts);
}

/** A JPEG whose segment chain is cut off before the frame header. */
export function truncatedJpeg(): Buffer {
  return jpeg(800, 600, { before: [0xe0, 0xe1, 0xc4] }).subarray(0, 24);
}

/** WebP lossy: the size lives in the VP8 bitstream, little-endian, 14 bits each. */
export function webpVp8(w: number, h: number): Buffer {
  const payload = Buffer.alloc(18);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(payload, 3); // sync code, after the frame tag
  payload.writeUInt16LE(w & 0x3fff, 6);
  payload.writeUInt16LE(h & 0x3fff, 8);
  return riff('VP8 ', payload);
}

/** WebP lossless: 14-bit width and height packed into one little-endian word. */
export function webpVp8l(w: number, h: number): Buffer {
  const payload = Buffer.alloc(14);
  payload[0] = 0x2f; // VP8L signature
  payload.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1);
  return riff('VP8L', payload);
}

/**
 * WebP extended: a canvas size in the VP8X chunk, then the frame chunks it
 * describes. Real VP8X files always carry those, so the fixture does too.
 */
export function webpVp8x(w: number, h: number): Buffer {
  const payload = Buffer.alloc(10);
  payload[0] = 0x10; // flags: alpha
  writeUInt24LE(payload, w - 1, 4);
  writeUInt24LE(payload, h - 1, 7);
  return Buffer.concat([riff('VP8X', payload), chunk('ALPH', Buffer.alloc(8))]);
}

/** Something with an image extension that is not an image. */
export function notAnImage(): Buffer {
  return Buffer.from('this is a text file that someone renamed\n', 'utf8');
}

function riff(fourcc: string, payload: Buffer): Buffer {
  const body = chunk(fourcc, payload);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'ascii');
  return Buffer.concat([head, body]);
}

function chunk(fourcc: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'ascii');
  head.writeUInt32LE(payload.length, 4);
  // Chunks are padded to an even length.
  const pad = payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([head, payload, pad]);
}

function writeUInt24LE(buf: Buffer, value: number, offset: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
}
