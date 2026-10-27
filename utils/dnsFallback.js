// DNS lookup with a DNS-over-HTTPS fallback.
//
// Ad-blocking resolvers (router blocklists, AdGuard Home, Pi-hole, NextDNS…)
// commonly answer NXDOMAIN for TikTok CDN hostnames such as
// `p16-sg.tiktokcdn.com` while the host resolves fine on public DNS. Node then
// fails with `getaddrinfo ENOTFOUND` before it even opens a socket, which is
// what made the `tik` VidZee server look dead.
//
// We keep using the system resolver first, but when it cannot answer we ask
// Google/Cloudflare over HTTPS — HTTPS is the one thing that already works if
// the API can reach VidZee at all — and cache the answer for its TTL.
//
// Set DNS_FALLBACK_DISABLED=1 to use the system resolver only.

const dns = require('dns');
const http = require('http');
const https = require('https');

const DOH_TIMEOUT_MS = 5000;
const CACHE_MIN_TTL_MS = 30 * 1000;
const CACHE_MAX_TTL_MS = 60 * 60 * 1000;

const DOH_ENDPOINTS = [
  'https://dns.google/resolve',
  'https://cloudflare-dns.com/dns-query',
];

// hostname -> { addresses: [{ address, family }], expires }
const cache = new Map();

function cacheGet(hostname, family) {
  const hit = cache.get(hostname);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(hostname);
    return null;
  }
  const addresses = family ? hit.addresses.filter((a) => a.family === family) : hit.addresses;
  return addresses.length ? addresses : null;
}

function cachePut(hostname, addresses) {
  if (!addresses.length) return;
  const ttlMs = Math.min(
    CACHE_MAX_TTL_MS,
    Math.max(CACHE_MIN_TTL_MS, Math.min(...addresses.map((a) => a.ttl || 60)) * 1000),
  );
  cache.set(hostname, { addresses, expires: Date.now() + ttlMs });
}

function systemResolve(hostname, family) {
  const options = { all: true };
  if (family === 4 || family === 6) options.family = family;
  return dns.promises.lookup(hostname, options).then((rows) =>
    rows.map((row) => ({ address: row.address, family: row.family, ttl: 60 })),
  );
}

function dohRequest(endpoint, hostname, type) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(endpoint);
    } catch (e) {
      reject(e);
      return;
    }
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', type);

    const req = https.get(
      url,
      { headers: { accept: 'application/dns-json' }, timeout: DOH_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`DoH HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1024 * 1024) req.destroy(new Error('DoH response too large'));
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            const answer = Array.isArray(data.Answer) ? data.Answer : [];
            const wanted = type === 'A' ? 1 : 28;
            const addresses = answer
              .filter((row) => row.type === wanted && typeof row.data === 'string')
              .map((row) => ({
                address: row.data,
                family: type === 'A' ? 4 : 6,
                ttl: Number(row.TTL) || 60,
              }));
            resolve(addresses);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('DoH timeout')));
    req.on('error', reject);
  });
}

// Always prefer IPv4 when both families are asked for, so a host with a broken
// v6 route does not stall the connection attempt.
async function dohResolve(hostname, family) {
  const types = family === 4 ? ['A'] : family === 6 ? ['AAAA'] : ['A', 'AAAA'];
  let lastError = null;
  for (const type of types) {
    for (const endpoint of DOH_ENDPOINTS) {
      try {
        const addresses = await dohRequest(endpoint, hostname, type);
        if (addresses.length) return addresses;
      } catch (e) {
        lastError = e;
      }
    }
  }
  throw lastError || new Error(`DoH lookup failed for ${hostname}`);
}

async function resolveAddresses(hostname, family = 0) {
  if (process.env.DNS_FALLBACK_DISABLED === '1') {
    return systemResolve(hostname, family);
  }

  const cached = cacheGet(hostname, family);
  if (cached) return cached;

  let systemError = null;
  try {
    const addresses = await systemResolve(hostname, family);
    if (addresses.length) {
      cachePut(hostname, addresses);
      return addresses;
    }
  } catch (e) {
    systemError = e;
  }

  try {
    const addresses = await dohResolve(hostname, family);
    cachePut(hostname, addresses);
    return addresses;
  } catch (e) {
    // Report the original resolver failure when both paths are dead: it is the
    // one that names the host the caller actually asked about.
    throw systemError || e;
  }
}

// Signature-compatible with the `lookup` option of net/http/https agents.
function lookup(hostname, options, callback) {
  let opts = options;
  let cb = callback;
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  opts = opts || {};

  const family = opts.family === 4 || opts.family === 6 ? opts.family : 0;
  resolveAddresses(hostname, family)
    .then((addresses) => {
      if (!addresses.length) {
        const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        err.code = 'ENOTFOUND';
        err.hostname = hostname;
        cb(err);
        return;
      }
      if (opts.all) {
        cb(null, addresses.map(({ address, family: f }) => ({ address, family: f })));
        return;
      }
      cb(null, addresses[0].address, addresses[0].family);
    })
    .catch(cb);
}

// Keep-alive agents with the fallback lookup wired in. Used by axios and
// node-fetch calls so every CDN request can survive a blocking resolver.
const httpAgent = new http.Agent({ keepAlive: true, lookup });
const httpsAgent = new https.Agent({ keepAlive: true, lookup });

function agentFor(targetUrl) {
  try {
    return new URL(String(targetUrl)).protocol === 'http:' ? httpAgent : httpsAgent;
  } catch {
    return httpsAgent;
  }
}

module.exports = {
  lookup,
  resolveAddresses,
  agentFor,
  httpAgent,
  httpsAgent,
  _cache: cache,
};
