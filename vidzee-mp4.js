// VidZee -> MP4 streaming API.
//
//   GET /movie/<tmdbId>                -> video/mp4 (movie)
//   GET /tv/<tmdbId>/<season>/<ep>     -> video/mp4 (episode)
//     ?sr=<name>     force a specific VidZee server (e.g. dcloud, v6:Hindi)
//     ?download=1    send as an attachment instead of inline
//     ?interpolation=gpu|cpu
//                    OPTIONAL frame interpolation:
//                      gpu = GPU (VapourSynth + RIFE)
//                      cpu = CPU (ffmpeg minterpolate, no GPU required)
//     ?fps=<n>       target frame rate for interpolation (default 40, 1-240)
//     ?workers=<n>   CPU only: parallel minterpolate processes (default: all
//                    but one core, capped at 8; `1` = live single process)
//                    Omitting `?interpolation=` (or using `off`) keeps normal
//                    playback untouched: plain copy remux, no download, no GPU.
//                    `?rife=1` / `?interpolation=rife` are aliases for `gpu`.
//
// Normal mode: VidZee serves HLS; ffmpeg remuxes (-c copy, no re-encode) into
// a fragmented MP4 streamed to the client.
//
// RIFE mode (opt-in): the episode is first downloaded (still -c copy) into a
// bounded tmpfs job dir, because FFMS2 needs a completed file to index. Then
// rife-worker.py pipes interpolated Y4M straight into ffmpeg, which encodes
// video and muxes the downloaded file's audio into a fragmented MP4.
//
// CPU mode (opt-in): no GPU; ffmpeg re-encodes through minterpolate. Because
// minterpolate is effectively single-threaded, the default downloads the
// episode once (MP4, so workers can seek) and splits it into time chunks that
// run in parallel; a final ffmpeg concatenates them and takes audio from the
// complete source. `?workers=1` keeps the old live single-process stream.
// Motion interpolation is very CPU-heavy, so `?preview=<seconds>` is useful for
// testing.
//
// One interpolation job at a time (either mode); normal playback stays
// available while it runs.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const {
  getServerStreams,
  UA,
  STREAM_REFERER,
  DEFAULT_SERVERS,
} = require('./providers/vidzeeCrypto');
const { httpAgent, httpsAgent } = require('./utils/dnsFallback');
const { looksLikeImage, unwrapImageTs, isMpegTs } = require('./utils/segment');
const { handleRelay, buildPlaylistUrl } = require('./utils/hlsRelay');

const PORT = Number(process.env.MP4_PORT) || 6150;
const HOST = process.env.MP4_HOST || '0.0.0.0';

// Already ordered with the dubbed server last, so English wins when available.
const SERVER_ORDER = DEFAULT_SERVERS;

// --- RIFE configuration (env-overridable) ---
const RIFE_ENABLED = process.env.RIFE_DISABLED !== '1';
const RIFE_DIR = process.env.RIFE_DIR || '/dev/shm/vidzee-rife';
// `INTERPOLATION_FPS` supersedes the older RIFE-only name; keep both working.
const DEFAULT_INTERPOLATION_FPS =
  Number(process.env.INTERPOLATION_FPS || process.env.RIFE_FPS) || 40;
const INTERPOLATION_FPS_MAX = 240;
const RIFE_VBITRATE = process.env.RIFE_VBITRATE || '6M';

// Live fragmented MP4 has no duration/sample-duration in the moov, and
// libopenh264 writes SPS without VUI timing, so players had no frame rate to
// display (VLC fell back to whatever it showed before, often the source's
// 25 fps). Writing the timing info into the H.264 stream makes the rate
// explicit to every player. h264_metadata's tick_rate is
// time_scale/num_units_in_tick, which is twice the progressive frame rate.
function rifeVuiTickRate(fps) {
  const rate = Number(fps);
  const safe = Number.isFinite(rate) && rate > 0 ? rate : 1;
  // Keep fractional rates (59.94 -> 119.88); h264_metadata accepts a rational.
  return Math.round(safe * 2000) / 1000;
}
// Refuse sources bigger than this (tmpfs is RAM; don't OOM the machine).
const RIFE_MAX_BYTES = Number(process.env.RIFE_MAX_BYTES) || 3 * 1024 * 1024 * 1024;
const RIFE_WORKER = path.join(__dirname, 'rife-worker.py');

// CPU interpolation uses ffmpeg's minterpolate filter, so it needs no GPU and
// no extra binaries. {fps} is replaced with the target rate; the default is the
// quality-oriented motion-compensated mode, which is slow but smooth.
const CPU_INTERPOLATION_ENABLED = process.env.CPU_INTERPOLATION_DISABLED !== '1';
const CPU_INTERPOLATION_FILTER =
  process.env.CPU_INTERPOLATION_FILTER ||
  'minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff:scd_threshold=1';

// minterpolate is effectively single-threaded, so CPU mode downloads the source
// once and splits it into time ranges, each handled by its own ffmpeg process.
// `?workers=1` opts back into the old live single-process stream. The defaults
// use all but one core (capped) because the point of CPU mode is to use them.
const CPU_WORKERS_MAX = 32;
const CPU_WORKERS_DEFAULT = Math.max(
  1,
  Math.min(8, (os.cpus().length || 1) - 1),
);
const CPU_MIN_CHUNK_SECONDS = Number(process.env.CPU_MIN_CHUNK_SECONDS) || 5;
const CPU_INTERPOLATION_DIR =
  process.env.CPU_INTERPOLATION_DIR || path.join(os.tmpdir(), 'vidzee-cpu');
const CPU_MAX_BYTES = Number(process.env.CPU_MAX_BYTES) || RIFE_MAX_BYTES;

function cpuInterpolationFilter(fps) {
  const rate = Number(fps);
  return CPU_INTERPOLATION_FILTER.replace(
    /\{fps\}/g,
    String(Number.isFinite(rate) && rate > 0 ? rate : 1),
  );
}

// `?interpolation=<mode>` is the explicit switch: `gpu` (VapourSynth/RIFE) or
// `cpu` (ffmpeg minterpolate). RIFE is an implementation detail, so `rife` and
// `?rife=1` are accepted only as backwards-compatible aliases for `gpu`.
// Unknown values are reported instead of silently falling back to normal
// playback. "off"/"none" explicitly disable interpolation.
function parseInterpolation(query) {
  const legacyRife = query && (query.rife === '1' || query.rife === 'true');
  const raw = query && query.interpolation;
  if (raw === undefined || raw === null || raw === '') {
    return { mode: legacyRife ? 'gpu' : null, legacy: Boolean(legacyRife) };
  }
  const value = String(raw).trim().toLowerCase();
  if (value === 'off' || value === 'none' || value === '0' || value === 'false') {
    return { mode: null, legacy: false };
  }
  if (value === 'gpu') return { mode: 'gpu', legacy: false };
  if (value === 'rife' || value === '1' || value === 'true') {
    return { mode: 'gpu', legacy: true };
  }
  if (value === 'cpu') return { mode: 'cpu', legacy: false };
  return { mode: null, legacy: false, invalid: value };
}

// `?fps=<n>` chooses the target rate. Fractions are allowed (59.94, 29.97),
// stored to millifps precision; absent means the env default. Invalid values
// are reported so a typo cannot silently produce the wrong frame rate.
function interpolationFpsRequested(query, fallback = DEFAULT_INTERPOLATION_FPS) {
  const raw = query && query.fps;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { fps: fallback, invalid: null };
  }
  const fps = Number(raw);
  if (!Number.isFinite(fps) || fps < 1 || fps > INTERPOLATION_FPS_MAX) {
    return { fps: null, invalid: String(raw) };
  }
  return { fps: Math.round(fps * 1000) / 1000, invalid: null };
}

// `?workers=<n>` controls how many minterpolate processes CPU mode runs in
// parallel. 1 means the original live single-process stream; above that the
// source is downloaded and split into chunks so the chunks can run at once.
function interpolationWorkersRequested(query, fallback = CPU_WORKERS_DEFAULT) {
  const raw = query && query.workers;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { workers: fallback, invalid: null };
  }
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1 || workers > CPU_WORKERS_MAX) {
    return { workers: null, invalid: String(raw) };
  }
  return { workers, invalid: null };
}

// --- Audio loudness normalization (env-overridable) ---
// Source levels vary wildly between titles and servers: some arrive around
// -30 LUFS (very quiet), others near -10 LUFS. The API re-encodes audio anyway,
// so normalization is on by default: single-pass EBU R128 loudnorm, the only
// variant usable on a live HLS stream. `?norm=0` (or AUDIO_NORMALIZE=0) opts out.
const AUDIO_NORMALIZE_DEFAULT = !(
  process.env.AUDIO_NORMALIZE === '0' || process.env.AUDIO_NORMALIZE === 'false'
);
const AUDIO_NORM_FILTER =
  process.env.AUDIO_NORM_FILTER || 'loudnorm=I=-16:TP=-1.5:LRA=11';

// Tri-state: `?norm=1` forces on, `?norm=0` forces off, anything else follows
// the AUDIO_NORMALIZE default (on unless explicitly disabled).
function audioNormRequested(query) {
  const value = query && query.norm;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return AUDIO_NORMALIZE_DEFAULT;
}

// `?preview=<seconds>` caps the output (and, for RIFE, the download) so a
// source can be A/B checked without waiting for a whole episode. Clamped to
// 10 minutes; absent/invalid means no limit.
const PREVIEW_MAX_SECONDS = 600;

function previewSecondsRequested(query) {
  const raw = query && query.preview;
  if (raw === undefined || raw === null || raw === '') return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(Math.floor(seconds), PREVIEW_MAX_SECONDS);
}

function isEnglishish(language) {
  const l = String(language || '').trim().toLowerCase();
  // "auto" is what the dcloud server reports for its English audio.
  if (!l || l === 'unknown' || l === 'original' || l === 'default' || l === 'auto') return true;
  return /english|^en$|^eng$/.test(l);
}

function sendJson(res, code, obj) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// First non-comment line of an m3u8, resolved against the playlist's own URL.
function firstPlaylistEntry(text, baseUrl) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    try {
      return new URL(entry, baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

// The `ipcloud` and `tik` servers hide MPEG-TS behind a 70-byte 1x1 PNG
// header. ffmpeg decodes the PNG, finds no media and aborts, so the wrapper
// must be stripped before anything consumes the segment. utils/segment does
// the sniffing; the relay below does the stripping.
async function fetchText(url, extraHeaders) {
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: STREAM_REFERER, ...extraHeaders },
    timeout: 8000,
    maxContentLength: 4 * 1024 * 1024,
    responseType: 'text',
    transformResponse: [(d) => d],
    validateStatus: (s) => s >= 200 && s < 300,
    httpAgent,
    httpsAgent,
  });
  return typeof resp.data === 'string' ? resp.data : '';
}

// Reachability probe: fetch the playlist with the CDN's expected headers, then
// sniff the first media segment so we never hand ffmpeg a source it can't open.
async function isOpenable(url, extraHeaders = {}) {
  try {
    let playlist = await fetchText(url, extraHeaders);
    if (!playlist.includes('#EXTM3U')) return false;

    let entryUrl = firstPlaylistEntry(playlist, url);
    if (!entryUrl) return false;

    // A master playlist points at a variant; follow one level to the segments.
    if (playlist.includes('#EXT-X-STREAM-INF')) {
      playlist = await fetchText(entryUrl, extraHeaders);
      if (!playlist.includes('#EXTM3U')) return false;
      entryUrl = firstPlaylistEntry(playlist, entryUrl);
      if (!entryUrl) return false;
    }

    const seg = await axios.get(entryUrl, {
      // Enough bytes to verify the MPEG-TS sync pattern after an image prefix
      // (the wrapper is ~70 bytes, sync repeats every 188).
      headers: { 'User-Agent': UA, Referer: STREAM_REFERER, Range: 'bytes=0-1023', ...extraHeaders },
      timeout: 8000,
      responseType: 'arraybuffer',
      validateStatus: (s) => s >= 200 && s < 300,
      httpAgent,
      httpsAgent,
    });
    const data = Buffer.from(seg.data);
    const imagePrefix = looksLikeImage(data);
    const unwrapped = unwrapImageTs(data);
    const wrappedTs = unwrapped !== data && isMpegTs(unwrapped);

    console.log('[segment check]', {
      host: new URL(entryUrl).host,
      status: seg.status,
      imagePrefix,
      wrappedTs,
      first16: data.subarray(0, 16).toString('hex'),
    });

    // A real image (thumbnail/poster) is unplayable. An image *wrapper* around
    // MPEG-TS is fine: the local relay strips the prefix before ffmpeg sees it.
    return !imagePrefix || wrappedTs;
  } catch (e) {
    console.error('[source check failed]', {
      message: e.message,
      code: e.code,
      status: e.response?.status,
    });
    return false;
  }
}

// Walk servers in English-preferred order; return the first openable source,
// preferring English but falling back to any openable one.
async function selectStream({ tmdbId, type, season, episode, srOverride }) {
  const order = srOverride ? [srOverride] : SERVER_ORDER;
  let fallback = null;
  for (const sr of order) {
    let streams = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      streams = await getServerStreams({ tmdbId, type, season, episode, sr });
    } catch {
      streams = [];
    }
    for (const s of streams) {
      // eslint-disable-next-line no-await-in-loop
      const openable = await isOpenable(s.url, s.headers);
      console.log('[source check]', {
        server: sr,
        host: new URL(s.url).host,
        openable,
      });
      if (!openable) continue;
      if (isEnglishish(s.language)) return s;
      if (!fallback) fallback = s;
    }
  }
  return fallback;
}

// Spawn ffmpeg, remux (or CPU-interpolate) HLS -> fragmented MP4, pipe to the
// response.
function streamRemux(res, url, { download, filename, norm, previewSeconds, interpolationFps = null }) {
  const interpolate = Number(interpolationFps) > 0;
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-user_agent', UA,
    '-referer', STREAM_REFERER,
    '-extension_picky', '0',
    '-allowed_segment_extensions', 'ALL',
    '-i', url,
    ...(previewSeconds ? ['-t', String(previewSeconds)] : []),
    '-map', '0:v:0',
    '-map', '0:a:0?',

    ...(interpolate
      ? [
          '-vf', cpuInterpolationFilter(interpolationFps),
          '-c:v', 'libopenh264',
          '-b:v', RIFE_VBITRATE,
          '-bsf:v', `h264_metadata=tick_rate=${rifeVuiTickRate(interpolationFps)}`,
        ]
      : ['-c:v', 'copy']),

    // Lift quiet sources and tame hot ones without a second pass (not possible
    // on a live HLS stream). 48 kHz avoids loudnorm's internal 192 kHz leaking
    // into the output sample rate.
    ...(norm ? ['-af', AUDIO_NORM_FILTER, '-ar', '48000'] : []),
    '-c:a', 'aac',
    '-b:a', '512K',
    '-ac', '2',
    // HLS carries AAC as ADTS; MP4 needs raw ASC. Without this the muxer
    // rejects audio packets ("Operation not permitted") and ffmpeg aborts.
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let started = false;
  let stderr = '';
  ff.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  // Commit a 200 only once ffmpeg actually produces output.
  ff.stdout.once('data', (chunk) => {
    started = true;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'no-store');
    if (download) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write(chunk); // flushes 200 + headers
    ff.stdout.pipe(res);
  });

  ff.on('error', (e) => {
    if (!res.headersSent) sendJson(res, 502, { error: 'ffmpeg spawn failed', detail: e.message });
  });

  ff.on('close', (code) => {
    if (!started) {
      sendJson(res, 502, { error: 'remux failed', detail: stderr.slice(-400).trim() });
    } else if (!res.writableEnded) {
      res.end();
    }
    if (code) console.warn(`[mp4] ffmpeg exited code=${code} ${stderr.slice(-200).trim()}`);
  });

  // Client aborted -> kill ffmpeg so no orphans linger.
  const kill = () => {
    if (ff.exitCode === null && !ff.killed) ff.kill('SIGKILL');
  };
  res.on('close', kill);
}

// ---------------------------------------------------------------------------
// Optional frame interpolation (?interpolation=gpu|cpu)
// ---------------------------------------------------------------------------

// One interpolation job at a time (both modes are expensive and RIFE is also
// limited by the single GPU); normal playback is unaffected. Holds the active
// mode ('rife'/'cpu') or null.
let interpolationActive = null;

function interpolationBusy(res) {
  return sendJson(res, 503, {
    error: `a ${interpolationActive} interpolation job is already running; wait for it to finish or use normal playback`,
    interpolationBusy: interpolationActive,
  });
}

function streamRife(res, url, { download, filename, norm, previewSeconds, fps }) {
  if (interpolationActive) return interpolationBusy(res);
  interpolationActive = 'rife';

  const jobDir = path.join(RIFE_DIR, `job-${Date.now()}-${process.pid}`);
  const inputTs = path.join(jobDir, 'input.ts');

  fs.mkdirSync(jobDir, { recursive: true });

  let finished = false;
  const children = [];

  const cleanup = () => {
    if (finished) return;
    finished = true;
    interpolationActive = null;
    for (const c of children) {
      if (c.exitCode === null && !c.killed) c.kill('SIGKILL');
    }
    fs.rm(jobDir, { recursive: true, force: true }, () => {});
  };

  const killAll = () => {
    for (const c of children) {
      if (c.exitCode === null && !c.killed) c.kill('SIGKILL');
    }
  };
  res.on('close', () => {
    killAll();
    cleanup();
  });

  // Stage 1: download the episode (copy, no re-encode) into tmpfs as .ts.
  // FFMS2 needs a completed file to index, so this must finish first.
  const dl = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-user_agent', UA,
    '-referer', STREAM_REFERER,
    '-extension_picky', '0',
    '-allowed_segment_extensions', 'ALL',
    '-i', url,
    ...(previewSeconds ? ['-t', String(previewSeconds)] : []),
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-f', 'mpegts',
    inputTs,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(dl);

  let dlErr = '';
  dl.stderr.on('data', (d) => {
    dlErr = (dlErr + d.toString()).slice(-2000);
  });
  dl.on('error', (e) => {
    cleanup();
    sendJson(res, 502, { error: 'ffmpeg spawn failed', detail: e.message });
  });

  dl.on('close', (code) => {
    if (code !== 0) {
      cleanup();
      return sendJson(res, 502, { error: 'gpu: source download failed', detail: dlErr.trim() });
    }
    let size = 0;
    try {
      size = fs.statSync(inputTs).size;
    } catch {
      cleanup();
      return sendJson(res, 500, { error: 'gpu: downloaded file missing' });
    }
    if (size > RIFE_MAX_BYTES) {
      cleanup();
      return sendJson(res, 413, { error: `gpu: source too large for tmpfs (${(size / 1024 ** 3).toFixed(2)} GiB > limit ${(RIFE_MAX_BYTES / 1024 ** 3).toFixed(0)} GiB)`, });
    }
    console.log(`[gpu] downloaded ${(size / 1024 / 1024).toFixed(1)} MB, interpolating at ${fps} fps (${path.basename(jobDir)})`);
    stage2();
  });

  // Stage 2: rife-worker.py -> Y4M -> ffmpeg -> fragmented MP4 -> response.
  function stage2() {
    const py = spawn('python3', [RIFE_WORKER, inputTs, String(fps)], {
      stdio: ['ignore', 'pipe', 'inherit'], // stdout = Y4M, stderr = our logs
    });
    children.push(py);
    py.on('error', (e) => {
      cleanup();
      sendJson(res, 502, { error: 'python3 spawn failed', detail: e.message });
    });

    const ff = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'yuv4mpegpipe',
      '-i', 'pipe:0', // interpolated target-fps video from the worker
      '-f', 'mpegts',
      '-i', inputTs, // original audio
      '-map', '0:v:0',
      '-map', '1:a:0?',
      '-c:v', 'libopenh264',
      '-b:v', RIFE_VBITRATE,
      '-bsf:v', `h264_metadata=tick_rate=${rifeVuiTickRate(fps)}`,
      ...(norm ? ['-af', AUDIO_NORM_FILTER, '-ar', '48000'] : []),
      '-c:a', 'aac',
      '-b:a', '256k',
      '-ac', '2',
      '-shortest',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    ], { stdio: [py.stdout, 'pipe', 'pipe'] });
    children.push(ff);

    let started = false;
    let stderr = '';
    ff.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    ff.stdout.once('data', (chunk) => {
      started = true;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Cache-Control', 'no-store');
      if (download) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.write(chunk);
      ff.stdout.pipe(res);
    });

    ff.on('error', (e) => {
      cleanup();
      sendJson(res, 502, { error: 'ffmpeg spawn failed', detail: e.message });
    });

    ff.on('close', (code) => {
      if (!started) {
        sendJson(res, 502, { error: 'gpu: encode failed', detail: stderr.slice(-400).trim() });
      } else if (!res.writableEnded) {
        res.end();
      }
      if (code) console.warn(`[gpu] ffmpeg exited code=${code} ${stderr.slice(-200).trim()}`);
      cleanup();
    });

    // If the python worker dies, ffmpeg sees EOF on stdin and exits; the
    // ff close handler above reports the failure. Nothing else needed.
  }
}

// CPU mode: ffmpeg pulls the live relay playlist and re-encodes it through
// minterpolate. Unlike RIFE there is no pre-download, so playback starts as
// soon as ffmpeg has buffered enough frames (though CPU interpolation is often
// slower than realtime). The same one-job gate applies.
function streamCpu(res, url, opts) {
  const { download, filename, norm, previewSeconds, fps, workers } = opts;
  if (interpolationActive) return interpolationBusy(res);
  interpolationActive = 'cpu';

  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    interpolationActive = null;
  };
  res.on('close', cleanup);

  if (workers > 1) return streamCpuChunked(res, url, opts);

  return streamRemux(res, url, {
    download,
    filename,
    norm,
    previewSeconds,
    interpolationFps: fps,
  });
}

// Split CPU interpolation across workers. The source is downloaded once (a
// live HLS stream cannot be split into seekable ranges reliably), then every
// chunk is encoded in parallel. Video chunks are MPEG-TS with global
// timestamps; a final ffmpeg remuxes them in order and takes normalized audio
// from the complete source file, which keeps audio seamless across boundaries.
function streamCpuChunked(res, url, opts) {
  const { download, filename, norm, previewSeconds, fps, workers } = opts;
  const jobDir = path.join(CPU_INTERPOLATION_DIR, `cpu-${Date.now()}-${process.pid}`);
  // MP4 (not TS) because each worker seeks into its chunk, and TS seek points
  // are unreliable. The completed file is indexed by the moov before use.
  const inputFile = path.join(jobDir, 'input.mp4');
  fs.mkdirSync(jobDir, { recursive: true });

  const children = [];
  let finished = false;
  let started = false;
  let finalProc = null;

  const killAll = () => {
    for (const child of children) {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }
  };
  const cleanup = () => {
    if (finished) return;
    finished = true;
    killAll();
    fs.rm(jobDir, { recursive: true, force: true }, () => {});
  };
  res.on('close', cleanup);

  const fail = (code, body) => {
    if (!res.headersSent) sendJson(res, code, body);
    else if (!res.writableEnded) res.end();
    cleanup();
  };

  // Stage 1: completed local file, so each worker can seek to its chunk.
  const dl = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-user_agent', UA,
    '-referer', STREAM_REFERER,
    '-extension_picky', '0',
    '-allowed_segment_extensions', 'ALL',
    '-i', url,
    ...(previewSeconds ? ['-t', String(previewSeconds)] : []),
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-f', 'mp4',
    inputFile,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(dl);

  let dlErr = '';
  dl.stderr.on('data', (d) => {
    dlErr = (dlErr + d.toString()).slice(-2000);
  });
  dl.on('error', (e) => fail(502, { error: 'ffmpeg spawn failed', detail: e.message }));
  dl.on('close', async (code) => {
    if (finished) return;
    if (code !== 0) {
      return fail(502, { error: 'cpu: source download failed', detail: dlErr.trim() });
    }
    let size = 0;
    try {
      size = fs.statSync(inputFile).size;
    } catch {
      return fail(500, { error: 'cpu: downloaded file missing' });
    }
    if (size > CPU_MAX_BYTES) {
      return fail(413, {
        error: `cpu: source too large (${(size / 1024 ** 3).toFixed(2)} GiB > limit ${(CPU_MAX_BYTES / 1024 ** 3).toFixed(0)} GiB)`,
      });
    }

    let duration = 0;
    try {
      duration = await probeDuration(inputFile);
    } catch (e) {
      return fail(502, { error: 'cpu: could not read source duration', detail: e.message });
    }
    if (finished) return undefined;
    return startChunks(duration);
  });

  function startChunks(duration) {
    const chunks = planCpuChunks(duration, workers);
    console.log(
      `[cpu] downloaded ${(fs.statSync(inputFile).size / 1024 / 1024).toFixed(1)} MB, ${duration.toFixed(1)}s -> ${chunks.length} chunk(s) at ${fps} fps (${path.basename(jobDir)})`,
    );

    const chunkFiles = chunks.map((chunk) => path.join(jobDir, `chunk-${chunk.index}.ts`));
    const ready = chunks.map((chunk, index) =>
      runChunk(chunk, chunkFiles[index]));

    finalProc = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'mpegts',
      '-i', 'pipe:0',
      '-i', inputFile,
      '-map', '0:v:0',
      '-map', '1:a:0?',
      '-c:v', 'copy',
      ...(norm ? ['-af', AUDIO_NORM_FILTER, '-ar', '48000'] : []),
      '-c:a', 'aac',
      '-b:a', '256k',
      '-ac', '2',
      '-shortest',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(finalProc);

    let finalErr = '';
    finalProc.stderr.on('data', (d) => {
      finalErr = (finalErr + d.toString()).slice(-4000);
    });

    finalProc.stdout.once('data', (chunk) => {
      started = true;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Cache-Control', 'no-store');
      if (download) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.write(chunk);
      finalProc.stdout.pipe(res);
    });

    finalProc.on('error', (e) => fail(502, { error: 'ffmpeg spawn failed', detail: e.message }));
    finalProc.on('close', (code) => {
      if (!started) {
        fail(502, { error: 'cpu: encode failed', detail: finalErr.slice(-400).trim() });
        return;
      }
      if (!res.writableEnded) res.end();
      if (code) console.warn(`[cpu] ffmpeg exited code=${code} ${finalErr.slice(-200).trim()}`);
      cleanup();
    });

    let stdinError = null;
    finalProc.stdin.on('error', (e) => {
      stdinError = e;
    });

    (async () => {
      for (let index = 0; index < chunks.length; index += 1) {
        // eslint-disable-next-line no-await-in-loop
        await ready[index];
        // eslint-disable-next-line no-await-in-loop
        await pipeFileToStdin(chunkFiles[index], finalProc.stdin, () => stdinError);
        fs.rm(chunkFiles[index], { force: true }, () => {});
      }
      if (!finalProc.stdin.destroyed) finalProc.stdin.end();
    })().catch((e) => {
      if (!started) {
        fail(502, { error: 'cpu: chunk failed', detail: e.message });
      } else {
        if (!res.writableEnded) res.end();
        cleanup();
      }
    });

    function runChunk(chunk, outputTs) {
      return new Promise((resolve, reject) => {
        if (finished) return reject(new Error('cancelled'));
        const child = spawn('ffmpeg', cpuChunkArgs(inputFile, outputTs, chunk, fps), {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        children.push(child);
        let err = '';
        child.stderr.on('data', (d) => {
          err = (err + d.toString()).slice(-2000);
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (finished) return reject(new Error('cancelled'));
          if (code !== 0) {
            const detail = err.trim() || `ffmpeg exited code=${code}`;
            fail(502, { error: 'cpu: chunk encode failed', detail });
            return reject(new Error(detail));
          }
          return resolve();
        });
      });
    }
  }
}

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    ff.stdout.on('data', (d) => { out += d.toString(); });
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffprobe exited code=${code}`));
      const duration = Number(out.trim());
      if (!Number.isFinite(duration) || duration <= 0) {
        return reject(new Error(`invalid duration: ${out.trim()}`));
      }
      return resolve(duration);
    });
  });
}

function planCpuChunks(duration, workers) {
  const count = Math.max(1, Math.min(workers, Math.ceil(duration / CPU_MIN_CHUNK_SECONDS)));
  const length = duration / count;
  return Array.from({ length: count }, (_, index) => {
    const start = index * length;
    return {
      index,
      start,
      duration: index === count - 1 ? duration - start : length,
    };
  });
}

function cpuChunkArgs(inputFile, outputTs, { start, duration }, fps) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', start.toFixed(3),
    '-t', duration.toFixed(3),
    '-i', inputFile,
    '-map', '0:v:0',
    '-an',
    // Reset per-chunk timestamps and place them back on the global timeline.
    '-vf', `${cpuInterpolationFilter(fps)},setpts=PTS-STARTPTS`,
    '-c:v', 'libopenh264',
    '-b:v', RIFE_VBITRATE,
    '-bsf:v', `h264_metadata=tick_rate=${rifeVuiTickRate(fps)}`,
    // Each chunk starts a fresh continuity counter; mark it so the final
    // concat/remux treats the boundary as a discontinuity, not corruption.
    '-mpegts_flags', '+initial_discontinuity',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-output_ts_offset', start.toFixed(3),
    '-f', 'mpegts',
    outputTs,
  ];
}

function pipeFileToStdin(file, stdin, getError) {
  return new Promise((resolve, reject) => {
    const stdinError = getError();
    if (stdinError || stdin.destroyed) {
      return reject(stdinError || new Error('final ffmpeg input closed'));
    }

    const rs = fs.createReadStream(file);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      rs.destroy();
      fn(value);
    };

    rs.on('error', (e) => finish(reject, e));
    rs.on('end', () => finish(resolve));
    rs.on('data', (buf) => {
      const err = getError();
      if (err || stdin.destroyed) {
        return finish(reject, err || new Error('final ffmpeg input closed'));
      }
      if (!stdin.write(buf)) {
        rs.pause();
        const onDrain = () => {
          stdin.off('error', onError);
          stdin.off('close', onClose);
          rs.resume();
        };
        const onError = (e) => {
          stdin.off('drain', onDrain);
          stdin.off('close', onClose);
          finish(reject, e);
        };
        const onClose = () => {
          stdin.off('drain', onDrain);
          stdin.off('error', onError);
          finish(reject, getError() || new Error('final ffmpeg input closed'));
        };
        stdin.once('drain', onDrain);
        stdin.once('error', onError);
        stdin.once('close', onClose);
      }
      return undefined;
    });
  });
}

async function handle(req, res, type, params, query) {
  const { tmdbId, season, episode } = params;
  if (!/^\d+$/.test(tmdbId || '')) {
    return sendJson(res, 400, { error: 'tmdbId must be numeric' });
  }
  if (type === 'tv' && (!/^\d+$/.test(season || '') || !/^\d+$/.test(episode || ''))) {
    return sendJson(res, 400, { error: 'tv requires numeric season and episode' });
  }
  // Server ids are names now ("dcloud", "v6:Hindi"), not numbers.
  const srOverride = typeof query.sr === 'string' && query.sr.trim() ? query.sr.trim() : null;
  const download = query.download === '1' || query.download === 'true';
  const { mode: interpolation, legacy: legacyRife, invalid: invalidInterpolation } =
    parseInterpolation(query);
  if (invalidInterpolation) {
    return sendJson(res, 400, {
      error: `unknown interpolation mode '${invalidInterpolation}'`,
      usage: '?interpolation=gpu|cpu|off',
    });
  }
  const { fps: interpolationFps, invalid: invalidFps } = interpolationFpsRequested(query);
  if (interpolation && invalidFps) {
    return sendJson(res, 400, {
      error: `invalid fps '${invalidFps}'; expected a number between 1 and ${INTERPOLATION_FPS_MAX}`,
      usage: '?interpolation=gpu|cpu&fps=40',
    });
  }
  const { workers: interpolationWorkers, invalid: invalidWorkers } =
    interpolationWorkersRequested(query);
  if (interpolation === 'cpu' && invalidWorkers) {
    return sendJson(res, 400, {
      error: `invalid workers '${invalidWorkers}'; expected an integer between 1 and ${CPU_WORKERS_MAX}`,
      usage: '?interpolation=cpu&workers=4',
    });
  }
  if (interpolation === 'gpu' && !RIFE_ENABLED) {
    return sendJson(res, 503, { error: 'GPU interpolation is disabled on this server' });
  }
  if (interpolation === 'cpu' && !CPU_INTERPOLATION_ENABLED) {
    return sendJson(res, 503, { error: 'CPU interpolation is disabled on this server' });
  }
  if (legacyRife) {
    console.warn('[mp4] the RIFE alias is deprecated; use ?interpolation=gpu');
  }
  const norm = audioNormRequested(query);
  const previewSeconds = previewSecondsRequested(query);
  const filename =
    type === 'tv' ? `tv-${tmdbId}-s${season}e${episode}.mp4` : `movie-${tmdbId}.mp4`;

  try {
    const chosen = await selectStream({ tmdbId, type, season, episode, srOverride });
    if (!chosen) return sendJson(res, 404, { error: 'no playable source' });
    // Feed ffmpeg a loopback playlist instead of the CDN URL. The relay applies
    // the DoH DNS fallback and strips image wrappers from segments, neither of
    // which ffmpeg can do itself.
    const relayUrl = buildPlaylistUrl(
      chosen.url,
      { Referer: STREAM_REFERER, ...chosen.headers },
      req.socket.localPort,
    );
    console.log(
      `[mp4] ${type}/${tmdbId}${type === 'tv' ? ` s${season}e${episode}` : ''} -> sr=${chosen.sr} lang=${chosen.language}${interpolation ? ` INTERPOLATION=${interpolation} FPS=${interpolationFps}${interpolation === 'cpu' ? ` WORKERS=${interpolationWorkers}` : ''}` : ''}${norm ? ' NORM=on' : ''}${previewSeconds ? ` PREVIEW=${previewSeconds}s` : ''} (${chosen.name})`,
    );
    if (interpolation === 'gpu') {
      return streamRife(res, relayUrl, { download, filename, norm, previewSeconds, fps: interpolationFps });
    }
    if (interpolation === 'cpu') {
      return streamCpu(res, relayUrl, {
        download,
        filename,
        norm,
        previewSeconds,
        fps: interpolationFps,
        workers: interpolationWorkers,
      });
    }
    return streamRemux(res, relayUrl, { download, filename, norm, previewSeconds });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error', detail: e.message });
    return undefined;
  }
}

async function requestListener(req, res) {
  let parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'bad url' });
  }

  // Relay requests bypass normal routing. They are loopback-only in practice
  // (the URL handed to ffmpeg is 127.0.0.1) and token-protected.
  if (await handleRelay(req, res, parsed)) return undefined;

  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(parsed.searchParams);

  if (parts.length === 1 && parts[0] === 'health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'vidzee-mp4',
      interpolationBusy: interpolationActive,
      rifeBusy: interpolationActive === 'gpu', // backwards-compatible field
    });
  }
  if (parts.length === 2 && parts[0] === 'movie') {
    return handle(req, res, 'movie', { tmdbId: parts[1] }, query);
  }
  if (parts.length === 4 && parts[0] === 'tv') {
    return handle(req, res, 'tv', { tmdbId: parts[1], season: parts[2], episode: parts[3] }, query);
  }
  return sendJson(res, 404, { error: 'not found', usage: '/movie/<id>  |  /tv/<id>/<season>/<episode>' });
}

function createServer() {
  return http.createServer((req, res) => {
    Promise.resolve(requestListener(req, res)).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error', detail: e.message });
      else if (!res.writableEnded) res.end();
    });
  });
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`VidZee MP4 API listening on http://${HOST}:${PORT}`);
    console.log('  GET /movie/:tmdbId');
    console.log('  GET /tv/:tmdbId/:season/:episode   (?sr=<name>, ?download=1, ?interpolation=gpu|cpu)');
  });
}

module.exports = {
  createServer,
  requestListener,
  selectStream,
  isEnglishish,
  firstPlaylistEntry,
  looksLikeImage,
  unwrapImageTs,
  audioNormRequested,
  AUDIO_NORMALIZE_DEFAULT,
  previewSecondsRequested,
  parseInterpolation,
  interpolationFpsRequested,
  interpolationWorkersRequested,
  DEFAULT_INTERPOLATION_FPS,
  INTERPOLATION_FPS_MAX,
  CPU_WORKERS_DEFAULT,
  CPU_WORKERS_MAX,
  planCpuChunks,
  cpuInterpolationFilter,
  rifeVuiTickRate,
};
