// MPEG-TS / image-wrapper sniffing.
//
// VidZee's `ipcloud` and `tik` servers prepend a tiny 1x1 PNG (sometimes JPEG
// or GIF) to every MPEG-TS segment. ffmpeg sniffs the image, finds no media and
// aborts with "Output file does not contain any stream", and browsers/players
// show a broken still. The wrapper is purely cosmetic: strip it and the bytes
// after it are a normal TS stream starting with the 0x47 sync byte.
//
// Shared by the MP4 API, its local HLS relay, and the optional proxy layer.

const IMAGE_MAGIC = [
  Buffer.from('89504e470d0a1a0a', 'hex'), // PNG
  Buffer.from('ffd8ff', 'hex'), // JPEG
  Buffer.from('GIF87a', 'ascii'),
  Buffer.from('GIF89a', 'ascii'),
];

const TS_PACKET_SIZE = 188;
// A wrapped PNG header is ~70 bytes; allow a little room for other image types.
const TS_SEARCH_LIMIT = 8192;

function looksLikeImage(buf) {
  if (!buf || !buf.length) return false;
  const head = Buffer.from(buf);
  return IMAGE_MAGIC.some((magic) => head.subarray(0, magic.length).equals(magic));
}

// Offset of the first credible MPEG-TS packet: 0x47 sync repeated every 188
// bytes. Returns -1 when the buffer is not TS (e.g. a real image, fMP4 init).
function findTsStart(buf) {
  if (!buf || buf.length < TS_PACKET_SIZE * 3) return -1;
  const limit = Math.min(buf.length - TS_PACKET_SIZE * 2, TS_SEARCH_LIMIT);
  for (let off = 0; off <= limit; off++) {
    if (buf[off] !== 0x47) continue;
    if (buf[off + TS_PACKET_SIZE] !== 0x47) continue;
    if (buf[off + TS_PACKET_SIZE * 2] !== 0x47) continue;
    return off;
  }
  return -1;
}

// Strip an image wrapper when the payload underneath is MPEG-TS. Returns the
// input unchanged for plain TS, real images, and non-TS payloads.
function unwrapImageTs(buf) {
  if (!buf || !buf.length || !looksLikeImage(buf)) return buf;
  const off = findTsStart(buf);
  return off > 0 ? buf.subarray(off) : buf;
}

function isMpegTs(buf) {
  return !!buf && buf.length >= TS_PACKET_SIZE && buf[0] === 0x47;
}

module.exports = {
  IMAGE_MAGIC,
  TS_PACKET_SIZE,
  looksLikeImage,
  findTsStart,
  unwrapImageTs,
  isMpegTs,
};
