// 0.34.0 — Direct Easynews search client.
//
// Talks to members.easynews.com's solr-search advanced API with per-user
// HTTP basic auth credentials. Returns normalized candidates including
// enough information to mint a direct-stream URL at play-time.
//
// Protocol (cribbed from Sleeyax/stremio-easynews-addon, MIT licensed):
//   GET https://members.easynews.com/2.0/search/solr-search/advanced
//       ?st=adv&sb=1&fty[]=VIDEO&pno=1&pby=100&safeO=0&gps=<query>...
//   Authorization: Basic base64(user:password)
//
// Response (relevant fields):
//   { dlFarm, dlPort, downURL, data: [<FileData>...] }
//   downURL is "https://members.easynews.com" (sometimes protocol-relative);
//   final URL: <baseURL with user:pass@>/<dlFarm>/<dlPort>/<hash><ext>/<title><ext>
//
// SSS does NOT embed user credentials in the URL returned to Stremio. Instead
// /stream returns a signed deferred URL that resolves at play-click time via
// /resolve/easynews, where SSS injects auth and 302-redirects to the real
// Easynews URL. This keeps Easynews credentials out of /stream responses,
// log buffers, and Stremio client caches.

const fetch = require('node-fetch');
const httpAgent = require('../http-agent');

const BASE_URL = 'https://members.easynews.com';
const SEARCH_PATH = '/2.0/search/solr-search/advanced';

// Default video file extensions Easynews indexes — mirrors the upstream
// addon's filter (drops audio-only and image content from results).
const VIDEO_EXTS = 'm4v,3gp,mov,divx,xvid,wmv,avi,mpg,mpeg,mp4,mkv,avc,flv,webm';

function basicAuthHeader(username, password) {
  const creds = Buffer.from(username + ':' + password, 'utf8').toString('base64');
  return 'Basic ' + creds;
}

// Single search query against the configured Easynews account.
// Returns { ok, error?, results, query, dlFarm?, dlPort?, downURL? }. Never throws.
async function search(query, options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const username = opts.username || '';
  const password = opts.password || '';
  if (!username || !password) {
    log('  easynews: not configured');
    return { ok: false, error: 'not-configured', results: [], query };
  }

  // Easynews's advanced-search params — order doesn't matter; values mirror
  // the upstream addon's defaults so we get the same recall + ranking.
  const params = new URLSearchParams({
    st: 'adv',
    sb: '1',
    fex: VIDEO_EXTS,
    'fty[]': 'VIDEO',
    spamf: '1',
    u: '1',
    gx: '1',
    pno: String(opts.pageNr || 1),
    sS: '3',
    s1: 'dsize', s1d: '-',                  // sort by size desc (biggest first)
    s2: 'relevance', s2d: '-',              // then relevance
    s3: 'dtime', s3d: '-',                  // then date (newest first)
    pby: String(opts.maxResults || 100),
    safeO: '0',
    gps: query,
  });

  const url = BASE_URL + SEARCH_PATH + '?' + params.toString();
  const headers = {
    Authorization: basicAuthHeader(username, password),
    Accept: 'application/json',
  };

  let res;
  try {
    res = await fetch(url, httpAgent.fetchOpts({
      headers,
      timeout: opts.timeoutMs || 20000,
    }, url));
  } catch (err) {
    log('  easynews: network error: ' + err.message);
    return { ok: false, error: 'network: ' + err.message, results: [], query };
  }

  if (res.status === 401 || res.status === 403) {
    log('  easynews: auth failed (HTTP ' + res.status + ') — check creds');
    return { ok: false, error: 'auth-failed', results: [], query };
  }
  if (!res.ok) {
    log('  easynews: HTTP ' + res.status + ' ' + res.statusText);
    return { ok: false, error: 'HTTP ' + res.status, results: [], query };
  }

  let json;
  try { json = await res.json(); }
  catch (err) {
    log('  easynews: bad JSON: ' + err.message);
    return { ok: false, error: 'bad-json', results: [], query };
  }

  const data = Array.isArray(json && json.data) ? json.data : [];
  const candidates = data.map((f) => normalise(f)).filter(Boolean);

  return {
    ok: true,
    results: candidates,
    query,
    dlFarm: json.dlFarm || '',
    dlPort: json.dlPort || 0,
    downURL: json.downURL || '',
  };
}

// Multi-query search across event-aware title variants. Fires
// queries serially with a small delay to avoid hammering Easynews. Dedupes
// across queries by post hash (file['0']).
async function multiSearch(queries, options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const seen = new Set();
  const merged = [];
  // dlFarm/dlPort/downURL are top-level response fields (per-server affinity).
  // First non-empty wins — they're consistent within a session.
  let dlFarm = '', dlPort = 0, downURL = '';

  for (const q of queries) {
    log('  easynews: query "' + q + '"');
    const r = await search(q, Object.assign({}, opts, { log }));
    if (!r.ok) {
      log('    -> ' + (r.error || 'failed'));
      continue;
    }
    log('    -> ' + r.results.length + ' result(s)');
    if (!dlFarm && r.dlFarm) dlFarm = r.dlFarm;
    if (!dlPort && r.dlPort) dlPort = r.dlPort;
    if (!downURL && r.downURL) downURL = r.downURL;
    for (const c of r.results) {
      if (!c.postHash || seen.has(c.postHash)) continue;
      seen.add(c.postHash);
      // Stamp the per-search context onto each candidate so the caller can
      // mint deferred URLs without needing to thread dlFarm/dlPort separately.
      c.dlFarm = r.dlFarm;
      c.dlPort = r.dlPort;
      c.downURL = r.downURL;
      merged.push(c);
    }
    if (queries.length > 1) {
      await new Promise((res2) => setTimeout(res2, opts.queryDelayMs || 800));
    }
  }

  log('  easynews: ' + merged.length + ' unique result(s) across ' + queries.length + ' queries');
  return { results: merged, dlFarm, dlPort, downURL };
}

// Normalize an Easynews FileData object to the SSS candidate shape.
//
// Returns null for password-protected, virus-flagged, non-video, or short
// (<= 5 min) files — these are Easynews's typical "noise" results from thumb
// extraction and stub posts.
function normalise(file) {
  if (!file || typeof file !== 'object') return null;
  if (file.passwd) return null;
  if (file.virus) return null;
  if (String(file.type || '').toUpperCase() !== 'VIDEO') return null;

  const duration = String(file['14'] || '');
  // <= 5 minutes — Easynews indexes thumbnail strips as "video" items that
  // pollute results otherwise (e.g. "1m 30s" entries).
  if (/^\d+s$/.test(duration)) return null;
  if (/^[0-5]m/.test(duration)) return null;

  const postHash = String(file['0'] || '');
  if (!postHash) return null;

  const postTitle = String(file['10'] || '');
  // Prefer the dotted extension (file['11']) — file['2'] is sometimes empty.
  const ext = String(file['11'] || file['2'] || '');

  return {
    title: postTitle,
    postHash,
    postTitle,
    fileExtension: ext,
    size: Number(file.rawSize) || 0,
    sizeLabel: String(file['4'] || ''),
    duration,
    resolution: String(file.fullres || ''),
    publishedAt: file['5'] ? new Date(file['5']).toISOString() : null,
    indexer: 'easynews',
  };
}

// Pack the data needed to reconstruct a playback URL into a base64-url token.
// Stored in the signed deferred URL so /resolve can mint the playback URL
// without re-searching Easynews. Stays compact — typical token is < 200 bytes.
function packPlaybackToken(candidate) {
  if (!candidate || !candidate.postHash) return null;
  const obj = {
    h: candidate.postHash,                    // post hash
    t: candidate.postTitle || '',             // post title
    e: candidate.fileExtension || '',         // extension (.mkv etc.)
    f: candidate.dlFarm || '',                // download farm id
    p: Number(candidate.dlPort) || 0,         // download port
    u: candidate.downURL || '',               // base URL (optional override)
  };
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Reverse of packPlaybackToken — returns null on any parse failure.
function unpackPlaybackToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const obj = JSON.parse(json);
    if (!obj || !obj.h) return null;
    return {
      postHash: String(obj.h || ''),
      postTitle: String(obj.t || ''),
      fileExtension: String(obj.e || ''),
      dlFarm: String(obj.f || ''),
      dlPort: Number(obj.p) || 0,
      downURL: String(obj.u || ''),
    };
  } catch (_) { return null; }
}

// Construct the final playable Easynews URL with HTTP Basic Auth embedded.
// This URL goes ONLY to the user's Stremio client via 302-redirect at
// /resolve time — never into stream rows, the log buffer, or persisted state.
//
// Pattern (per upstream addon): https://user:pass@<host>/<dlFarm>/<dlPort>/<hash><ext>/<title><ext>
function buildPlaybackUrl(decoded, username, password) {
  if (!decoded || !decoded.postHash || !username || !password) return null;

  // downURL is sometimes protocol-relative ("//members.easynews.com") or
  // omitted entirely — normalise both to https://members.easynews.com.
  let base = decoded.downURL || BASE_URL;
  base = base.replace(/^https?:/, '').replace(/^\/\//, '');
  if (!base) base = 'members.easynews.com';

  const auth = encodeURIComponent(username) + ':' + encodeURIComponent(password);
  const farm = decoded.dlFarm || '';
  const port = decoded.dlPort || 0;
  const hash = decoded.postHash;
  const ext = decoded.fileExtension || '';
  const title = decoded.postTitle || hash;

  // Path segments — the URL encoding here matters because post titles often
  // contain spaces and special chars.
  return 'https://' + auth + '@' + base +
    '/' + encodeURIComponent(farm) +
    '/' + port +
    '/' + encodeURIComponent(hash) + ext +
    '/' + encodeURIComponent(title) + ext;
}

// Test creds with a minimal search to /api/info-style endpoint — returns
// { ok, error? } for the account settings panel save-time validation.
async function testCredentials({ username, password, log }) {
  log = log || (() => {});
  if (!username || !password) return { ok: false, error: 'missing-creds' };
  const r = await search('test', {
    username, password,
    maxResults: 1,
    timeoutMs: 10000,
    log: () => {},                            // silence — we surface our own
  });
  if (r.ok) {
    log('easynews: credentials verified');
    return { ok: true };
  }
  if (r.error === 'auth-failed') {
    return { ok: false, error: 'Invalid username or password' };
  }
  return { ok: false, error: r.error || 'unknown' };
}

module.exports = {
  search,
  multiSearch,
  normalise,
  packPlaybackToken,
  unpackPlaybackToken,
  buildPlaybackUrl,
  testCredentials,
};
