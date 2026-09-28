'use strict';

// TorBox Usenet: SSS finds the NZB with the account's own indexer, uploads it
// to the account's TorBox, and playback comes from TorBox's CDN. The server
// only moves NZB files (kilobytes), never video, which is what makes built-in
// Usenet usable on a bandwidth-capped VPS.
//
// Ported from NZB-Sport-Pro (0.3.1), where this was developed and run in
// production. What it learned is kept intact:
// - NZB bytes are uploaded, never the indexer link, so the indexer's API key
//   never reaches TorBox. NZBs live in memory only; video is never proxied.
// - Cache matching uses TorBox's documented strategies: MD5 of each file's
//   first message ID (preferred), of the cleaned and raw NZB, and of the
//   link, but a Newznab link is never query-stripped, because its item id
//   lives in the query and stripping it marks a whole indexer as cached.
// - A shared-cache hit is "attach and wait", not "instant": TorBox's cache
//   endpoint can report a hash that cannot be attached. Only a finished
//   download the account already owns is instant.
// - A timed-out cached attach is recovered from the account's fresh list, and
//   a cached attach that fails falls back to a normal queue.

const crypto = require('crypto');
const fetch = require('node-fetch');
const httpAgent = require('../http-agent');
const { redact } = require('../redact');

const TORBOX_API_BASE = (process.env.TORBOX_API_BASE
  || 'https://api.torbox.app/v1/api').replace(/\/+$/, '');
const VIDEO_EXT_RE = /\.(mkv|mp4|m4v|avi|mov|ts|m2ts|webm|wmv|flv|vob)$/i;
const ID_CACHE = new Map(); // API-key fingerprint + NZB MD5 -> { id, expiresAt }
const ID_TTL_MS = 24 * 60 * 60 * 1000;
const OWNED_HASH_CACHE = new Map(); // API-key fingerprint -> { hashes, expiresAt }
const OWNED_HASH_TTL_MS = 15 * 1000;
const CACHE_HASH_MAX = Math.max(100, Math.min(5000,
  Number(process.env.TORBOX_USENET_CACHE_HASH_MAX || 2000)));

async function testConnection(apiKey, options) {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, status: 0, error: 'missing-key' };
  const opts = options || {};
  const url = TORBOX_API_BASE + '/usenet/mylist?limit=1&bypass_cache=true';
  try {
    const response = await (opts.fetchImpl || fetch)(url, httpAgent.fetchOpts({
      headers: authHeaders(key), timeout: Number(opts.timeoutMs || 7000),
    }, url));
    if (response.ok) return { ok: true, status: response.status };
    return {
      ok: false,
      status: response.status,
      error: response.status === 401 || response.status === 403
        ? 'invalid-key' : (response.status === 429 ? 'rate-limited' : 'http-error'),
    };
  } catch (err) {
    const detail = redact(err && err.message || 'network-error');
    return {
      ok: false,
      status: 0,
      error: /timed?\s*out|timeout/i.test(detail) ? 'timeout' : 'network-error',
    };
  }
}

// The account's TorBox plan (GET /user/me: 0 Free, 1 Essential, 2 Pro,
// 3 Standard). Only Pro includes Usenet downloads; listing Usenet
// downloads works on any plan, so testConnection cannot tell.
const PLAN_NAMES = ['Free', 'Essential', 'Pro', 'Standard'];
async function getPlan(apiKey, options) {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'missing-key' };
  const opts = options || {};
  const url = TORBOX_API_BASE + '/user/me';
  try {
    const response = await (opts.fetchImpl || fetch)(url, httpAgent.fetchOpts({
      headers: authHeaders(key), timeout: Number(opts.timeoutMs || 7000),
    }, url));
    if (!response.ok) return { ok: false, status: response.status, error: 'http-error' };
    const payload = await response.json();
    const plan = Number(payload && payload.data && payload.data.plan);
    if (!Number.isInteger(plan)) return { ok: false, error: 'no-plan' };
    return { ok: true, plan, name: PLAN_NAMES[plan] || ('plan ' + plan), usenet: plan === 2 };
  } catch (err) {
    return { ok: false, error: redact(err && err.message || 'network-error') };
  }
}

function nzbHash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function md5Text(value) {
  return crypto.createHash('md5').update(String(value || ''), 'utf8').digest('hex');
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, '&');
}

// TorBox's preferred Usenet strategy is the MD5 of the first message ID in
// every <file>. These identifiers survive indexer-specific NZB formatting,
// comments, poster attributes, and authenticated download URLs.
function firstMessageIds(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return [];
  const xml = buffer.toString('utf8');
  const ids = [];
  const fileRe = /<file\b[^>]*>([\s\S]*?)<\/file\s*>/gi;
  let fileMatch;
  while ((fileMatch = fileRe.exec(xml)) !== null) {
    const segmentMatch = /<segment\b[^>]*>([\s\S]*?)<\/segment\s*>/i.exec(fileMatch[1]);
    if (!segmentMatch) continue;
    const id = decodeXmlText(segmentMatch[1].replace(/<[^>]+>/g, '')).trim();
    if (id) ids.push(id);
  }
  return Array.from(new Set(ids));
}

function normalizedUsenetLink(value) {
  try {
    const parsed = new URL(String(value || ''));
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().toLowerCase();
  } catch (_) {
    return '';
  }
}

function cleanedNzbBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return Buffer.alloc(0);
  // Best-effort equivalent of TorBox's documented NZB cleanup. Message-ID
  // hashes above are the primary and most stable strategy.
  const xml = buffer.toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+poster\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .trim();
  return Buffer.from(xml, 'utf8');
}

function nzbLinkHashes(value) {
  const link = String(value || '');
  if (!link) return [];
  const hashes = [md5Text(link)];
  const normalized = normalizedUsenetLink(link);
  // TorBox documents a query-stripped alternative hash, but a Newznab link
  // usually identifies the NZB *inside* its query (`t=get&id=...`). Stripping
  // that query collapses every result from an indexer to the same /api hash
  // and creates false cache hits. Only use the normalized strategy when every
  // query field is non-identifying metadata/authentication.
  let safeToNormalize = true;
  try {
    const parsed = new URL(link);
    const nonIdentityKeys = new Set([
      'apikey', 'api_key', 'token', 'auth', 'key', 'passkey',
      'filename', 'file_name', 'name',
    ]);
    for (const key of parsed.searchParams.keys()) {
      if (!nonIdentityKeys.has(String(key).toLowerCase())) {
        safeToNormalize = false;
        break;
      }
    }
  } catch (_) {
    safeToNormalize = false;
  }
  if (normalized && safeToNormalize) hashes.push(md5Text(normalized));
  return Array.from(new Set(hashes));
}

function nzbCacheHashes(buffer, links) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return [];
  const hashes = [];
  const messageIds = firstMessageIds(buffer);
  // Keep one message ID first, then the other core strategies. With 20 rows
  // this guarantees all five fit TorBox's 100-hash batch limit rather than a
  // many-file NZB consuming the entire batch with message IDs alone.
  if (messageIds[0]) hashes.push(md5Text(messageIds[0]));
  const cleaned = cleanedNzbBuffer(buffer);
  if (cleaned.length) hashes.push(nzbHash(cleaned));
  hashes.push(nzbHash(buffer));
  for (const rawLink of (Array.isArray(links) ? links : [links])) {
    hashes.push(...nzbLinkHashes(rawLink));
  }
  // Retain additional per-file message IDs for owned-job matching and for
  // smaller result sets where the shared-cache batch has spare capacity.
  for (const id of messageIds.slice(1)) hashes.push(md5Text(id));
  return Array.from(new Set(hashes));
}

function accountCacheKey(apiKey, hash) {
  const account = crypto.createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 16);
  return account + ':' + hash;
}

function cacheSet(apiKey, hash, id, state) {
  if (id == null) return;
  if (ID_CACHE.size >= 1000) ID_CACHE.delete(ID_CACHE.keys().next().value);
  ID_CACHE.set(accountCacheKey(apiKey, hash), {
    id,
    cached: Boolean(state && state.cached),
    createdAt: Date.now(),
    expiresAt: Date.now() + ID_TTL_MS,
  });
}

function getKnownDownload(apiKey, hash) {
  const key = accountCacheKey(apiKey, hash);
  const entry = ID_CACHE.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) { ID_CACHE.delete(key); return null; }
  return { id: entry.id, cached: entry.cached === true, createdAt: entry.createdAt || 0 };
}

function authHeaders(apiKey, extra) {
  return Object.assign({ Accept: 'application/json', Authorization: 'Bearer ' + apiKey }, extra || {});
}

function extractId(value, depth) {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractId(item, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const preferred = [
    'usenet_id', 'usenetId', 'usenetdownload_id', 'usenetDownloadId',
    'download_id', 'downloadId', 'id',
  ];
  for (const key of preferred) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = extractId(value[key], depth + 1);
      if (found != null) return found;
    }
  }
  if (value.data !== undefined) return extractId(value.data, depth + 1);
  return null;
}

function cachedFromPayload(payload, hash) {
  const data = payload && payload.data !== undefined ? payload.data : payload;
  if (!data) return false;
  if (Array.isArray(data)) {
    return data.some((item) => {
      if (typeof item === 'string') return item.toLowerCase() === hash;
      return String(item && (item.hash || item.md5 || '')).toLowerCase() === hash;
    });
  }
  if (typeof data === 'object') {
    const matchingKey = Object.keys(data).find((key) => key.toLowerCase() === hash);
    if (matchingKey) return data[matchingKey] !== false && data[matchingKey] != null;
    return String(data.hash || data.md5 || '').toLowerCase() === hash;
  }
  return false;
}

function cachedHashesFromPayload(payload, hashes) {
  const wanted = Array.from(new Set((hashes || [])
    .map((hash) => String(hash || '').toLowerCase())
    .filter((hash) => /^[a-f0-9]{32}$/.test(hash))));
  return new Set(wanted.filter((hash) => cachedFromPayload(payload, hash)));
}

async function checkCachedMany(hashes, apiKey, log, options) {
  log = log || (() => {});
  const opts = options || {};
  const maxHashes = Math.max(100, Math.min(5000,
    Number(opts.maxHashes || CACHE_HASH_MAX)));
  const wanted = Array.from(new Set((hashes || [])
    .map((hash) => String(hash || '').toLowerCase())
    .filter((hash) => /^[a-f0-9]{32}$/.test(hash)))).slice(0, maxHashes);
  if (!wanted.length || !apiKey) return new Set();
  const url = TORBOX_API_BASE + '/usenet/checkcached?format=object&list_files=false';
  try {
    const response = await (opts.fetchImpl || fetch)(url, httpAgent.fetchOpts({
      method: 'POST',
      headers: authHeaders(apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ hashes: wanted }),
      timeout: Number(opts.timeoutMs || 5000),
    }, url));
    if (!response.ok) {
      log('  torbox-usenet: batch checkcached HTTP ' + response.status);
      return new Set();
    }
    return cachedHashesFromPayload(await response.json(), wanted);
  } catch (err) {
    log('  torbox-usenet: batch checkcached ' + redact(err.message));
    return new Set();
  }
}

async function checkCached(hash, apiKey, log, options) {
  const normalized = String(hash || '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized) || !apiKey) return false;
  return (await checkCachedMany([normalized], apiKey, log, options)).has(normalized);
}

function multipartNzb(buffer, filename, fields) {
  const boundary = '----sss-' + crypto.randomBytes(16).toString('hex');
  const safeName = String(filename || 'serioussportsync.nzb')
    .replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'serioussportsync.nzb';
  const chunks = [];
  for (const [name, rawValue] of Object.entries(fields || {})) {
    if (rawValue === undefined || rawValue === null) continue;
    const safeField = String(name).replace(/[^A-Za-z0-9_-]+/g, '');
    if (!safeField) continue;
    chunks.push(Buffer.from('--' + boundary + '\r\n'
      + 'Content-Disposition: form-data; name="' + safeField + '"\r\n\r\n'
      + String(rawValue) + '\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '\r\n'
    + 'Content-Disposition: form-data; name="file"; filename="' + safeName + '"\r\n'
    + 'Content-Type: application/x-nzb\r\n\r\n'));
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
  const body = Buffer.concat([...chunks, buffer, tail]);
  return { boundary, body };
}

async function createDownload(buffer, title, apiKey, log, options) {
  log = log || (() => {});
  if (!Buffer.isBuffer(buffer) || !buffer.length || !apiKey) return null;
  const opts = options || {};
  const upload = multipartNzb(buffer, (title || 'serioussportsync') + '.nzb', {
    add_only_if_cached: opts.cachedOnly ? 'true' : undefined,
  });
  const url = TORBOX_API_BASE + '/usenet/createusenetdownload';
  const timeoutMs = Math.max(5000, Number(opts.createTimeoutMs
    || process.env.TORBOX_USENET_CREATE_TIMEOUT_MS || 20000));
  if (opts.cachedOnly) {
    log('  torbox-usenet: attaching cached NZB (' + Math.ceil(upload.body.length / 1024) + ' KiB)');
  }
  let response;
  try {
    response = await (opts.fetchImpl || fetch)(url, httpAgent.fetchOpts({
      method: 'POST',
      headers: authHeaders(apiKey, {
        'Content-Type': 'multipart/form-data; boundary=' + upload.boundary,
        'Content-Length': String(upload.body.length),
      }),
      body: upload.body,
      timeout: timeoutMs,
    }, url));
  } catch (err) {
    log('  torbox-usenet: create ' + redact(err.message));
    return null;
  }
  let payload = null;
  try { payload = await response.json(); } catch (_) { /* status is enough */ }
  if (!response.ok && !(payload && payload.data)) {
    const detail = payload && (payload.detail || payload.error || payload.message);
    log('  torbox-usenet: create HTTP ' + response.status + (detail ? ' ' + redact(detail) : ''));
    return null;
  }
  return extractId(payload, 0);
}

function normalizeJob(payload, wantedId) {
  let data = payload && payload.data !== undefined ? payload.data : payload;
  if (Array.isArray(data)) {
    data = data.find((item) => String(item && item.id) === String(wantedId)) || data[0] || null;
  }
  return data && typeof data === 'object' ? data : null;
}

function ownedHashesFromPayload(payload, readyOnly) {
  const data = payload && payload.data !== undefined ? payload.data : payload;
  const jobs = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
  const hashes = new Map();
  for (const job of jobs) {
    if (!job || typeof job !== 'object' || job.id == null) continue;
    const state = String(job.download_state || job.state || '').toLowerCase();
    const ready = job.download_finished === true
      || (job.cached === true && job.download_present === true)
      || /^(completed|finished|ready|downloaded)$/.test(state);
    if ((readyOnly && !ready) || job.download_present === false) continue;
    const values = [job.hash].concat(Array.isArray(job.alternative_hashes) ? job.alternative_hashes : []);
    for (const value of values) {
      const hash = String(value || '').toLowerCase();
      if (/^[a-f0-9]{32}$/.test(hash) && !hashes.has(hash)) hashes.set(hash, job.id);
    }
  }
  return hashes;
}

function ownedReadyHashesFromPayload(payload) {
  return ownedHashesFromPayload(payload, true);
}

function ownedJobHashesFromPayload(payload) {
  return ownedHashesFromPayload(payload, false);
}

async function getOwnedReadyHashes(apiKey, log, options) {
  log = log || (() => {});
  if (!apiKey) return new Map();
  const opts = options || {};
  const account = crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
  const cached = OWNED_HASH_CACHE.get(account);
  if (!opts.forceRefresh && cached && cached.expiresAt > Date.now()) return new Map(cached.hashes);
  const params = new URLSearchParams({ limit: '1000' });
  if (opts.forceRefresh) params.set('bypass_cache', 'true');
  const url = TORBOX_API_BASE + '/usenet/mylist?' + params.toString();
  try {
    const response = await (opts.fetchImpl || fetch)(url, httpAgent.fetchOpts({
      headers: authHeaders(apiKey), timeout: Number(opts.timeoutMs || 6000),
    }, url));
    if (!response.ok) {
      log('  torbox-usenet: owned mylist HTTP ' + response.status);
      return new Map();
    }
    const hashes = ownedReadyHashesFromPayload(await response.json());
    if (OWNED_HASH_CACHE.size >= 1000) OWNED_HASH_CACHE.delete(OWNED_HASH_CACHE.keys().next().value);
    OWNED_HASH_CACHE.set(account, { hashes: new Map(hashes), expiresAt: Date.now() + OWNED_HASH_TTL_MS });
    return hashes;
  } catch (err) {
    log('  torbox-usenet: owned mylist ' + redact(err.message));
    return new Map();
  }
}

async function getOwnedJobHashes(apiKey, log, options) {
  log = log || (() => {});
  if (!apiKey) return new Map();
  const opts = options || {};
  const url = TORBOX_API_BASE + '/usenet/mylist?limit=1000&bypass_cache=true';
  try {
    const response = await (opts.fetchImpl || fetch)(url, httpAgent.fetchOpts({
      headers: authHeaders(apiKey), timeout: Number(opts.timeoutMs || 6000),
    }, url));
    if (!response.ok) return new Map();
    return ownedJobHashesFromPayload(await response.json());
  } catch (err) {
    log('  torbox-usenet: job recovery mylist ' + redact(err.message));
    return new Map();
  }
}

async function getJob(id, apiKey, log, options) {
  log = log || (() => {});
  if (id == null || !apiKey) return null;
  const params = new URLSearchParams({ id: String(id), bypass_cache: 'true' });
  const url = TORBOX_API_BASE + '/usenet/mylist?' + params.toString();
  try {
    const response = await ((options && options.fetchImpl) || fetch)(url, httpAgent.fetchOpts({
      headers: authHeaders(apiKey), timeout: Number((options && options.jobTimeoutMs) || 6000),
    }, url));
    if (!response.ok) { log('  torbox-usenet: mylist HTTP ' + response.status); return null; }
    return normalizeJob(await response.json(), id);
  } catch (err) {
    log('  torbox-usenet: mylist ' + redact(err.message));
    return null;
  }
}

function jobFiles(job) {
  if (!job || typeof job !== 'object') return [];
  if (Array.isArray(job.files)) return job.files;
  if (job.download && Array.isArray(job.download.files)) return job.download.files;
  return [];
}

function jobFailure(job) {
  if (!job || typeof job !== 'object') return null;
  const state = String(job.download_state || job.state || '').trim();
  if (!/(?:fail|error|expir|missing|abort|corrupt)/i.test(state)) return null;
  const nested = job.download && typeof job.download === 'object' ? job.download : {};
  const rawDetail = job.error_message || job.error_reason || job.failure_reason
    || job.reason || job.error || job.detail || job.message
    || nested.error_message || nested.error_reason || nested.failure_reason
    || nested.reason || nested.error || nested.detail || nested.message || '';
  const detail = String(rawDetail || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
  return { state: state || 'failed', detail };
}

function pickPlayableFileId(files) {
  const candidates = (Array.isArray(files) ? files : []).map((file) => ({
    id: file && (file.id != null ? file.id : file.file_id),
    name: String(file && (file.name || file.short_name || file.filename) || ''),
    size: Number(file && (file.size || file.bytes) || 0) || 0,
    mimetype: String(file && (file.mimetype || file.mime_type) || ''),
  })).filter((file) => file.id != null);
  const byExt = candidates.filter((file) => VIDEO_EXT_RE.test(file.name));
  const byMime = candidates.filter((file) => /^video\//i.test(file.mimetype));
  const pool = byExt.length ? byExt : (byMime.length ? byMime : candidates);
  pool.sort((a, b) => b.size - a.size);
  return pool[0] ? pool[0].id : null;
}

async function requestDl(usenetId, fileId, apiKey, log, options) {
  log = log || (() => {});
  if (usenetId == null || fileId == null || !apiKey) return null;
  const params = new URLSearchParams({
    token: apiKey,
    usenet_id: String(usenetId),
    file_id: String(fileId),
    zip_link: 'false',
  });
  const url = TORBOX_API_BASE + '/usenet/requestdl?' + params.toString();
  try {
    const response = await ((options && options.fetchImpl) || fetch)(url, httpAgent.fetchOpts({
      headers: authHeaders(apiKey), timeout: 12000,
    }, url));
    if (!response.ok) { log('  torbox-usenet: requestdl HTTP ' + response.status); return null; }
    const payload = await response.json();
    if (payload && typeof payload.data === 'string') return payload.data;
    if (payload && payload.data && typeof payload.data.url === 'string') return payload.data.url;
    if (payload && typeof payload.url === 'string') return payload.url;
    return null;
  } catch (err) {
    log('  torbox-usenet: requestdl ' + redact(err.message));
    return null;
  }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function findPlayable(id, apiKey, log, options) {
  const opts = options || {};
  const maxWaitMs = Math.max(0, Math.min(45000, Number(opts.maxWaitMs || 0)));
  const intervalMs = Math.max(0, Number(opts.pollIntervalMs || 1200));
  const defaultAttempts = maxWaitMs > 0
    ? Math.ceil(maxWaitMs / Math.max(1, intervalMs || 250)) + 1
    : 3;
  const attempts = Math.max(1, Math.min(200, Number(opts.pollAttempts || defaultAttempts)));
  const deadline = Date.now() + maxWaitMs;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const job = await getJob(id, apiKey, log, opts);
    const failure = jobFailure(job);
    if (failure) return { error: 'torbox-job-failed', state: failure.state, detail: failure.detail };
    const fileId = pickPlayableFileId(jobFiles(job));
    if (fileId != null) {
      const url = await requestDl(id, fileId, apiKey, log, opts);
      if (url) return { url };
    }
    if (attempt + 1 >= attempts || maxWaitMs === 0 || Date.now() >= deadline) break;
    if (intervalMs) await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return {};
}

async function resolveNzb(buffer, title, apiKey, log, options) {
  log = log || (() => {});
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, error: 'empty-nzb' };
  if (!apiKey) return { ok: false, error: 'no-torbox-key' };
  const opts = options || {};
  const hash = nzbHash(buffer);
  const cacheHashes = nzbCacheHashes(buffer, opts.nzbUrl);
  const knownId = /^\d+$/.test(String(opts.knownId == null ? '' : opts.knownId))
    ? Number(opts.knownId) : null;
  let cached = knownId != null && opts.knownReady === true ? true : (typeof opts.knownCached === 'boolean'
    ? opts.knownCached
    : (await checkCachedMany(cacheHashes, apiKey, log, opts)).size > 0);
  const remembered = getKnownDownload(apiKey, hash);
  let id = knownId != null ? knownId : (remembered && remembered.id);
  const alreadyProcessing = knownId != null ? opts.knownReady !== true : Boolean(remembered);
  if (id == null) {
    id = await createDownload(buffer, title, apiKey, log,
      Object.assign({}, opts, { cachedOnly: cached }));
    if (id != null) cacheSet(apiKey, hash, id, { cached });
  }
  // A TorBox create request can finish server-side after the HTTP client times
  // out. Recover the newly attached cached job from the user's fresh list so
  // the same click can still redirect to playback instead of ending at 404.
  if (id == null && cached) {
    const attempts = Math.max(1, Math.min(3, Number(opts.recoveryAttempts || 2)));
    for (let attempt = 0; attempt < attempts && id == null; attempt += 1) {
      if (attempt > 0) await delay(Math.max(0, Number(opts.recoveryIntervalMs || 1000)));
      const owned = await getOwnedJobHashes(apiKey, log, Object.assign({}, opts, {
        timeoutMs: Number(opts.recoveryTimeoutMs || 6000),
      }));
      const matchedHash = cacheHashes.find((candidateHash) => owned.has(candidateHash));
      if (matchedHash) id = owned.get(matchedHash);
    }
    if (id != null) {
      cacheSet(apiKey, hash, id, { cached: true });
      log('  torbox-usenet: recovered cached attachment from user list');
    }
  }
  // TorBox's shared cache endpoint can report a hash before an NZB can be
  // attached to the user's library. A deliberate click authorises a normal
  // queue fallback, preventing a false-positive cache badge from dead-ending.
  if (id == null && cached) {
    log('  torbox-usenet: cached attach unavailable; falling back to queue');
    cached = false;
    id = await createDownload(buffer, title, apiKey, log,
      Object.assign({}, opts, { cachedOnly: false }));
    if (id != null) cacheSet(apiKey, hash, id, { cached: false });
  }
  if (id == null) return { ok: false, error: cached ? 'cached-create-failed' : 'create-failed' };
  const waitMs = Math.max(0, Math.min(45000, Number(opts.waitMs !== undefined
    ? opts.waitMs : (process.env.TORBOX_USENET_PLAY_WAIT_MS || 35000))));
  const playable = await findPlayable(id, apiKey, log, Object.assign({}, opts, {
    maxWaitMs: waitMs,
  }));
  if (playable.url) return { ok: true, url: playable.url, cached: true, id, hash };
  if (playable.error === 'torbox-job-failed') {
    const state = playable.state || 'failed';
    const detail = playable.detail || '';
    const release = String(title || 'unknown release').replace(/[\r\n\t]+/g, ' ').slice(0, 300);
    const message = 'TorBox Usenet job ' + id + ' failed for "' + release + '" — '
      + state + (detail && detail.toLowerCase() !== state.toLowerCase() ? ': ' + detail : '');
    (typeof opts.errorLog === 'function' ? opts.errorLog : log)(redact(message));
    return { ok: false, error: 'torbox-job-failed', state, detail, id, hash };
  }
  return {
    ok: true,
    queued: true,
    processing: alreadyProcessing,
    cached,
    id,
    hash,
    retryAfter: Math.max(5, Math.ceil(waitMs / 1000)),
  };
}

module.exports = {
  TORBOX_API_BASE,
  CACHE_HASH_MAX,
  testConnection,
  getPlan,
  nzbHash,
  firstMessageIds,
  normalizedUsenetLink,
  cleanedNzbBuffer,
  nzbLinkHashes,
  nzbCacheHashes,
  cachedFromPayload,
  cachedHashesFromPayload,
  multipartNzb,
  extractId,
  checkCached,
  checkCachedMany,
  createDownload,
  normalizeJob,
  ownedReadyHashesFromPayload,
  ownedJobHashesFromPayload,
  getOwnedReadyHashes,
  getOwnedJobHashes,
  getKnownDownload,
  getJob,
  jobFailure,
  pickPlayableFileId,
  requestDl,
  findPlayable,
  resolveNzb,
  _test: { ID_CACHE, OWNED_HASH_CACHE, jobFiles, accountCacheKey },
};
