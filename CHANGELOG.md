# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **`?interpolation=gpu|cpu`** replaces the RIFE-only flag with one explicit switch. `gpu` is the public name for the VapourSynth/RIFE GPU path (RIFE is an implementation detail); `cpu` adds GPU-free interpolation through ffmpeg's `minterpolate` filter (motion-compensated, re-encoded with `libopenh264`). `?interpolation=off` (or omitting it) is the default copy remux. **`?interpolation=rife` and `?rife=1` still work as deprecated aliases for `gpu`.**
- **`?fps=<n>`** chooses the interpolation target rate, 1–240, including fractional rates such as `59.94`. Default remains 40; `INTERPOLATION_FPS` overrides the default for every request (`RIFE_FPS` is still honoured).
- **`?workers=<n>`** for CPU mode (1–32): `minterpolate` is effectively single-threaded, so the default downloads the source once and splits it into time chunks that run in parallel, then concatenates them and takes audio from the complete source. The default is all but one core, capped at 8; `?workers=1` keeps the old live single-process stream. Chunk size is tunable with `CPU_MIN_CHUNK_SECONDS`.
- `CPU_INTERPOLATION_FILTER`, `CPU_INTERPOLATION_DISABLED`, `CPU_INTERPOLATION_DIR` and `CPU_MAX_BYTES` for tuning/disabling CPU mode; `{fps}` in the filter is replaced with the requested rate.
- `GET /health` now reports `interpolationBusy` (the active mode or `null`) alongside the existing `rifeBusy` field.

### Changed
- Unknown `?interpolation=` values and invalid `?fps=`/`?workers=` values now return `400` with usage instead of silently playing normal mode.
- Both interpolation modes share the one-job-at-a-time gate; normal playback is still unaffected.
- `rife-worker.py` accepts decimal target rates and passes an exact rational (`fps_num`/`fps_den`) to RIFE.

### Tests
- 44 total; added interpolation mode/FPS/worker parsing, CPU chunk planning, default-rate env coverage, and decimal CPU filter coverage.

## [1.0.16] - 2026-10-25

### Fixed
- **VLC (and other players) would not report the RIFE frame rate.** The live output is fragmented MP4, so `moov` carries no duration, and `libopenh264` wrote no H.264 VUI timing (`timing_info_present_flag=0`); VLC therefore had nothing to display and kept showing the previous/source rate (25 fps). The RIFE encoder now passes `h264_metadata=tick_rate=<2×fps>`, which writes `time_scale=80, num_units_in_tick=1` for 40 fps. VLC's Codec Information now reports **40 fps** for the stream, matching `ffprobe`/`mediainfo` (2401 frames / 60.046 s).
- `fixed_frame_rate_flag` is deliberately not set: OpenH264's SPS has `low_delay_hrd_flag=1`, which ffmpeg's `h264_metadata` rejects when that flag is forced.

### Tests
- 38 total; added `rifeVuiTickRate` coverage.

## [1.0.15] - 2026-10-25

### Added
- **`?preview=<seconds>`** caps the output (and, for RIFE, the download) at N seconds, max 600. RIFE normally downloads the entire title before producing a frame, which makes a quick visual check impractical; this lets you A/B the first minute in VLC. Works with and without `?rife=1`. Invalid/zero values mean no limit.

### Tests
- 37 total; added preview parsing/clamping coverage.

## [1.0.14] - 2026-10-25

### Changed
- **Loudness normalization is now enabled by default** (1.0.13 shipped it opt-in). Every request targets `-16 LUFS`/`-1.5 dBTP`, including RIFE output. `?norm=0` opts out per request; `AUDIO_NORMALIZE=0` opts out for all requests. `AUDIO_NORM_FILTER` still overrides the target.

### Tests
- 36 total; added a child-process check that `AUDIO_NORMALIZE=0` disables the default.

## [1.0.13] - 2026-10-25

### Added
- **Optional audio loudness normalization.** Source levels vary widely (measured `-28.9 LUFS` for Breaking Bad on `tik`, `-22.0 LUFS` for the same episode on `dcloud`, `-15.6 LUFS` for Fight Club), and the API previously left them untouched. `?norm=1` now applies single-pass EBU R128 `loudnorm` (`-16 LUFS`, `-1.5 dBTP`, `LRA=11`) to both remux and RIFE output; `?norm=0` forces it off. Set `AUDIO_NORMALIZE=1` to enable it by default, or override the filter with `AUDIO_NORM_FILTER`. Opt-in rather than default so already-hot sources are not attenuated unexpectedly.

### Tests
- Added tri-state coverage for `audioNormRequested` (`?norm=1`/`0`/unset); 35 total.

## [1.0.12] - 2026-10-25

### Fixed
- **`tik` VidZee server**: Two independent faults made it look dead. (1) `tik` playlists point at TikTok CDN hosts (`p16-sg.tiktokcdn.com`), which some LAN resolvers answer `NXDOMAIN` for even though they resolve publicly; Node/ffmpeg failed with `getaddrinfo ENOTFOUND` before opening a socket. Added `utils/dnsFallback.js`: system resolver first, DNS-over-HTTPS (Google, then Cloudflare) on failure, with TTL caching, wired into every axios/node-fetch outbound call. (2) `tik` segments are a 70-byte 1×1 PNG header followed by MPEG-TS — the same trick `ipcloud` uses — which the probe rejected as an image. Added `utils/segment.js` to detect and strip wrappers, and `utils/hlsRelay.js`, a token-protected loopback relay that gives ffmpeg a local playlist so it gets DoH-resolved, unwrapped segments.
- **MP4 source probe** now reads 1 KB rather than 16 bytes so the TS sync after an image prefix can be verified; image-wrapped TS is accepted instead of skipped.
- **Optional proxy layer** (`enableProxy`): m3u8 rewriting now proxies extensionless segment URLs (TikTok's `/obj/…/<hash>` lines previously fell through to the raw CDN and broke DNS); `#EXT-X-KEY`/`#EXT-X-MAP` members are handled; `/ts-proxy` and the segment cache strip image wrappers and serve `video/mp2t`; all upstream fetches use the DoH-capable agents.
- **Docs**: troubleshooting entry for blocked TikTok CDN DNS.

### Tests
- Added 9 network-free tests (`test/segment.test.js`, `test/hlsRelay.test.js`) covering wrapper detection/removal and relay/proxy playlist rewriting; 34 total.

## [1.0.11] - 2026-08-06

### Fixed
- **Phantom `vidzeecrypto` provider**: `providers/registry.js` and `utils/config.js` each derived the provider list by scanning `providers/*.js` and subtracting a hand-maintained deny-list, so the `vidzeeCrypto.js` helper was treated as a provider — it appeared in `/api/providers` and `/api/status`, gained an `enableVidzeecryptoProvider` config flag, and logged `does not export undefined` on every aggregate request. Introduced `providers/catalog.js` as the single source of truth for provider name → file → exported function; both modules now read from it.
- **Provider list ordering**: was `readdir()` order (filesystem-hash dependent, so it could differ between machines); now stable and alphabetical.

### Security
- `GET/POST /api/config`, `GET /api/debug/env` and `POST /api/restart` now require a session. `/api/config` returned the merged config — including TMDB API keys — and accepted arbitrary writes from any unauthenticated caller; `/config.html` was gated but the API behind it was not. The admin UI is unaffected (same-origin `fetch` sends the session cookie).
- `utils/auth-users.json`, `utils/user-config.json` and `.env` are no longer tracked; they hold per-deployment credentials and state. `utils/auth-users.json` is recreated on first start with the documented `admin` / `change-me` default, and `utils/user-config.example.json` is provided as a template.

### Changed
- `apiServer.js`: removed the `process.exit` monkey-patch that silently swallowed every exit (no provider calls `process.exit`, so the guard was inert), plus the heartbeat interval and `beforeExit`/`exit`/`setImmediate` debug tracing left over from a past investigation. Deduplicated the two `/api/streams` handlers into a shared `collectStreams`, hoisted the inline `require('fs')` calls, and switched `public/` and `restart.trigger` path resolution from `process.cwd()` to `__dirname` so the server can be started from any directory.
- `utils/config.js`: same `__dirname` fix for `user-config.json` resolution, extracted the repeated enable-flag/env-var name derivation into the catalog, and split `normalizeConfig` so the TMDB multi-key rules are readable. `normalizeConfig` and `parseCookies` are now exported for testing.
- `providers/registry.js`: rewritten around the catalog; the Showbox global-state special case is isolated in one function with `try/finally` restore.

### Added
- `test/catalog.test.js` and `test/config.test.js` — 16 tests covering provider catalog integrity (every catalogued export exists; helpers are not providers) and config normalisation (TMDB key rules, boolean coercion, provider flag defaults, cookie parsing).

## [1.0.10] - 2026-08-06

### Fixed
- **VidZee provider**: Rewritten for VidZee's rebuilt player. Both endpoints the previous implementation relied on now return 404 (`core.vidzee.wtf/api-key` and `player.vidzee.wtf/api/server`), so the whole AES-256-GCM → AES-256-CBC rotating-key chain is gone. The replacement API is `core.vidzee.wtf/streams/{movie|tv}/<tmdbId>[/<season>/<episode>]?s=<server>&e=<0|1>`, where `e` selects the response encoding: `e=1` returns `{"c": "<blob>"}` that the player decrypts in WebAssembly, `e=0` returns the stream URL in plaintext. We request `e=0`, which removes the need for any decryption. Servers are named ids now (`dcloud`, `tik`, `ipcloud`, `v6:Hindi`) instead of numbers `1..10`, so `?sr=` on the MP4 API takes a name.
- **VidZee stream headers**: Stream requests now send `Referer: https://player.vidzee.wtf/` instead of the stale `https://core.vidzee.wtf/`. `cdn1.1shows.app` 403s on the old value; every CDN that accepted the old one accepts this too.
- **MP4 API source selection**: The openability probe now follows a master playlist to its first media segment and sniffs the magic bytes. The `ipcloud` server wraps its MPEG-TS segments in a 70-byte 1×1 PNG header, which ffmpeg decodes as a still image and then aborts with "Output file does not contain any stream"; such sources are now skipped instead of being handed to ffmpeg. `"Auto"` (what `dcloud` reports for English audio) counts as English for server preference ordering.

### Removed
- `decryptApiKeyBlob`, `decryptLink` and `getRotatingKey` from `providers/vidzeeCrypto.js`, plus the `test/fixtures/vidzee-sample.json` fixture — all pinned a scheme VidZee no longer serves.

## [1.0.9] - 2025-11-19

### Removed
- **Showbox/FebBox/PStream provider**: Permanently removed due to PStream API being protected by Cloudflare bot detection, making it inaccessible without complex proxy infrastructure
  - Deleted `providers/Showbox.js` and backup files
  - Removed FebBox cookie management from configuration panel
  - Removed `FEBBOX_COOKIES`, `SHOWBOX_CACHE_DIR`, and related environment variables
  - Cleaned up all Showbox-specific logic from provider registry
  - Removed FebBox/PStream configuration UI panel and related functions
- **Unused dependencies**: Removed 121 packages including puppeteer, patchright, puppeteer-extra, puppeteer-extra-plugin-stealth, and vm2 (~200MB+ saved)
- **Unused utility files**: Removed `cloudflareBypasser.js` and `jsunpack.js`

### Fixed
- **VidZee provider**: Updated to support two-stage AES decryption with dynamic API keys. The provider now fetches an encrypted key from `https://core.vidzee.wtf/api-key`, decrypts it using AES-256-GCM with a hardcoded key, then uses the result to decrypt video URLs with AES-256-CBC. Includes 1-hour API key caching for performance.
- **4khdhub provider**: Added support for `links.modpro.blog` domain (site migrated from `modrefer.in`).
- **moviesmod provider**: Added support for `links.modpro.blog` domain alongside existing `modrefer.in`.
- **uhdmovies provider**: Fixed domain to use `uhdmovies.rip` instead of outdated `uhdmovies.mov`. Added automatic domain replacement for stale scraped URLs. Created new `utils/linkResolver.js` utility to handle driveseed/driveleech download button extraction (supports Instant Download, Resume Cloud, Resume Worker Bot, Direct Links CF Type 1).
- **Provider registry**: Fixed `listProviders()` to return all available providers with their enabled status, not just enabled ones. Config panel now shows all 6 providers correctly.

## [1.0.8] - 2025-10-03

### Added
- Added `processStreamsForProxy` so the aggregate and provider-specific endpoints automatically rewrite stream URLs through the internal `/m3u8-proxy`/`/ts-proxy` layer whenever `enableProxy` is turned on, stripping provider headers safely.

### Changed
- Showbox provider overhaul: filesystem-only caching (Redis removed), smarter FebBox cookie selection with region fallbacks, TMDB title/image validation that recognises romanized names, plus cached HEAD size lookups for faster listings.
- Vixsrc provider rewritten to parse the `window.masterPlaylist` payload (token + expiry), returning a single master playlist with English subtitle lookup and correct Referer headers.
- Config loader now prefers `utils/user-config.json`, dedupes TMDB keys, defaults provider enable flags to `true`, and scrubs legacy proxy env values when mirroring overrides back to `process.env`.
- 4KHDHub provider permanently drops `.zip` archive links instead of trimming extensions and improves host distribution logging.
- Provider registry dynamically enumerates available modules (removing MoviesClub/Xprime remnants) while keeping per-request cookie stats for the admin debug panel.

### Removed
- Deleted legacy `providers/moviesclub.js`, `providers/xprime.js`, and other unused proxy/auth remnants that were no longer referenced.

### Fixed
- Aggregated responses now obey the proxy flag without client changes—streams returned from `/api/streams/...` are proxy-wrapped and omit upstream header hints when `enableProxy` is active.

## [1.0.7] - 2025-09-21

### Added
- VidZee provider: definitive AES-256-CBC decoder (replaced heuristic token attempts). Decodes newly obfuscated `atob(token) => ivBase64:cipherBase64` structure using padded key `qrincywincyspider` and PKCS7.
- Tail segment acceleration: internal tail prefetch map (`tailPrefetchMap`) with TTL cleanup and configurable `tailPrefetchKB` (default 256 KB) now documented and instrumented.

### Changed
- Proxy range negotiation: clarified interaction between `progressiveOpen` and synthetic initial partial (auto-suppression when progressive active). Additional debug logging around tail cache hits and forced host overrides.
- VidZee streams now always return direct decrypted URLs (per-stream `originalToken` retained for debugging when `VIDZEE_DEBUG=1`).
- Updated README version badge to 1.0.7.

### Fixed
- Eliminated edge cases where encoded VidZee tokens were leaking through without decoding.
- Reduced VLC initial loop behavior via tail prefetch serving last-byte probes from cache faster (combined with earlier 1.0.6 range logic).

### Documentation
- README: implicit improvements carried forward (no separate section required) plus badge bump.
- CHANGELOG: recorded AES decoder details & tail prefetch instrumentation.

### Notes
- Future proxy tuning items (size meta map, dynamic progressive growth) tracked but not part of this release.


## [1.0.6] - 2025-09-20

### Removed
- MoviesClub provider (multi-server scraping complexities & Turnstile challenge; deprecated permanently)
- Xprime provider (upstream Xprime.tv offline due to security changes)
 - 4khdhub provider: all `.zip` archive links are now omitted entirely (previous releases experimented with stripping the extension which produced non‑playable pseudo‑MKV links)

### Added
- Structured multi-server debug instrumentation (session summaries, per-fetch metrics, pattern counters)
- Turnstile challenge detection & bypass attempt scaffold (synthetic `/rcp_verify` token posting)
- Optional internal stream proxy (`enableProxy` flag): mounts `/m3u8-proxy`, `/ts-proxy`, `/sub-proxy` with playlist + segment + subtitle handling and segment prefetch cache.
 - Proxy range management features:
   - `clampOpen` (default on) – caps ambiguous open‑ended `bytes=0-` requests to a bounded initial window (`openChunkKB`, default 4096 KB)
   - `progressiveOpen` (default on) – incremental expansion of the head range on successive `bytes=0-` requests instead of a single huge span
   - `initChunkKB` (default 512 KB) – size of the synthetic initial 206 response when neither clamp/progressive produce a range and `noSynth` is not set
   - `tailPrefetch` (default on) + `tailPrefetchKB` (default 256 KB) – asynchronous fetch & in‑memory cache of the file tail to satisfy rapid VLC tail probes
   - `force200` (opt‑in) – normalizes upstream 206 responses to 200 for diagnostics
   - `noSynth` (opt‑in) – disables synthetic initial partial response generation
 - Tail prefetch TTL cleanup task (30 min window) and in‑memory maps for: segment cache, open range clamp, progressive growth, and tail buffers
 - Host routing overrides: `pixeldrain.*` & `video-downloads.googleusercontent.com` are forced through `/ts-proxy` (extensionless or ambiguous content)

### Changed
- Centralized multi-server request headers with realistic `sec-ch-ua*` & `Sec-Fetch-*` values
- Added retry, rotating User-Agent, and cookie jar logic to multi-server fetch pipeline
- Showbox provider priority map updated after Xprime removal
- README/Docs trimmed to reflect current active providers only
- When `enableProxy` is active, stream response objects have their original `headers` field removed (proxy handles all required headers internally).
 - 4khdhub provider now filters out archive endpoints instead of attempting extension normalization (prevents feeding ZIP files to players)
 - Open‑ended range handling improved to reduce VLC negotiation loops by throttling first‑pass read size and growing progressively
 - Synthetic initial partial response is automatically suppressed when `progressiveOpen` is active (real range growth preferred)

### Fixed
- Ensured multi-server fallback attempts (direct rcp player/m3u8 extraction) operate with improved diagnostics
 - Eliminated repeated VLC tail probe stalls caused by archive masquerading as video content (root cause was filtered by dropping `.zip` URLs)

### Documentation
 - Updated README version badge to 1.0.6 and provider list (removed MoviesClub & Xprime, clarified active providers list)
 - Added proxy tuning parameter reference (clamp/progressive/tail prefetch, synthetic partial, force200) and host override notes
 - Expanded explanation that per‑stream headers are stripped when proxying is enabled


## [1.0.5] - 2025-09-19

### Improved
- 4khdhub provider: Permanently block `r2.dev` FSL links (previous optional flag removed).
- Added Referer/Origin headers automatically for FSL Server links during validation (prior to block enforcement ensured proper behavior).
- Tightened URL validation: removed unconditional trust for `r2.dev`; validation logic now consistent across hosts.
- Host distribution instrumentation logs final hostname counts for easier diagnostics.
- Preserved HubCloud worker `.zip` links by stripping the `.zip` extension instead of discarding them (enables direct playback attempts).

### Notes
- `r2.dev` links are always removed from final output; no env flag required.

### Documentation

## [1.0.4] - 2025-09-18

### Added

### Changed
  ```json
  { "title": "…", "url": "…", "quality": "…", "provider": "…", "headers": { } }
  ```

## [1.0.3] - 2025-09-17

### Fixed
- Server now binds to `0.0.0.0` by default so Docker port publishing works correctly from the host. Added `BIND_HOST=0.0.0.0` in Dockerfile and compose.

### Notes
- If you were seeing `ERR_CONNECTION_REFUSED` on `http://localhost:8787`, pull the latest image or rebuild, then re-run with `-p 8787:8787`.

## [1.0.2] - 2025-09-17

### Fixed
- Standardized Docker port to `8787` everywhere (Dockerfile `EXPOSE`, compose `ports`, healthchecks, and README examples). Previous release notes mentioned 8787 but some environments weren't reset; this release ensures consistency.

### Documentation
- Updated README version badge to 1.0.2 and verified Docker commands use `-p 8787:8787`.

## [1.0.1] - 2025-09-17

### Added
- Admin UI: Restart Server button (below Logout) with a themed confirmation modal. The UI polls `/api/health` and auto-reloads when the server is back.
- Sidebar divider under Logout/Restart for clarity.

### Changed
- Exclude Codecs presets:
  - Introduced "None" (default) → `{ "excludeDV": false, "excludeHDR": false }`.
  - "All" → `{ "excludeDV": true, "excludeHDR": true }`.
  - Persist and render presets reliably after Save / Reload.
- Minimum Quality: Clear All now resets to `"all"` and selects the All preset in the UI.
- Clear All: Now fully resets TMDB keys, FebBox cookies, providers, and filters; added a themed confirmation modal with optional "Don't ask again" preference.
- Live Config: Hide legacy `tmdbApiKey` (only show `tmdbApiKeys`).
- Restart behavior:
  - Local dev: Nodemon watches `restart.trigger`; backend writes it before a clean exit to force a restart.
  - Docker: Compose uses `restart: unless-stopped`; Docker restarts the container after restart endpoint triggers exit.
- Dockerfile: Ensure non-root `app` user owns `/app` for writing overrides and restart marker.
- package.json scripts: Simplified to `start`, `start:dev`, and `lint`; both start scripts are nodemon-based and watch `restart.trigger`.

### Fixed
- Provider matrix re-renders immediately after Clear All (no page refresh needed).
- Handling of Exclude Codecs "ALL" previously not persisting correctly.

## [1.0.0] - 2025-09-16
- Initial stable release.

[1.0.8]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.4...v1.0.5
[1.0.3]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.2...v1.0.3
[1.0.4]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.3...v1.0.4
[1.0.2]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Inside4ndroid/TMDB-Embed-API/compare/v1.0.0...v1.0.1

## [1.0.0] - 2025-09-16

### Added
- Comprehensive `README.md` (features, endpoints, admin UI overview, screenshots gallery, Docker usage, troubleshooting).
- `LICENSE` (MIT) file.
- Multi‑TMDB key rotation support (array of keys; random selection per request).
- Config override system writing to `utils/user-config.json` with live merged view.
- Session-based authentication (login, logout, session check, password change) with brute-force mitigation.
- Rate limiting + exponential lockouts for failed login attempts.
- Provider status & metrics endpoints: `/api/health`, `/api/metrics`, `/api/status`, `/api/providers`.
- Stream aggregation endpoints (aggregate + provider-specific) with filtering pipeline.
- Diagnostics instrumentation (intercept `process.exit`, `beforeExit`, unhandled rejection / exception logging, periodic heartbeat interval).
- Docker assets: multi-stage `Dockerfile`, `.dockerignore`, `docker-compose.yml` with persistent volume for overrides.
- GitHub Actions workflow (`.github/workflows/docker-publish.yml`) for automatic multi-arch (amd64+arm64) build & push on branch and tag (`v*`).
- OCI metadata labels and build argument (`VERSION`) in Docker image.
- Version + (placeholder) Docker pulls badges in README header.
- VidSrc extractor refactor: removed direct `process.exit` calls; `main()` now returns status code (safer when required as a module).

### Changed
- Config normalization now clears legacy single `tmdbApiKey` when `tmdbApiKeys` override is explicitly emptied.
- Dockerfile slimmed: narrowed COPY set, added labels, build arg, retained only necessary runtime artifacts.
- `.dockerignore` expanded to reduce build context (`.git`, logs, markdown except README, tests, CI configs, caches, compose file, etc.).

### Removed
- Deprecated `uhdmovies` provider: code file, registry references, UI toggles, documentation mentions.

### Security
- Hardened auth flow: session cookies (HttpOnly), no-store headers for admin pages, escalating lockouts against brute force.

### CI / Automation
- Added multi-arch Docker publish workflow using Buildx & QEMU.

### Documentation
- Added Docker usage section (local build, compose, multi-key usage, env vars table, healthcheck notes).
- Added screenshots gallery of admin UI.
- Updated docs to reflect provider removal and new configuration semantics.
- Added this `CHANGELOG.md`.

### Developer Experience
- Heartbeat diagnostic interval to aid investigation of unexpected exits.
- Intercepted premature `process.exit` calls to avoid silent shutdowns during debugging.

## Historical Context
This 1.0.0 release consolidates modernization work: provider cleanup, configuration clarity, deployment ergonomics (Docker + CI), security hardening, and observability.

---

[1.0.0]: https://github.com/Inside4ndroid/TMDB-Embed-API/releases/v1.0.0
