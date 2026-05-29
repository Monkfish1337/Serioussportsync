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
    // j.data is an object keyed by hash; a present (non-null) value means cached.
    for (const h of slice) {
      out.set(h, !!j.data[h]);
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

  const magnet = ctx.buildMagnet(result);
  const created = await createTorrent(magnet, token, log);
  if (!created || !created.torrent_id) { softDeny('createTorrent failed'); return { ok: false }; }
  const torrentId = created.torrent_id;

  const info = await torrentInfo(torrentId, token, log);
  if (!info || !Array.isArray(info.files)) { softDeny('torrentInfo returned no files'); return { ok: false }; }

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
