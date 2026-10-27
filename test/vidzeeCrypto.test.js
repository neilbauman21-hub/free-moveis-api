// Deterministic tests for VidZee stream resolution — no network.
//
// VidZee dropped the api-key/AES scheme entirely (see providers/vidzeeCrypto.js).
// What's left to pin down is URL construction and response normalisation, both
// pure. Payload fixtures below are verbatim real responses.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { buildStreamUrl, normalizeStreams, DEFAULT_SERVERS } = require('../providers/vidzeeCrypto');
const {
  isEnglishish,
  firstPlaylistEntry,
  looksLikeImage,
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
} = require('../vidzee-mp4');

test('buildStreamUrl builds a movie URL with plaintext mode', () => {
  assert.strictEqual(
    buildStreamUrl({ tmdbId: 550, type: 'movie', sr: 'dcloud' }),
    'https://core.vidzee.wtf/streams/movie/550?s=dcloud&e=0',
  );
});

test('buildStreamUrl builds a tv URL with season and episode', () => {
  assert.strictEqual(
    buildStreamUrl({ tmdbId: 1396, type: 'tv', season: 1, episode: 1, sr: 'dcloud' }),
    'https://core.vidzee.wtf/streams/tv/1396/1/1?s=dcloud&e=0',
  );
});

test('buildStreamUrl percent-encodes server ids containing a colon', () => {
  assert.strictEqual(
    buildStreamUrl({ tmdbId: 550, type: 'movie', sr: 'v6:Hindi' }),
    'https://core.vidzee.wtf/streams/movie/550?s=v6%3AHindi&e=0',
  );
});

test('normalizeStreams maps a real plaintext payload to a stream', () => {
  const payload = {
    language: 'Auto',
    url: 'https://cdn2.1shows.app/movie/abc._K4xLdHx/index.m3u8',
    headers: {},
  };
  assert.deepStrictEqual(normalizeStreams(payload, 'dcloud'), [
    {
      sr: 'dcloud',
      name: 'VidZee dcloud',
      language: 'Auto',
      type: 'hls',
      url: 'https://cdn2.1shows.app/movie/abc._K4xLdHx/index.m3u8',
      headers: {},
    },
  ]);
});

test('normalizeStreams passes through upstream-required headers', () => {
  const payload = {
    language: 'hindi',
    url: 'https://img1.hvncw.com/hls/x/720/index_309.m3u8?auth_key=k',
    headers: { Origin: 'https://example.test' },
  };
  const [s] = normalizeStreams(payload, 'v6:Hindi');
  assert.deepStrictEqual(s.headers, { Origin: 'https://example.test' });
  assert.strictEqual(s.language, 'hindi');
});

test('normalizeStreams defaults a missing language to unknown', () => {
  const [s] = normalizeStreams({ url: 'https://x.test/a.m3u8' }, 'tik');
  assert.strictEqual(s.language, 'unknown');
  assert.deepStrictEqual(s.headers, {});
});

test('normalizeStreams returns [] for error and malformed payloads', () => {
  // What the API actually returns for a bad server id, and for still-encrypted
  // responses (e=1) that this client no longer asks for.
  assert.deepStrictEqual(normalizeStreams({ error: 'Unknown server' }, 'nope'), []);
  assert.deepStrictEqual(normalizeStreams({ c: 'JHd/O54eLA5vxsCt' }, 'dcloud'), []);
  assert.deepStrictEqual(normalizeStreams({ url: 'not-a-url' }, 'dcloud'), []);
  assert.deepStrictEqual(normalizeStreams({ url: '' }, 'dcloud'), []);
  assert.deepStrictEqual(normalizeStreams(null, 'dcloud'), []);
  assert.deepStrictEqual(normalizeStreams('nonsense', 'dcloud'), []);
});

test('DEFAULT_SERVERS lists the current server ids, dubbed last', () => {
  assert.deepStrictEqual(DEFAULT_SERVERS, ['dcloud', 'tik', 'ipcloud', 'v6:Hindi']);
});

test('firstPlaylistEntry resolves the first entry, relative or absolute', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1441498,RESOLUTION=1280x720',
    'index-v1-a1.m3u8',
  ].join('\n');
  assert.strictEqual(
    firstPlaylistEntry(master, 'https://cdn1.1shows.app/e/Abc/master.m3u8'),
    'https://cdn1.1shows.app/e/Abc/index-v1-a1.m3u8',
  );

  const variant = ['#EXTM3U', '', '#EXTINF:10.010,', 'https://p1.ipstatp.com/origin/x/abc'].join('\n');
  assert.strictEqual(
    firstPlaylistEntry(variant, 'https://cdn1.1shows.app/e/Abc/index-v1-a1.m3u8'),
    'https://p1.ipstatp.com/origin/x/abc',
  );
});

test('firstPlaylistEntry returns null when a playlist has no entries', () => {
  assert.strictEqual(firstPlaylistEntry('#EXTM3U\n#EXT-X-ENDLIST\n', 'https://x.test/a.m3u8'), null);
  assert.strictEqual(firstPlaylistEntry('', 'https://x.test/a.m3u8'), null);
});

test('looksLikeImage spots the PNG-wrapped segments ipcloud serves', () => {
  // Real 1x1 PNG header; the MPEG-TS payload starts at byte 70.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.strictEqual(looksLikeImage(png), true);
  assert.strictEqual(looksLikeImage(Buffer.from('ffd8ffe000104a46', 'hex')), true); // JPEG
  // A bare MPEG-TS packet must pass: 0x47 sync, PAT PID.
  assert.strictEqual(looksLikeImage(Buffer.from('474000100000b00d', 'hex')), false);
  assert.strictEqual(looksLikeImage(Buffer.alloc(0)), false);
  assert.strictEqual(looksLikeImage(null), false);
});

test('isEnglishish prefers English/original, rejects other languages', () => {
  assert.strictEqual(isEnglishish('English'), true);
  assert.strictEqual(isEnglishish(''), true);
  assert.strictEqual(isEnglishish('unknown'), true);
  // The dcloud server reports "Auto" for its English audio.
  assert.strictEqual(isEnglishish('Auto'), true);
  assert.strictEqual(isEnglishish('Vietnamese'), false);
  assert.strictEqual(isEnglishish('Hindi'), false);
});

test('audioNormRequested: query overrides the env default in both directions', () => {
  // Explicit values always win, so these hold regardless of AUDIO_NORMALIZE.
  assert.strictEqual(audioNormRequested({ norm: '1' }), true);
  assert.strictEqual(audioNormRequested({ norm: 'true' }), true);
  assert.strictEqual(audioNormRequested({ norm: '0' }), false);
  assert.strictEqual(audioNormRequested({ norm: 'false' }), false);
  // Unset/unknown falls through to the module default (on in the test env).
  assert.strictEqual(audioNormRequested({}), AUDIO_NORMALIZE_DEFAULT);
  assert.strictEqual(audioNormRequested({ norm: 'yes' }), AUDIO_NORMALIZE_DEFAULT);
  assert.strictEqual(audioNormRequested(null), AUDIO_NORMALIZE_DEFAULT);
});

test('AUDIO_NORMALIZE=0 opts out of the default', () => {
  const out = execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(String(require('./vidzee-mp4').AUDIO_NORMALIZE_DEFAULT))"],
    {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AUDIO_NORMALIZE: '0' },
    },
  ).toString();
  assert.strictEqual(out, 'false');
});

test('previewSecondsRequested caps and validates the preview window', () => {
  assert.strictEqual(previewSecondsRequested({ preview: '60' }), 60);
  assert.strictEqual(previewSecondsRequested({ preview: '1' }), 1);
  // Clamped to 10 minutes.
  assert.strictEqual(previewSecondsRequested({ preview: '9999' }), 600);
  // Floored to whole seconds.
  assert.strictEqual(previewSecondsRequested({ preview: '60.9' }), 60);
  // Absent/invalid means no limit (not zero, which would mean "no output").
  assert.strictEqual(previewSecondsRequested({}), null);
  assert.strictEqual(previewSecondsRequested(null), null);
  assert.strictEqual(previewSecondsRequested({ preview: '' }), null);
  assert.strictEqual(previewSecondsRequested({ preview: 'abc' }), null);
  assert.strictEqual(previewSecondsRequested({ preview: '0' }), null);
  assert.strictEqual(previewSecondsRequested({ preview: '-5' }), null);
});

test('parseInterpolation handles explicit modes, aliases and legacy ?rife=1', () => {
  assert.deepStrictEqual(parseInterpolation({}), { mode: null, legacy: false });
  assert.deepStrictEqual(parseInterpolation(null), { mode: null, legacy: false });
  // GPU is the public mode name; RIFE is an implementation detail.
  assert.deepStrictEqual(parseInterpolation({ interpolation: 'gpu' }), { mode: 'gpu', legacy: false });
  assert.deepStrictEqual(parseInterpolation({ interpolation: 'GPU' }), { mode: 'gpu', legacy: false });
  assert.deepStrictEqual(parseInterpolation({ interpolation: 'rife' }), { mode: 'gpu', legacy: true });
  assert.deepStrictEqual(parseInterpolation({ interpolation: 'cpu' }), { mode: 'cpu', legacy: false });
  assert.deepStrictEqual(parseInterpolation({ interpolation: ' CPU ' }), { mode: 'cpu', legacy: false });
  assert.deepStrictEqual(parseInterpolation({ interpolation: 'off' }), { mode: null, legacy: false });
  assert.deepStrictEqual(parseInterpolation({ interpolation: 'none' }), { mode: null, legacy: false });
  assert.deepStrictEqual(parseInterpolation({ interpolation: '0' }), { mode: null, legacy: false });
  // Backwards compatibility: ?rife=1 behaves like ?interpolation=gpu.
  assert.deepStrictEqual(parseInterpolation({ rife: '1' }), { mode: 'gpu', legacy: true });
  // An explicit mode wins over the legacy flag (including an explicit "off").
  assert.deepStrictEqual(
    parseInterpolation({ rife: '1', interpolation: 'cpu' }),
    { mode: 'cpu', legacy: false },
  );
  assert.deepStrictEqual(
    parseInterpolation({ rife: '1', interpolation: 'off' }),
    { mode: null, legacy: false },
  );
  // Unknown values are reported rather than silently ignored.
  assert.deepStrictEqual(
    parseInterpolation({ interpolation: 'gpuu' }),
    { mode: null, legacy: false, invalid: 'gpuu' },
  );
});

test('interpolationFpsRequested validates ?fps= and applies the default', () => {
  assert.strictEqual(interpolationFpsRequested({}).fps, DEFAULT_INTERPOLATION_FPS);
  assert.strictEqual(interpolationFpsRequested({}, 48).fps, 48);
  assert.strictEqual(interpolationFpsRequested({ fps: '60' }).fps, 60);
  assert.strictEqual(interpolationFpsRequested({ fps: ' 60 ' }).fps, 60);
  assert.strictEqual(interpolationFpsRequested({ fps: '59.94' }).fps, 59.94);
  assert.strictEqual(interpolationFpsRequested({ fps: '60.1234' }).fps, 60.123);
  assert.strictEqual(interpolationFpsRequested({ fps: String(INTERPOLATION_FPS_MAX) }).fps, 240);
  // Invalid values are reported instead of silently using the default.
  for (const fps of ['0', '-1', '241', 'abc', 'NaN', 'Infinity']) {
    assert.deepStrictEqual(interpolationFpsRequested({ fps }), { fps: null, invalid: fps });
  }
});

test('interpolationWorkersRequested validates the CPU worker count', () => {
  assert.strictEqual(interpolationWorkersRequested({}).workers, CPU_WORKERS_DEFAULT);
  assert.strictEqual(interpolationWorkersRequested({}, 4).workers, 4);
  assert.strictEqual(interpolationWorkersRequested({ workers: '1' }).workers, 1);
  assert.strictEqual(interpolationWorkersRequested({ workers: '8' }).workers, 8);
  assert.strictEqual(
    interpolationWorkersRequested({ workers: String(CPU_WORKERS_MAX) }).workers,
    CPU_WORKERS_MAX,
  );
  for (const workers of ['0', '-1', '1.5', 'abc', String(CPU_WORKERS_MAX + 1)]) {
    assert.deepStrictEqual(
      interpolationWorkersRequested({ workers }),
      { workers: null, invalid: workers },
    );
  }
});

test('planCpuChunks splits duration into seekable, ordered ranges', () => {
  const chunks = planCpuChunks(100, 4);
  assert.strictEqual(chunks.length, 4);
  assert.deepStrictEqual(chunks.map((c) => c.start), [0, 25, 50, 75]);
  assert.deepStrictEqual(chunks.map((c) => c.duration), [25, 25, 25, 25]);
  // The last chunk absorbs floating-point remainder and never exceeds duration.
  const odd = planCpuChunks(10, 3);
  assert.strictEqual(odd.length, 2); // min chunk length is 5 seconds
  assert.strictEqual(odd[0].start, 0);
  assert.strictEqual(odd[1].start, 5);
  assert.strictEqual(odd[1].duration, 5);
});

test('INTERPOLATION_FPS sets the default target rate', () => {
  const out = execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(String(require('./vidzee-mp4').DEFAULT_INTERPOLATION_FPS))"],
    {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, INTERPOLATION_FPS: '48', RIFE_FPS: '' },
    },
  ).toString();
  assert.strictEqual(out, '48');
});

test('cpuInterpolationFilter substitutes the target fps', () => {
  assert.match(cpuInterpolationFilter(40), /^minterpolate=fps=40:/);
  assert.match(cpuInterpolationFilter(30), /fps=30/);
  assert.match(cpuInterpolationFilter(59.94), /fps=59\.94/);
  // Same sanitising as the VUI tick rate: never emit fps=0.
  assert.match(cpuInterpolationFilter(0), /fps=1/);
  assert.match(cpuInterpolationFilter(undefined), /fps=1/);
});

test('rifeVuiTickRate doubles the progressive frame rate for H.264 VUI', () => {
  // time_scale/num_units_in_tick is per-field, so a 40 fps stream needs 80.
  assert.strictEqual(rifeVuiTickRate(40), 80);
  assert.strictEqual(rifeVuiTickRate(30), 60);
  assert.strictEqual(rifeVuiTickRate(25), 50);
  // Fractional target rates keep their precision in the rational VUI value.
  assert.strictEqual(rifeVuiTickRate(59.94), 119.88);
  // Never emit a zero tick rate (VLC would then ignore the timing info).
  assert.strictEqual(rifeVuiTickRate(0), 2);
  assert.strictEqual(rifeVuiTickRate(undefined), 2);
});
