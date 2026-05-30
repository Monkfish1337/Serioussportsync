// TorBox REST client. Multi-tenant: each function accepts a `token` argument
// (preferred — per-user via ctx.creds.tb from streams.js) and falls back to
// the env-config TORBOX_API_TOKEN when unset.

const fetch = require('node-fetch');
const config = require('../../config');

const BASE = 'https://api.torbox.app/v1/api';

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// TorBox rate-limits createtorrent aggressively — a burst of cached hits would
// otherwise return HTTP 429 for all of them and drop valid streams. Serialize
// these calls through a single chain with a minimum gap so we never burst.
let _createChain = Promise.resolve();
let _lastCreateAt = 0;
const CREATE_MIN_GAP_MS = 1200;
function scheduleCreate(task) {
  const run = async () => {
    const since = Date.now() - _lastCreateAt;
    if (since < CREATE_MIN_GAP_MS) await delay(CREATE_MIN_GAP_MS - since);
    try { return await task(); }
    finally { _lastCreateAt = Date.now(); }
  };
  _createChain = _createChain.then(run, run);
  return _createChain;
}

function getToken(creds) {
  return (creds && creds.tb) || config.torbox.token || '';
}
function authHeader(token) {
  return { Authorization: 'Bearer ' + (token || config.torbox.token) };
}

async function jsonOrEmpty(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function checkCached(infoHash, token, log) {
  const hash = (infoHash || '').toLowerCase();
  if (!hash) return null;
  const url = BASE + '/torrents/checkcached?hash=' + hash + '&format=object';
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try { res = await fetch(url, { headers: authHeader(token), timeout: 8000 }); }
    catch (err) { log && log('    torbox.checkCached network: ' + err.message); return null; }
    if (res.status === 429) {
      if (attempt === 0) { await delay(1000); continue; }
      log && log('    torbox.checkCached HTTP 429'); return null;
    }
    if (!res.ok) { log && log('    torbox.checkCached HTTP ' + res.status); return null; }
    const j = await jsonOrEmpty(res);
    if (!j || !j.success || !j.data) return null;
    return j.data[hash] || null;
  }
  return null;
}

// Batched, non-destructive cache check (0.23.1). Used by the warmer to mark
// candidates as verified-cached / verified-not-cached in the candidate cache
// without ever creating a torrent on the account. Returns Map&lt;hash, bool&gt;
// keyed by lowercase hash. Hashes that errored or returned malformed responses
// are omitted from the map (caller treats absent as 'unknown').
async function checkCachedBatch(hashes, token, log) {
  const out = new Map();
  const all = (hashes || []).map((h) => String(h || '').toLowerCase().trim()).filter(Boolean);
  if (all.length === 0) return out;
  const BATCH = 100;
  for (let i = 0; i < all.length; i += BATCH) {
    const slice = all.slice(i, i + BATCH);
    const url = BASE + '/torrents/checkcached?hash=' + slice.join(',') + '&format=object';
    let res;
    try { res = await fetch(url, { headers: authHeader(token), timeout: 12000 }); }
    catch (err) { log && log('    torbox.checkCachedBatch network: ' + err.message); continue; }
    if (res.status === 429) {
      log && log('    torbox.checkCachedBatch 429 — sleeping 2s and retrying once');
      await delay(2000);
      try { res = await fetch(url, { headers: authHeader(token), timeout: 12000 }); }
      catch (err) { log && log('    torbox.checkCachedBatch retry network: ' + err.message); continue; }
    }
    if (!res.ok) { log && log('    torbox.checkCachedBatch HTTP ' + res.status); continue; }
    const j = await jsonOrEmpty(res);
    if (!j || !j.success || !j.data) continue;
    // 0.25.1: defensive parse. Only record an explicit verdict per hash —
    // truthy data value → cached, null/explicitly-keyed-but-empty → not cached.
    // A hash MISSING from the response (e.g. TB silently dropped it from a
    // multi-hash query, or the keys are formatted differently) is treated as
    // 'unknown' (out.set never called) so the row builder falls through to
    // optimistic display instead of incorrectly hiding the row.
    // Also normalise the response keys to lowercase since TB has been
    // observed echoing back the requested case.
    const dataLc = {};
    for (const k of Object.keys(j.data)) dataLc[k.toLowerCase()] = j.data[k];
    let cachedN = 0, notN = 0, unknownN = 0;
    for (const h of slice) {
      if (Object.prototype.hasOwnProperty.call(dataLc, h)) {
        const cached = !!dataLc[h];
        out.set(h, cached);
        if (cached) cachedN++; else notN++;
      } else {
        unknownN++;
      }
    }
    if (unknownN === slice.length && slice.length > 1) {
      log && log('    torbox.checkCachedBatch: all ' + slice.length + ' hashes absent from response — '
        + 'multi-hash query may not be supported; check WARMER_TB_TOKEN');
    } else if (unknownN > 0) {
      log && log('    torbox.checkCachedBatch: ' + cachedN + ' cached, ' + notN + ' not, ' + unknownN + ' unknown');
    }
  }
  return out;
}

async function createTorrentOnce(magnet, token, log) {
  const body = new URLSearchParams();
  body.append('magnet', magnet);
  body.append('seed', '1');
  body.append('allow_zip', 'false');
  let res;
  try {
    res = await fetch(BASE + '/torrents/createtorrent', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      timeout: 12000,
    });
  } catch (err) { log && log('    torbox.createTorrent network: ' + err.message); return { err: 'network' }; }
  if (res.status === 429) {
    const ra = parseInt(res.headers.get('retry-after') || '', 10);
    return { err: 429, retryAfterMs: Number.isFinite(ra) ? ra * 1000 : 0 };
  }
  if (!res.ok) { log && log('    torbox.createTorrent HTTP ' + res.status); return { err: res.status }; }
  const j = await jsonOrEmpty(res);
  if (!j || !j.success || !j.data) return { err: 'bad-body' };
  return { data: j.data };
}

// Serialized + 429-aware. All createtorrent calls funnel through scheduleCreate
// so they're spaced out; on 429 we honour Retry-After and retry a few times.
async function createTorrent(magnet, token, log) {
  return scheduleCreate(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await createTorrentOnce(magnet, token, log);
      if (r.data) return r.data;
      if (r.err === 429) {
        // Cap the backoff. TorBox sometimes returns a Retry-After of minutes;
        // honouring that verbatim would freeze a play-click (and the serialized
        // create chain) for that long. Fail fast instead — the user can re-click.
        const MAX_BACKOFF_MS = 15000;
        const wait = Math.min(r.retryAfterMs || (1500 * (attempt + 1)), MAX_BACKOFF_MS);
        log && log('    torbox.createTorrent 429 — backing off ' + wait + 'ms');
        await delay(wait);
        continue;
      }
      return null;
    }
    log && log('    torbox.createTorrent gave up after repeated 429');
    return null;
  });
}

async function torrentInfo(torrentId, token, log) {
  const url = BASE + '/torrents/mylist?id=' + torrentId + '&bypass_cache=true';
  let res;
  try { res = await fetch(url, { headers: authHeader(token), timeout: 8000 }); }
  catch (err) { log && log('    torbox.torrentInfo network: ' + err.message); return null; }
  if (!res.ok) return null;
  const j = await jsonOrEmpty(res);
  return j && j.success ? j.data : null;
}

// 0.26.2: in-memory cache mapping infoHash → torrent_id. TB createTorrent is
// strictly rate-limited (HTTP 429 after a few in quick succession). For
// already-cached hashes, the first call gives us a torrent_id we can reuse for
// every subsequent /resolve of that hash — no need to re-create. Previously
// repeated plays of the same hash hammered createTorrent, got 429'd, and
// caused us to wrongly soft-denylist working playable links. TTL keeps the
// map from growing unbounded; entries auto-evict after 24h.
const torrentIdCache = new Map(); // hash(lc) → { id, ts }
const TORRENT_ID_TTL_MS = 24 * 60 * 60 * 1000;
function getCachedTorrentId(hashLc) {
  const e = torrentIdCache.get(hashLc);
  if (!e) return null;
  if (Date.now() - e.ts > TORRENT_ID_TTL_MS) { torrentIdCache.delete(hashLc); return null; }
  return e.id;
}
function setCachedTorrentId(hashLc, id) {
  torrentIdCache.set(hashLc, { id, ts: Date.now() });
}

async function requestDownload(torrentId, fileId, token, log) {
  const tok = token || config.torbox.token;
  const url = BASE + '/torrents/requestdl?token=' + encodeURIComponent(tok)
    + '&torrent_id=' + torrentId + '&file_id=' + fileId;
  let res;
  try { res = await fetch(url, { timeout: 10000 }); }
  catch (err) { log && log('    torbox.requestDownload network: ' + err.message); return null; }
  if (!res.ok) return null;
  const j = await jsonOrEmpty(res);
  return j && j.success ? j.data : null;
}

async function resolveCached(result, ctx) {
  const log = (ctx && ctx.log) || (() => {});
  const token = getToken(ctx && ctx.creds);
  if (!token) return { ok: false };
  if (!result || !result.infoHash) return { ok: false };

  // Fallback learning (0.23.1): when this resolve path fails, record the hash
  // in the TB denylist with a soft TTL so subsequent /stream requests skip
  // the TB row for it. The warmer-time verification is the primary mechanism;
  // this is the safety net for hashes the warmer hasn't checked (or for which
  // the cached state changed between warm and click).
  const tbDenylist = require('../tb-denylist');
  const softDeny = (why) => {
    try {
      if (tbDenylist.add(result.infoHash, result.title, 'unresolvable')) {
        log('    tb: soft-denylisted ' + result.infoHash + ' (' + why + ')');
      }
    } catch (e) { log('    tb: denylist write failed: ' + e.message); }
  };

  const cached = await checkCached(result.infoHash, token, log);
  if (!cached) { softDeny('checkCached returned not-cached'); return { ok: false }; }

  // 0.26.2: cache torrent_id per hash. First /resolve creates the torrent on
  // TB and remembers the id; subsequent /resolves reuse the id and skip the
  // rate-limited createTorrent call entirely. Fixes the 429-storm + wrong
  // soft-denylist of already-cached hashes.
  const hashLc = String(result.infoHash || '').toLowerCase();
  let torrentId = getCachedTorrentId(hashLc);
  if (!torrentId) {
    const magnet = ctx.buildMagnet(result);
    const created = await createTorrent(magnet, token, log);
    if (!created || !created.torrent_id) { softDeny('createTorrent failed'); return { ok: false }; }
    torrentId = created.torrent_id;
    setCachedTorrentId(hashLc, torrentId);
  } else {
    log('    tb: reusing cached torrent_id ' + torrentId + ' for ' + result.infoHash + ' (skipped createTorrent)');
  }

  let info = await torrentInfo(torrentId, token, log);
  if (!info || !Array.isArray(info.files)) {
    // Stale cached torrent_id (TB removed it, or 24h drift) — invalidate and
    // create fresh. Don't soft-denylist on this path; just retry once.
    if (torrentIdCache.has(hashLc)) {
      log('    tb: cached torrent_id ' + torrentId + ' stale, recreating');
      torrentIdCache.delete(hashLc);
      const magnet = ctx.buildMagnet(result);
      const recreated = await createTorrent(magnet, token, log);
      if (!recreated || !recreated.torrent_id) { softDeny('createTorrent failed (after stale id)'); return { ok: false }; }
      torrentId = recreated.torrent_id;
      setCachedTorrentId(hashLc, torrentId);
      info = await torrentInfo(torrentId, token, log);
    }
    if (!info || !Array.isArray(info.files)) { softDeny('torrentInfo returned no files'); return { ok: false }; }
  }

  const fileObjs = info.files.map((f) => ({
    id: f.id,
    path: f.short_name || f.name,
    bytes: f.size,
  }));
  const file = ctx.pickVideoFile(fileObjs);
  if (!file) { softDeny('no playable video file in torrent'); return { ok: false }; }

  const downloadUrl = await requestDownload(torrentId, file.id, token, log);
  if (!downloadUrl) { softDeny('requestDownload returned no URL'); return { ok: false }; }

  const quality = ctx.qualityFromTitle(result.title);
  const sizeStr = ctx.humanSize(file.bytes);
  return {
    ok: true,
    stream: {
      name: 'TB' + (quality ? ' ' + quality : '') + (sizeStr ? '\n' + sizeStr : ''),
      title: result.title +
        '\n👥 ' + (result.seeders || 0) +
        (sizeStr ? ' | 💾 ' + sizeStr : '') +
        (result.indexer ? '\n[' + result.indexer + ']' : ''),
      url: downloadUrl,
      behaviorHints: {
        bingeGroup: 'sport-tb-cached',
        videoSize: file.bytes || undefined,
        filename: file.path || undefined,
      },
    },
  };
}

// Auto-cache: add the magnet to TorBox so it starts downloading. Fire and
// forget — the next stream request will see it cached.
async function warmCache(result, ctx) {
  const log = (ctx && ctx.log) || (() => {});
  const token = getToken(ctx && ctx.creds);
  if (!token || !result || !result.infoHash) return false;
  const magnet = ctx.buildMagnet(result);
  const created = await createTorrent(magnet, token, log);
  if (created && (created.torrent_id || created.hash)) {
    log('    [TB] warm-add: ' + result.infoHash + ' queued');
    return true;
  }
  return false;
}

module.exports = {
  name: 'TorBox',
  code: 'TB',
  isConfigured: () => !!config.torbox.token,
  isAvailable: (creds) => !!getToken(creds),
  resolveCached,
  warmCache,
  checkCached, checkCachedBatch, createTorrent, torrentInfo, requestDownload,
};
