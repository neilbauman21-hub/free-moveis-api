// VidZee stream resolution.
//
// 2026-08-06: VidZee rebuilt player.vidzee.wtf (TanStack SPA) and retired the
// old endpoints — both `core.vidzee.wtf/api-key` and
// `player.vidzee.wtf/api/server` now 404. The AES-GCM -> AES-CBC key chain they
// fed is gone with them; decryption moved client-side into WebAssembly.
//
// The replacement API is:
//     GET core.vidzee.wtf/streams/movie/<tmdbId>?s=<server>&e=<0|1>
//     GET core.vidzee.wtf/streams/tv/<tmdbId>/<season>/<episode>?s=<server>&e=<0|1>
//
// `e` selects the response encoding, and it is the client's choice:
//     e=1 -> {"c": "<blob>"}  decrypted in-browser by assets/streams-*.js (wasm)
//     e=0 -> {"url": "...", "language": "...", "headers": {}}   plaintext
// So we ask for e=0 and skip the crypto entirely. Servers are now named ids
// rather than numbers; `sr` carries the name.
//
// If VidZee rotates again, the constants below are the place to look.

const axios = require('axios');

const { httpAgent, httpsAgent } = require('../utils/dnsFallback');

const API_BASE = 'https://core.vidzee.wtf';
const EMBED_ORIGIN = 'https://player.vidzee.wtf';
// Header the CDNs expect on the real stream requests. It must be the *player*
// origin: cdn1.1shows.app 403s on the old core.vidzee.wtf referer, while every
// CDN that accepted core also accepts this one.
const STREAM_REFERER = `${EMBED_ORIGIN}/`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// The player's own server list, in its order; the Hindi dub goes last so
// English-preferring callers reach it only as a fallback.
const DEFAULT_SERVERS = ['dcloud', 'tik', 'ipcloud', 'v6:Hindi'];

// --- Pure helpers (no network; exported for tests) ---

function buildStreamUrl({ tmdbId, type, season, episode, sr }) {
  const path =
    type === 'tv'
      ? `/streams/tv/${encodeURIComponent(tmdbId)}/${encodeURIComponent(season)}/${encodeURIComponent(episode)}`
      : `/streams/movie/${encodeURIComponent(tmdbId)}`;
  return `${API_BASE}${path}?s=${encodeURIComponent(sr)}&e=0`;
}

// Map a plaintext /streams payload onto stream objects. Returns [] for error
// bodies, and for `{c: ...}` blobs (an encrypted reply we never asked for).
function normalizeStreams(data, sr) {
  if (!data || typeof data !== 'object') return [];
  const url = typeof data.url === 'string' ? data.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) return [];
  return [
    {
      sr,
      name: `VidZee ${sr}`,
      language: data.language || 'unknown',
      type: 'hls',
      url,
      // Usually empty, but honour anything the API says the CDN needs.
      headers: data.headers && typeof data.headers === 'object' ? data.headers : {},
    },
  ];
}

// --- Networked helpers ---

async function fetchStreams(opts) {
  const resp = await axios.get(buildStreamUrl(opts), {
    headers: {
      'User-Agent': UA,
      Referer: `${EMBED_ORIGIN}/`,
      Origin: EMBED_ORIGIN,
    },
    timeout: 12000,
    httpAgent,
    httpsAgent,
  });
  return resp.data;
}

// Resolve streams from a single VidZee server. Returns [] on failure — servers
// come and go (a dead one answers 502), so callers walk the list.
async function getServerStreams(opts) {
  let data;
  try {
    data = await fetchStreams(opts);
  } catch {
    return [];
  }
  return normalizeStreams(data, opts.sr);
}

// Resolve streams across many servers (used by the aggregator provider).
async function getAllStreams({ tmdbId, type, season, episode, servers = DEFAULT_SERVERS }) {
  const nested = await Promise.all(
    servers.map((sr) => getServerStreams({ tmdbId, type, season, episode, sr })),
  );
  return nested.flat();
}

module.exports = {
  API_BASE,
  UA,
  STREAM_REFERER,
  DEFAULT_SERVERS,
  buildStreamUrl,
  normalizeStreams,
  getServerStreams,
  getAllStreams,
};
