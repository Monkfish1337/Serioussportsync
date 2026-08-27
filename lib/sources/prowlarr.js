// Direct Prowlarr search client (optional alternative to the companion scraper).
// Uses the unified /api/v1/search endpoint, which fans out across every
// indexer Prowlarr has configured. Many results return infoHash=null and
// the hash is only reachable by following Prowlarr's /download proxy
// redirect, which typically 301s to a magnet: URL. We hydrate those in
// a bounded-concurrency second pass.

const fetch = require('node-fetch');
const crypto = require('crypto');
const settings = require('../settings');
const httpAgent = require('../http-agent');
const boundedBody = require('../bounded-body');
const security = require('../security');

const MAX_SEARCH_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TORRENT_BYTES = 4 * 1024 * 1024;

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function search(query, options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const pw = settings.getProwlarr();
  if (!pw.url || !pw.apiKey) { log('  prowlarr: URL/API key not configured'); return []; }

  const params = new URLSearchParams({
    query, type: 'search', limit: String(opts.limit || 100),
  });

  const url = pw.url.replace(/\/$/, '') + '/api/v1/search?' + params.toString();

  let res;
  try {
    res = await fetch(url, httpAgent.fetchOpts({
      headers: { 'X-Api-Key': pw.apiKey, Accept: 'application/json' },
      timeout: 15000,
    }, url));
  } catch (err) { log('  prowlarr: network error: ' + err.message); return []; }
  if (!res.ok) { log('  prowlarr: HTTP ' + res.status + ' ' + res.statusText); return []; }
  let body;
  try { body = await boundedBody.readJson(res, MAX_SEARCH_RESPONSE_BYTES, 'Prowlarr search response'); }
  catch (err) { log('  prowlarr: invalid response: ' + err.message); return []; }
  if (!Array.isArray(body)) return [];
  return body;
}

// Base32 (RFC 4648) -> bytes. Some trackers encode the 20-byte btih as
// 32 chars of base32 instead of 40 hex chars.
function base32ToBytes(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = s.toUpperCase().replace(/=+$/, '');
  const out = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return null;
    buf = (buf << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return out;
}

// Recover infoHash from any synchronously-available field.
function extractInfoHash(result) {
  if (result.infoHash && /^[a-f0-9]{40}$/i.test(result.infoHash)) {
    return result.infoHash.toLowerCase();
  }
  const candidates = [result.magnetUrl, result.downloadUrl, result.guid, result.infoUrl];
  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue;
    const m = c.match(/urn:btih:([A-Fa-f0-9]{40}|[A-Z2-7]{32})/i);
    if (m) {
      const h = m[1];
      if (/^[a-f0-9]{40}$/i.test(h)) return h.toLowerCase();
      try {
        const bin = base32ToBytes(h);
        if (bin && bin.length === 20) {
          return Array.from(bin).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        }
      } catch (_) { /* fall through */ }
    }
    const m2 = c.match(/\b([A-Fa-f0-9]{40})\b/);
    if (m2) return m2[1].toLowerCase();
  }
  return '';
}

function skipBencodeValue(buf, start) {
  const marker = buf[start];
  if (marker === 0x69) { // integer: i123e
    const end = buf.indexOf(0x65, start + 1);
    return end < 0 ? -1 : end + 1;
  }
  if (marker === 0x6c || marker === 0x64) { // list/dictionary
    let pos = start + 1;
    while (pos < buf.length && buf[pos] !== 0x65) {
      pos = skipBencodeValue(buf, pos);
      if (pos < 0) return -1;
      if (marker === 0x64) {
        pos = skipBencodeValue(buf, pos);
        if (pos < 0) return -1;
      }
    }
    return pos < buf.length ? pos + 1 : -1;
  }
  if (marker >= 0x30 && marker <= 0x39) { // byte string: 4:name
    const colon = buf.indexOf(0x3a, start);
    if (colon < 0) return -1;
    const len = parseInt(buf.slice(start, colon).toString('ascii'), 10);
    if (!Number.isFinite(len) || len < 0) return -1;
    const end = colon + 1 + len;
    return end <= buf.length ? end : -1;
  }
  return -1;
}

// Compute the BitTorrent v1 info hash from the exact bencoded `info` value.
// Prowlarr often returns a .torrent body instead of a magnet redirect.
function extractTorrentInfoHash(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  if (buf.length < 2 || buf[0] !== 0x64) return '';
  let pos = 1;
  while (pos < buf.length && buf[pos] !== 0x65) {
    const keyStart = pos;
    const keyEnd = skipBencodeValue(buf, keyStart);
    if (keyEnd < 0) return '';
    const colon = buf.indexOf(0x3a, keyStart);
    if (colon < 0 || colon >= keyEnd) return '';
    const key = buf.slice(colon + 1, keyEnd).toString('utf8');
    const valueStart = keyEnd;
    const valueEnd = skipBencodeValue(buf, valueStart);
    if (valueEnd < 0) return '';
    if (key === 'info') {
      return crypto.createHash('sha1').update(buf.slice(valueStart, valueEnd)).digest('hex');
    }
    pos = valueEnd;
  }
  return '';
}

function absoluteDownloadUrl(value, base) {
  try {
    return security.cleanHttpUrl(new URL(String(value || ''), String(base || '')).toString(), {
      label: 'Prowlarr download URL', allowEmpty: false,
    });
  }
  catch (_) { return ''; }
}

function hashFromMagnet(value) {
  const match = String(value || '').match(/urn:btih:([A-Fa-f0-9]{40}|[A-Z2-7]{32})/i);
  if (!match) return '';
  const token = match[1];
  if (/^[a-f0-9]{40}$/i.test(token)) return token.toLowerCase();
  const bytes = base32ToBytes(token);
  return bytes && bytes.length === 20
    ? Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
    : '';
}

// Async hydration: authenticate the Prowlarr proxy request, accept magnet
// redirects, safely follow HTTP redirects without leaking the API key to a
// third-party host, and hash ordinary .torrent response bodies.
async function hydrateHashViaDownloadProxy(result, log) {
  if (!result.downloadUrl || typeof result.downloadUrl !== 'string') return null;
  const pw = settings.getProwlarr();
  const prowlarrBase = String(pw.url || '').replace(/\/$/, '') + '/';
  let current = absoluteDownloadUrl(result.downloadUrl, prowlarrBase);
  if (!current) return null;
  let prowlarrHost = '';
  try { prowlarrHost = new URL(prowlarrBase).host; } catch (_) {}

  for (let hop = 0; hop < 4; hop++) {
    let res;
    try {
      const currentHost = new URL(current).host;
      const headers = currentHost === prowlarrHost && pw.apiKey
        ? { 'X-Api-Key': pw.apiKey, Accept: 'application/x-bittorrent,*/*' }
        : { Accept: 'application/x-bittorrent,*/*' };
      res = await fetch(current, httpAgent.fetchOpts({
        headers, redirect: 'manual', timeout: 10000, method: 'GET',
      }, current));
    } catch (err) {
      if (log) log('    hydrate fail (' + (result.indexer || '?') + '): ' + err.message);
      return { error: true };
    }

    const loc = res.headers.get('location') || '';
    if (loc) {
      const magnetHash = hashFromMagnet(loc);
      if (magnetHash) return { hash: magnetHash, magnetUrl: loc };
      current = absoluteDownloadUrl(loc, current);
      if (!current) return null;
      continue;
    }
    if (res.ok) {
      const body = await boundedBody.readBuffer(res, MAX_TORRENT_BYTES, 'Prowlarr torrent response');
      const torrentHash = extractTorrentInfoHash(body);
      if (torrentHash) return { hash: torrentHash, magnetUrl: null };
    }
    if (log) log('    hydrate no hash (' + (result.indexer || '?') + '): HTTP ' + res.status);
    return null;
  }
  return null;
}

async function hydrateAll(results, log, concurrency) {
  // Only hydrate results that (a) lack a sync-extractable hash, (b) have
  // a downloadUrl we can fetch, and (c) have at least one seeder (dead
  // torrents aren't worth the round-trip). Cap to top HYDRATE_MAX by
  // seeders. The cap is generous because a result whose indexer has already
  // failed once this batch is skipped instantly (see failedIndexers below),
  // so one dead indexer (e.g. a CF-blocked tracker whose download
  // proxy always times out) can't crowd out hydratable results from others.
  const HYDRATE_MAX = 25;
  const needs = results
    .filter((r) => !r._hash && r.downloadUrl && (r.seeders || 0) > 0)
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
    .slice(0, HYDRATE_MAX);
  if (needs.length === 0) return 0;
  if (log) log('  prowlarr: hydrating up to ' + needs.length + ' by seeders');
  const failedIndexers = new Set();
  let i = 0, hydrated = 0, skipped = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= needs.length) return;
      const r = needs[idx];
      // Skip indexers already shown to be dead this batch — instant, frees the
      // worker to try a result from a working indexer instead.
      if (r.indexer && failedIndexers.has(r.indexer)) { skipped++; continue; }
      const got = await hydrateHashViaDownloadProxy(r, log);
      if (got && got.hash) { r._hash = got.hash; r._magnet = got.magnetUrl; hydrated++; }
      else if (got && got.error && r.indexer) failedIndexers.add(r.indexer);
    }
  }
  const N = Math.max(1, Math.min(concurrency || 2, needs.length));
  await Promise.all(Array.from({ length: N }, worker));
  if (log && (skipped > 0 || failedIndexers.size > 0)) {
    log('  prowlarr: skipped ' + skipped + ' result(s) from dead indexer(s): '
      + (Array.from(failedIndexers).join(', ') || 'none'));
  }
  return hydrated;
}

async function multiSearch(queries, options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const seen = new Set();
  const out = [];
  const collected = [];

  for (const q of queries) {
    log('  prowlarr: query "' + q + '"');
    const results = await search(q, { log });
    log('    -> ' + results.length + ' raw results');
    for (const r of results) {
      r._hash = extractInfoHash(r);
      collected.push(r);
    }
    if (queries.length > 1) await delay(150);
  }

  const hydrated = await hydrateAll(collected, log, 4);
  let dropped = 0;
  for (const r of collected) {
    const hash = r._hash;
    if (!hash) { dropped++; continue; }
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({
      title: r.title || '',
      infoHash: hash,
      size: r.size || 0,
      seeders: r.seeders || 0,
      leechers: r.leechers || 0,
      magnetUrl: r.magnetUrl || r._magnet || null,
      indexer: r.indexer || null,
      publishDate: r.publishDate || null,
    });
  }
  if (hydrated > 0) log('  prowlarr: hydrated ' + hydrated + ' result(s) via download proxy');
  if (dropped > 0) log('  prowlarr: dropped ' + dropped + ' result(s) with no recoverable hash');
  return out;
}
module.exports = {
  search,
  multiSearch,
  extractInfoHash,
  extractTorrentInfoHash,
  absoluteDownloadUrl,
};
