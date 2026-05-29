// Premiumize REST client. Multi-tenant: each call accepts an apiKey
// (preferred — per-user via ctx.creds.pm) or falls back to env config.

const fetch = require('node-fetch');
const config = require('../../config');

const BASE = 'https://www.premiumize.me/api';

function getKey(creds) {
  return (creds && creds.pm) || config.premiumize.apiKey || '';
}

async function jsonOrEmpty(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function directDl(magnet, apiKey, log) {
  const key = apiKey || config.premiumize.apiKey;
  const body = 'apikey=' + encodeURIComponent(key) + '&src=' + encodeURIComponent(magnet);
  let res;
  try {
    res = await fetch(BASE + '/transfer/directdl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeout: 12000,
    });
  } catch (err) {
    log && log('    premiumize.directDl network: ' + err.message);
    return null;
  }
  if (!res.ok) {
    log && log('    premiumize.directDl HTTP ' + res.status);
    return null;
  }
  const j = await jsonOrEmpty(res);
  if (!j || j.status !== 'success') return null;
  return j;
}

// Batched, non-destructive cache check (0.23.1). Used by the warmer to mark
// candidates as verified-cached / verified-not-cached in the candidate cache
// without ever calling directDl. Returns Map&lt;hash, bool&gt; keyed by lowercase
// hash. Hashes that errored or returned malformed responses are omitted.
async function cacheCheck(hashes, apiKey, log) {
  const out = new Map();
  const key = apiKey || config.premiumize.apiKey;
  const all = (hashes || []).map((h) => String(h || '').toLowerCase().trim()).filter(Boolean);
  if (!key || all.length === 0) return out;
  const BATCH = 100;
  for (let i = 0; i < all.length; i += BATCH) {
    const slice = all.slice(i, i + BATCH);
    const body = 'apikey=' + encodeURIComponent(key)
      + '&' + slice.map((h) => 'items%5B%5D=' + encodeURIComponent(h)).join('&');
    let res;
    try {
      res = await fetch(BASE + '/cache/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        timeout: 12000,
      });
    } catch (err) { log && log('    premiumize.cacheCheck network: ' + err.message); continue; }
    if (!res.ok) { log && log('    premiumize.cacheCheck HTTP ' + res.status); continue; }
    const j = await jsonOrEmpty(res);
    if (!j || j.status !== 'success' || !Array.isArray(j.response)) continue;
    // j.response is a boolean array parallel to slice (the items[] we sent).
    for (let k = 0; k < slice.length; k++) {
      out.set(slice[k], !!j.response[k]);
    }
  }
  return out;
}

async function resolveCached(result, ctx) {
  const log = (ctx && ctx.log) || (() => {});
  const apiKey = getKey(ctx && ctx.creds);
  if (!apiKey) return { ok: false };
  if (!result || !result.infoHash) return { ok: false };

  // Fallback learning (0.23.1): record on every ok:false path so subsequent
  // /stream requests skip the PM row for this hash. Warmer-time verification
  // is the primary mechanism; this is the safety net.
  const pmDenylist = require('../pm-denylist');
  const softDeny = (why) => {
    try {
      if (pmDenylist.add(result.infoHash, result.title, 'unresolvable')) {
        log('    pm: soft-denylisted ' + result.infoHash + ' (' + why + ')');
      }
    } catch (e) { log('    pm: denylist write failed: ' + e.message); }
  };

  const magnet = ctx.buildMagnet(result);
  const dl = await directDl(magnet, apiKey, log);
  if (!dl || !Array.isArray(dl.content) || dl.content.length === 0) {
    softDeny('directDl returned no content');
    return { ok: false };
  }

  const fileObjs = dl.content
    .map((f) => ({
      path: f.path || f.name,
      bytes: f.size || 0,
      link: f.stream_link || f.link,
    }))
    .filter((f) => f.link);

  const file = ctx.pickVideoFile(fileObjs);
  if (!file) { softDeny('no playable video file'); return { ok: false }; }

  const quality = ctx.qualityFromTitle(result.title);
  const sizeStr = ctx.humanSize(file.bytes);
  return {
    ok: true,
    stream: {
      name: 'PM' + (quality ? ' ' + quality : '') + (sizeStr ? '\n' + sizeStr : ''),
      title: result.title +
        '\n👥 ' + (result.seeders || 0) +
        (sizeStr ? ' | 💾 ' + sizeStr : '') +
        (result.indexer ? '\n[' + result.indexer + ']' : ''),
      url: file.link,
      behaviorHints: {
        bingeGroup: 'sport-pm-cached',
        videoSize: file.bytes || undefined,
        filename: file.path || undefined,
      },
    },
  };
}


// Queue the magnet for download — PM caches after completion. Subsequent
// directDl returns success once finished.
async function transferCreate(magnet, apiKey, log) {
  const key = apiKey || config.premiumize.apiKey;
  const body = 'apikey=' + encodeURIComponent(key) + '&src=' + encodeURIComponent(magnet);
  let res;
  try {
    res = await fetch(BASE + '/transfer/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeout: 12000,
    });
  } catch (err) { log && log('    premiumize.transferCreate network: ' + err.message); return null; }
  if (!res.ok) { log && log('    premiumize.transferCreate HTTP ' + res.status); return null; }
  const j = await jsonOrEmpty(res);
  if (!j || j.status !== 'success') return null;
  return j;
}

async function warmCache(result, ctx) {
  const log = (ctx && ctx.log) || (() => {});
  const apiKey = getKey(ctx && ctx.creds);
  if (!apiKey || !result || !result.infoHash) return false;
  const magnet = ctx.buildMagnet(result);
  const t = await transferCreate(magnet, apiKey, log);
  if (t) { log('    [PM] warm-add: ' + result.infoHash + ' queued'); return true; }
  return false;
}

module.exports = {
  name: 'Premiumize',
  code: 'PM',
  isConfigured: () => !!config.premiumize.apiKey,
  isAvailable: (creds) => !!getKey(creds),
  resolveCached,
  warmCache,
  directDl, transferCreate, cacheCheck,
};
