// Unit tests for the local HLS relay's playlist rewriting and the optional
// proxy layer's m3u8 rewriting. Pure string work; no network.

const test = require('node:test');
const assert = require('node:assert');

const { rewritePlaylist } = require('../utils/hlsRelay');

const BASE = 'http://127.0.0.1:6150';
const MASTER = 'https://cdn.fastcloud.live/movie/abc/bigtits.m3u8';
const HEADERS = { Referer: 'https://player.vidzee.wtf/' };

test('relay rewrites extensionless TikTok segments to the segment route', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:14',
    '#EXTINF:5.171833,',
    'https://p16-sg.tiktokcdn.com/obj/tos-alisg-v-abc/f49fd417e6b8',
    '#EXTINF:3.0,',
    'next-segment',
  ].join('\n');

  const out = rewritePlaylist(playlist, MASTER, BASE, HEADERS);
  const lines = out.split('\n');

  assert.match(lines[3], /^http:\/\/127\.0\.0\.1:6150\/__relay\/segment\?/);
  assert.match(lines[3], /url=https%3A%2F%2Fp16-sg\.tiktokcdn\.com%2Fobj%2F/);
  // Relative URI resolves against the playlist URL.
  assert.match(lines[5], /url=https%3A%2F%2Fcdn\.fastcloud\.live%2Fmovie%2Fabc%2Fnext-segment/);
  assert.strictEqual(lines[0], '#EXTM3U');
  assert.strictEqual(lines[1], '#EXT-X-TARGETDURATION:14');
});

test('relay keeps variant playlists on the playlist route', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1441498,RESOLUTION=1280x720',
    'index-v1-a1.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000',
    'variant-without-extension',
  ].join('\n');

  const out = rewritePlaylist(playlist, MASTER, BASE, HEADERS);
  const lines = out.split('\n');

  assert.match(lines[2], /\/__relay\/playlist\?/);
  assert.match(lines[4], /\/__relay\/playlist\?/);
});

test('relay routes key and init-section URIs through the segment route', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k1"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.0,',
    'seg1.ts',
  ].join('\n');

  const out = rewritePlaylist(playlist, MASTER, BASE, HEADERS);
  const lines = out.split('\n');

  assert.match(lines[1], /#EXT-X-KEY:METHOD=AES-128,URI="http:\/\/127\.0\.0\.1:6150\/__relay\/segment\?/);
  assert.match(lines[2], /#EXT-X-MAP:URI="http:\/\/127\.0\.0\.1:6150\/__relay\/segment\?/);
  assert.match(lines[4], /\/__relay\/segment\?/);
});

test('proxy rewriteM3u8 proxies extensionless segments, not just .ts', () => {
  process.env.DISABLE_CACHE = 'true'; // keep prefetchSegment from hitting the network
  const { rewriteM3u8 } = require('../proxy/proxyServer');

  const playlist = [
    '#EXTM3U',
    '#EXTINF:5.0,',
    'https://p16-sg.tiktokcdn.com/obj/tos-alisg-v-abc/hash',
    '#EXTINF:5.0,',
    'https://cdn.test/segment.ts',
    '#EXT-X-STREAM-INF:BANDWIDTH=1',
    'https://cdn.test/variant',
  ].join('\n');

  const out = rewriteM3u8(playlist, MASTER, BASE, HEADERS);
  const lines = out.split('\n');

  assert.match(lines[2], /\/ts-proxy\?url=https%3A%2F%2Fp16-sg\.tiktokcdn\.com/);
  assert.match(lines[4], /\/ts-proxy\?url=https%3A%2F%2Fcdn\.test%2Fsegment\.ts/);
  assert.match(lines[6], /\/m3u8-proxy\?url=https%3A%2F%2Fcdn\.test%2Fvariant/);
});
