// Local HLS relay for the MP4 API.
//
// ffmpeg resolves URLs with the system resolver, so it cannot use the DoH
// fallback in utils/dnsFallback and it cannot strip image wrappers either. The
// relay closes both gaps: ffmpeg is pointed at 127.0.0.1, the relay fetches the
// playlist/segments through the fallback-aware agents, and segments are served
// as clean MPEG-TS with the 1x1-PNG prefix removed.
//
// Every relay URL carries a per-process token so the endpoints cannot be used
// as an open proxy by anything else that can reach the MP4 API's port.

const crypto = require('crypto');
const axios = require('axios');

const { httpAgent, httpsAgent } = require('./dnsFallback');
const { unwrapImageTs } = require('./segment');

const PREFIX = '/__relay';
const TOKEN = crypto.randomBytes(24).toString('hex');
const FETCH_TIMEOUT_MS = 20000;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function encodeHeaders(headers) {
  return Buffer.from(JSON.stringify(headers || {})).toString('base64url');
}

function decodeHeaders(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function relayUrl(kind, base, url, headers) {
  const params = new URLSearchParams({ url, h: encodeHeaders(headers), t: TOKEN });
  return `${base}${PREFIX}/${kind}?${params.toString()}`;
}

// Point ffmpeg at this instead of the upstream playlist URL.
function buildPlaylistUrl(url, headers, port) {
  return relayUrl('playlist', `http://127.0.0.1:${port}`, url, headers);
}

// Rewrite a playlist so every nested URI comes back through the relay. Media
// URIs are routed by context: variant playlists follow #EXT-X-STREAM-INF or an
// .m3u8 suffix, everything else is treated as a segment. That matters for
// TikTok, whose segment URLs are extensionless (`/obj/tos-…/<hash>`).
function rewritePlaylist(text, playlistUrl, base, headers) {
  const out = [];
  let nextIsPlaylist = false;

  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#EXT-X-STREAM-INF')) nextIsPlaylist = true;

      const attrMatch = trimmed.match(/URI="([^"]+)"/);
      if (attrMatch && /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF|KEY|MAP):/.test(trimmed)) {
        try {
          const abs = new URL(attrMatch[1], playlistUrl).href;
          const kind = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF):/.test(trimmed) ? 'playlist' : 'segment';
          out.push(line.replace(attrMatch[1], relayUrl(kind, base, abs, headers)));
        } catch {
          out.push(line);
        }
      } else {
        out.push(line);
      }
      continue;
    }

    try {
      const abs = new URL(trimmed, playlistUrl).href;
      const kind = nextIsPlaylist || /\.m3u8(\?|$)/i.test(abs) ? 'playlist' : 'segment';
      out.push(relayUrl(kind, base, abs, headers));
      nextIsPlaylist = false;
    } catch {
      out.push(line);
    }
  }

  return out.join('\n');
}

function fetchOptions(url, headers, extra) {
  return {
    headers: { 'User-Agent': DEFAULT_UA, ...headers },
    timeout: FETCH_TIMEOUT_MS,
    httpAgent,
    httpsAgent,
    validateStatus: (status) => status >= 200 && status < 300,
    ...extra,
  };
}

async function servePlaylist(req, res, url, headers) {
  const resp = await axios.get(
    url,
    fetchOptions(url, headers, { responseType: 'text', transformResponse: [(body) => body] }),
  );
  const text = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
  const base = `http://127.0.0.1:${req.socket.localPort}`;
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(rewritePlaylist(text, url, base, headers));
}

function contentTypeFor(url, upstreamType, body) {
  if (body && body.length && body[0] === 0x47) return 'video/mp2t';
  if (upstreamType && !/application\/octet-stream|image\/|text\/plain/i.test(upstreamType)) {
    return upstreamType;
  }
  if (/\.(m4s|mp4|m4v)(\?|$)/i.test(url)) return 'video/mp4';
  if (/\.(aac)(\?|$)/i.test(url)) return 'audio/aac';
  if (/\.(vtt)(\?|$)/i.test(url)) return 'text/vtt';
  return 'video/mp2t';
}

// Serve a full segment, honouring a byte range if the client sent one. Wrapped
// segments are unwrapped before the range is applied so offsets refer to the
// clean stream.
async function serveSegment(req, res, url, headers) {
  const resp = await axios.get(
    url,
    fetchOptions(url, headers, {
      responseType: 'arraybuffer',
      maxContentLength: MAX_SEGMENT_BYTES,
      maxBodyLength: MAX_SEGMENT_BYTES,
    }),
  );

  const upstreamType = resp.headers && resp.headers['content-type'];
  const body = unwrapImageTs(Buffer.from(resp.data));
  const contentType = contentTypeFor(url, upstreamType, body);

  const responseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  };

  let status = 200;
  let slice = body;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (match) {
      let start = match[1] === '' ? null : Number(match[1]);
      let end = match[2] === '' ? null : Number(match[2]);
      if (start === null && end !== null) {
        start = Math.max(0, body.length - end);
        end = body.length - 1;
      }
      if (start !== null && start < body.length) {
        if (end === null || end >= body.length) end = body.length - 1;
        if (start <= end) {
          slice = body.subarray(start, end + 1);
          status = 206;
          responseHeaders['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
        }
      }
    }
  }

  responseHeaders['Content-Length'] = String(slice.length);
  res.writeHead(status, responseHeaders);
  res.end(slice);
}

// Returns true when the request was a relay request (handled here), false when
// the caller should keep routing it.
async function handleRelay(req, res, parsed) {
  if (!parsed.pathname.startsWith(`${PREFIX}/`)) return false;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  if (parsed.searchParams.get('t') !== TOKEN) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return true;
  }

  const kind = parsed.pathname.slice(PREFIX.length + 1);
  const url = parsed.searchParams.get('url');
  if (!url || (kind !== 'playlist' && kind !== 'segment')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad relay request');
    return true;
  }

  const headers = decodeHeaders(parsed.searchParams.get('h'));
  try {
    if (kind === 'playlist') await servePlaylist(req, res, url, headers);
    else await serveSegment(req, res, url, headers);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`relay error: ${e.message}`);
    } else {
      res.end();
    }
  }
  return true;
}

module.exports = {
  PREFIX,
  handleRelay,
  rewritePlaylist,
  buildPlaylistUrl,
  encodeHeaders,
  decodeHeaders,
};
