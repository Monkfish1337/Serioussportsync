// Real-Debrid REST client.
// Docs: https://api.real-debrid.com/
//
// RD removed instantAvailability in 2024. The flow is:
//   addMagnet → torrentInfo → selectFiles → poll status → unrestrictLink
// If the torrent is cached, status flips to "downloaded" within ~1–2s; if
// not, we deleteTorrent so the user's queue doesn't fill up.

const fetch = require('node-fetch');
const config = require('../../config');
// 451 / "infringing_file" denylist — see lib/rd-denylist.js for the rationale
// (RD's May-2026 keyword filter). We record hashes that RD blocks at play time
// so streams.js can stop advertising RD rows for them.
const rdDenylist = require('../rd-denylist');

const BASE = 'https://api.real-debrid.com/rest/1.0';
const CACHE_POLL_ATTEMPTS = 4;
const CACHE_POLL_DELAY_MS = 800;

// Build the auth header from a per-request token (preferred — passed via
// ctx.creds.rd by streams.js when serving a per-user route) or fall back to
// the env-based config.realDebrid.token for the legacy single-tenant path.
function authHeader(token) {
  return { Authorization: 'Bearer ' + (token || config.realDebrid.token) };
}
function formBody(obj) {
  return Object.entries(obj)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
}
async function jsonOrEmpty(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rdFetch(url, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, opts);
    if (res.status === 429 && attempt === 0) {
      await sleep(4000 + Math.random() * 2000);
      continue;
    }
    return res;
  }
}

async function instantAvailability() { return {}; }

async function addMagnet(magnet, token) {
  const res = await rdFetch(BASE + '/torrents/addMagnet', {
    method: 'POST',
    headers: { ...authHeader(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({ magnet }),
    timeout: 15000,
  });
  if (!res.ok) {
    // Attach the HTTP status so resolveCached can detect 451 ("infringing_file")
    // and feed the hash into the persistent denylist. Without this it just
    // looks like any other failed addMagnet.
    const err = new Error('addMagnet HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return jsonOrEmpty(res);
}

async function selectFiles(torrentId, fileIds, token) {
  const ids = Array.isArray(fileIds) ? fileIds.join(',') : String(fileIds);
  const res = await rdFetch(BASE + '/torrents/selectFiles/' + torrentId, {
    method: 'POST',
    headers: { ...authHeader(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({ files: ids }),
    timeout: 15000,
  });
  if (res.status >= 400) throw new Error('selectFiles HTTP ' + res.status);
}

async function torrentInfo(torrentId, token) {
  const res = await rdFetch(BASE + '/torrents/info/' + torrentId, {
    headers: authHeader(token),
    timeout: 15000,
  });
  if (!res.ok) throw new Error('torrentInfo HTTP ' + res.status);
  return jsonOrEmpty(res);
}

async function unrestrictLink(link, token) {
  const res = await rdFetch(BASE + '/unrestrict/link', {
    method: 'POST',
    headers: { ...authHeader(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({ link }),
    timeout: 15000,
  });
  if (!res.ok) {
    // 451 can also surface here (error_code: 35) for keyword-filtered torrents
    // — propagate status so resolveCached records the hash.
    const err = new Error('unrestrictLink HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return jsonOrEmpty(res);
}

async function deleteTorrent(torrentId, token) {
  try {
    await fetch(BASE + '/torrents/delete/' + torrentId, {
      method: 'DELETE',
      headers: authHeader(token),
      timeout: 10000,
    });
  } catch {}
}

// Common provider interface — takes a Prowlarr result + helpers and returns
// { ok, stream } if a cached stream was resolved.
async function resolveCached(result, ctx) {
  const log = (ctx && ctx.log) || (() => {});
  // Per-request token (Phase 2 per-user routes) takes precedence over env.
  const token = (ctx && ctx.creds && ctx.creds.rd) || config.realDebrid.token;
  if (!token) return { ok: false };
  if (!result || !result.infoHash) return { ok: false };

  const magnet = ctx.buildMagnet(result);
  let torrentId = null;
  // Soft-denylist any non-451 "not cached / unresolvable" outcome (0.22.3).
  // Default 24h TTL (`RD_SOFT_DENYLIST_HOURS`) so a hash that genuinely isn't
  // on RD stops cluttering future RD rows, but can come back if it later
  // gets cached. Hard 30-day TTL for 451 stays in the catch block below.
  const softDeny = (why) => {
    try {
      if (rdDenylist.add(result.infoHash, result.title, 'unresolvable')) {
        log('    rd: soft-denylisted ' + result.infoHash + ' (' + why + ')');
      }
    } catch (e) { log('    rd: denylist write failed: ' + e.message); }
  };
  try {
    const add = await addMagnet(magnet, token);
    if (!add.id) { softDeny('addMagnet returned no id'); return { ok: false }; }
    torrentId = add.id;

    let info = await torrentInfo(torrentId, token);
    if ((info.status === 'magnet_conversion' || info.status === 'queued') &&
        (!info.files || info.files.length === 0)) {
      await sleep(700);
      info = await torrentInfo(torrentId, token);
    }
    if (!info.files || info.files.length === 0) {
      softDeny('no files after magnet_conversion');
      await deleteTorrent(torrentId, token); return { ok: false };
    }

    const file = ctx.pickVideoFile(info.files);
    await selectFiles(torrentId, file ? [file.id] : ['all'], token);

    let info2 = await torrentInfo(torrentId, token);
    let attempts = 0;
    while (info2.status !== 'downloaded' && attempts < CACHE_POLL_ATTEMPTS) {
      if ((info2.status === 'downloading' || info2.status === 'queued') &&
          info2.progress !== undefined && info2.progress < 100) {
        softDeny('not cached (' + info2.status + ', progress=' + info2.progress + ')');
        await deleteTorrent(torrentId, token); return { ok: false };
      }
      if (['error', 'magnet_error', 'virus', 'dead'].includes(info2.status)) {
        softDeny('dead torrent (' + info2.status + ')');
        await deleteTorrent(torrentId, token); return { ok: false };
      }
      await sleep(CACHE_POLL_DELAY_MS);
      info2 = await torrentInfo(torrentId, token);
      attempts++;
    }

    if (info2.status !== 'downloaded' || !info2.links || info2.links.length === 0) {
      softDeny('not cached after polling (status=' + info2.status + ')');
      await deleteTorrent(torrentId, token); return { ok: false };
    }

    const u = await unrestrictLink(info2.links[0], token);
    if (!u.download) {
      softDeny('unrestrict returned no download URL');
      await deleteTorrent(torrentId, token); return { ok: false };
    }

    const quality = ctx.qualityFromTitle(result.title);
    const sizeStr = ctx.humanSize(file ? file.bytes : result.size);
    return {
      ok: true,
      stream: {
        name: 'RD' + (quality ? ' ' + quality : '') + (sizeStr ? '\n' + sizeStr : ''),
        title: result.title +
          '\n👥 ' + (result.seeders || 0) +
          (sizeStr ? ' | 💾 ' + sizeStr : '') +
          (result.indexer ? '\n[' + result.indexer + ']' : ''),
        url: u.download,
        behaviorHints: {
          bingeGroup: 'sport-rd-cached',
          videoSize: file ? file.bytes : undefined,
          filename: u.filename || (file && file.path) || undefined,
        },
      },
    };
  } catch (err) {
    log('    rd error for ' + result.infoHash + ': ' + err.message);
    // RD's May-2026 keyword filter surfaces as HTTP 451 ("infringing_file")
    // from either addMagnet or unrestrict/link. Record the hash so future
    // /stream calls skip the RD row for it (see lib/rd-denylist.js + the
    // pre-filter in lib/streams.js).
    if (err && err.status === 451 && result && result.infoHash) {
      try {
        if (rdDenylist.add(result.infoHash, result.title, '451')) {
          log('    rd: 451 — added ' + result.infoHash + ' to denylist (hard)');
        }
      } catch (e) { log('    rd: denylist write failed: ' + e.message); }
    } else if (result && result.infoHash) {
      // Network error / timeout / parse error etc. — soft-denylist so we
      // don't keep retrying the same flaky hash. Short TTL so a transient
      // outage doesn't pin the row out for long.
      try {
        if (rdDenylist.add(result.infoHash, result.title, 'unresolvable')) {
          log('    rd: soft-denylisted ' + result.infoHash + ' (exception: ' + err.message + ')');
        }
      } catch (e) { log('    rd: denylist write failed: ' + e.message); }
    }
    if (torrentId) deleteTorrent(torrentId, token);
    return { ok: false };
  }
}


// Auto-cache: add magnet, brief wait for files, selectFiles. RD then starts
// downloading. We do NOT poll for completion or deleteTorrent — next stream
// request will see status='downloaded'.
async function warmCache(result, ctx) {
  const log = (ctx && ctx.log) || (() => {});
  const token = (ctx && ctx.creds && ctx.creds.rd) || config.realDebrid.token;
  if (!token || !result || !result.infoHash) return false;
  const magnet = ctx.buildMagnet(result);
  try {
    const add = await addMagnet(magnet, token);
    if (!add || !add.id) return false;
    let info = await torrentInfo(add.id, token);
    if ((info.status === 'magnet_conversion' || info.status === 'queued') &&
        (!info.files || info.files.length === 0)) {
      await sleep(800);
      info = await torrentInfo(add.id, token);
    }
    if (!info.files || info.files.length === 0) return false;
    const file = ctx.pickVideoFile(info.files);
    await selectFiles(add.id, file ? [file.id] : ['all'], token);
    log('    [RD] warm-add: ' + result.infoHash + ' queued (id ' + add.id + ')');
    return true;
  } catch (err) {
    log('    [RD] warm-add error: ' + err.message);
    return false;
  }
}

module.exports = {
  name: 'Real-Debrid',
  code: 'RD',
  // Env-config check (legacy single-tenant). Per-user requests provide
  // their own token via ctx.creds.rd and bypass this check.
  isConfigured: () => !!config.realDebrid.token,
  isAvailable: (creds) => !!((creds && creds.rd) || config.realDebrid.token),
  resolveCached,
  warmCache,
  instantAvailability, addMagnet, selectFiles, torrentInfo, unrestrictLink, deleteTorrent,
};
