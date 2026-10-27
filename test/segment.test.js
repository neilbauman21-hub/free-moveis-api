// Unit tests for the image-wrapper sniffing used by the MP4 relay and proxy.
// No network: the fixtures are synthetic PNG/JPEG headers + TS packets.

const test = require('node:test');
const assert = require('node:assert');

const {
  looksLikeImage,
  findTsStart,
  unwrapImageTs,
  isMpegTs,
  TS_PACKET_SIZE,
} = require('../utils/segment');

function pngHeader(size = 70) {
  const buf = Buffer.alloc(size, 0);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buf, 0);
  buf.write('IHDR', 12);
  buf.write('IEND', size - 8);
  return buf;
}

function tsPackets(count = 4) {
  const buf = Buffer.alloc(TS_PACKET_SIZE * count, 0);
  for (let i = 0; i < count; i++) {
    buf[i * TS_PACKET_SIZE] = 0x47;
    buf[i * TS_PACKET_SIZE + 1] = 0x40;
    buf[i * TS_PACKET_SIZE + 2] = 0x00;
    buf[i * TS_PACKET_SIZE + 3] = 0x10;
  }
  return buf;
}

test('unwrapImageTs strips the 70-byte PNG wrapper tik/ipcloud use', () => {
  const wrapper = pngHeader(70);
  const ts = tsPackets(8);
  const wrapped = Buffer.concat([wrapper, ts]);

  assert.strictEqual(looksLikeImage(wrapped), true);
  assert.strictEqual(findTsStart(wrapped), 70);
  assert.strictEqual(isMpegTs(wrapped), false);

  const clean = unwrapImageTs(wrapped);
  assert.strictEqual(isMpegTs(clean), true);
  assert.deepStrictEqual(clean, ts);
});

test('unwrapImageTs leaves a real image untouched', () => {
  // PNG magic followed by non-TS bytes: a poster/thumbnail, not a wrapper.
  const image = Buffer.concat([pngHeader(70), Buffer.alloc(1024, 0xaa)]);
  assert.strictEqual(unwrapImageTs(image), image);
});

test('unwrapImageTs leaves plain MPEG-TS untouched', () => {
  const ts = tsPackets(4);
  assert.strictEqual(findTsStart(ts), 0);
  assert.strictEqual(unwrapImageTs(ts), ts);
});

test('unwrapImageTs is a no-op for empty and non-image input', () => {
  const empty = Buffer.alloc(0);
  const random = Buffer.from('not a video at all', 'utf8');
  assert.strictEqual(unwrapImageTs(empty), empty);
  assert.strictEqual(unwrapImageTs(random), random);
  assert.strictEqual(unwrapImageTs(null), null);
});

test('findTsStart rejects buffers with a lone 0x47 byte', () => {
  const buf = Buffer.alloc(TS_PACKET_SIZE * 3, 0);
  buf[100] = 0x47; // no repeats at +188/+376
  assert.strictEqual(findTsStart(buf), -1);
});
