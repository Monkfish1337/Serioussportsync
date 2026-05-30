// Admin per-event power tool (0.28.0).
//
// Sportarr-style admin actions for a single event: re-run the indexer search
// to refresh its candidate list, warm a chosen torrent onto the admin's TB/PM
// libraries, and re-verify the warmer cache so the new state is visible to
// users on the next /stream call — all without touching the global warmer's
// 3-hour schedule.
//
// Uses the WARMER_TB_TOKEN / WARMER_PM_KEY env vars as the admin's debrid
// keys (the same ones the periodic warmer already uses). Never touches a
// user's per-account debrid keys.
//
// All functions are admin-only and assume the caller has already authorised.

const config = require('../config');
const store = require('./store');
const promotions = require('./promotions');
const streamcache = require('./streamcache');
const tb = require('./sources/torbox');
const pm = require('./sources/premiumize');

// Lazy require streams.searchCandidates to avoid a require cycle (streams.js
// imports a lot of state that mid-boot might not be ready yet).
function lazySearch() { return require('./streams').searchCandidates; }

function getEvent(eventId) {
  if (!eventId) return null;
  return store.getEvent(eventId) || null;
}

function eventBrief(ev) {
  if (!ev) return null;
  const p = promotions.getByEventId(ev.id);
  return {
    id: ev.id,
    name: ev.name,
    date: ev.date,
    promotion: p ? p.id : null,
    aliases: (ev.aliases || []).slice(0, 8),
  };
}

// List events (filtered, sorted) for the picker. No paging — caller can show
// all 200ish in a datalist; browser handles substring filtering client-side.
function listEvents(opts) {
  const o = opts || {};
  let all = store.getEvents() || [];
  if (o.promotion) {
    all = all.filter((ev) => {
      const p = promotions.getByEventId(ev.id);
      return p && p.id === o.promotion;
    });
  }
  // Most recent first within each side of "today".
  const today = new Date().toISOString().slice(0, 10);
  return all
    .slice()
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map((ev) => ({
      id: ev.id,
      name: ev.name,
      date: ev.date,
      isPast: !!(ev.date && ev.date < today),
    }));
}

// Run an indexer search for this event and persist the result into the
// candidate cache so /stream sees fresh data immediately.
async function searchEvent(eventId, log) {
  const ev = getEvent(eventId);
  if (!ev) return { ok: false, reason: 'event-not-found' };
  log && log('[power-tool] searching indexers for ' + eventId + ' (' + ev.name + ')');
  const candidates = await lazySearch()(ev, (m) => log && log('  ' + m));
  try { streamcache.put(eventId, candidates); }
  catch (e) { log && log('  streamcache put failed: ' + e.message); }
  log && log('[power-tool] saved ' + candidates.length + ' candidate(s) to cache');
  return { ok: true, count: candidates.length, candidates };
}

// Return the cached candidate list for an event (sorted size-desc) without
// re-searching. Returns null if cache miss.
function listCandidates(eventId) {
  const list = streamcache.get(eventId);
  if (!Array.isArray(list)) return null;
  return list
    .slice()
    .sort((a, b) => (b.size || 0) - (a.size || 0));
}

// Warm a set of specific hashes on a provider using the admin's WARMER key.
// Returns per-hash success/failure. Uses the same provider.warmCache call
// as the (now-disabled) user-facing auto-warm.
async function warmHashes(eventId, hashes, providerCode, log) {
  const ev = getEvent(eventId);
  if (!ev) return { ok: false, reason: 'event-not-found' };
  const list = streamcache.get(eventId);
  if (!Array.isArray(list)) return { ok: false, reason: 'no-cached-candidates' };
  const wanted = new Set((hashes || []).map((h) => String(h || '').toLowerCase()));
  if (wanted.size === 0) return { ok: false, reason: 'no-hashes' };
  const targets = list.filter((c) => wanted.has(String(c.infoHash || '').toLowerCase()));
  if (targets.length === 0) return { ok: false, reason: 'no-matching-candidates' };

  const code = String(providerCode || '').toLowerCase();
  let provider, adminKey, keyArg;
  if (code === 'tb') {
    provider = tb; adminKey = (config.warmer && config.warmer.tbToken) || '';
    if (!adminKey) return { ok: false, reason: 'WARMER_TB_TOKEN-not-set' };
    keyArg = { tb: adminKey };
  } else if (code === 'pm') {
    provider = pm; adminKey = (config.warmer && config.warmer.pmApiKey) || '';
    if (!adminKey) return { ok: false, reason: 'WARMER_PM_KEY-not-set' };
    keyArg = { pm: adminKey };
  } else {
    return { ok: false, reason: 'unsupported-provider' };
  }

  // tb.warmCache + pm.warmCache only need ctx.buildMagnet + ctx.log + ctx.creds.
  // Inline buildMagnet here rather than importing streams.js (which would
  // drag the whole resolver into the admin path for one helper).
  function buildMagnet(result) {
    const isRealMagnet = result.magnetUrl && result.magnetUrl.startsWith('magnet:');
    if (isRealMagnet) return result.magnetUrl;
    return 'magnet:?xt=urn:btih:' + String(result.infoHash || '').toUpperCase()
      + '&dn=' + encodeURIComponent(result.title || '')
      + '&tr=' + encodeURIComponent('udp://tracker.opentrackr.org:1337/announce')
      + '&tr=' + encodeURIComponent('udp://tracker.openbittorrent.com:80/announce')
      + '&tr=' + encodeURIComponent('udp://exodus.desync.com:6969/announce');
  }
  const ctx = { buildMagnet, log: log || (() => {}), creds: keyArg };

  const results = [];
  for (const c of targets) {
    log && log('[power-tool] warm ' + code.toUpperCase() + ' ' + c.infoHash + ' (' + (c.title || '').slice(0, 80) + ')');
    let ok = false;
    try { ok = !!(await provider.warmCache(c, ctx)); }
    catch (e) { log && log('  warm error: ' + e.message); ok = false; }
    results.push({ infoHash: c.infoHash, title: c.title, ok });
  }
  log && log('[power-tool] warm complete — ' + results.filter((r) => r.ok).length + '/' + results.length + ' succeeded');
  return { ok: true, results };
}

// Re-run the warmer's cache-check just for this event's hashes and stamp the
// results onto each candidate's cachedProviders, then persist. Picks up newly
// cached hashes immediately, no waiting for the 3h global warm cycle.
async function reverifyEvent(eventId, log) {
  const ev = getEvent(eventId);
  if (!ev) return { ok: false, reason: 'event-not-found' };
  const list = streamcache.get(eventId);
  if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: 'no-cached-candidates' };

  const tbToken  = (config.warmer && config.warmer.tbToken)  || '';
  const pmApiKey = (config.warmer && config.warmer.pmApiKey) || '';
  if (!tbToken && !pmApiKey) return { ok: false, reason: 'no-warmer-keys-set' };

  const hashes = list.map((c) => String(c.infoHash || '').toLowerCase()).filter(Boolean);
  log && log('[power-tool] re-verifying ' + hashes.length + ' candidate(s) for ' + eventId);

  let tbMap = new Map(), pmMap = new Map();
  if (tbToken) {
    try { tbMap = await tb.checkCachedBatch(hashes, tbToken, (m) => log && log('  ' + m)); }
    catch (e) { log && log('  tb verify error: ' + e.message); }
  }
  if (pmApiKey) {
    try { pmMap = await pm.cacheCheck(hashes, pmApiKey, (m) => log && log('  ' + m)); }
    catch (e) { log && log('  pm verify error: ' + e.message); }
  }
  const checkedAt = new Date().toISOString();
  let tbHits = 0, tbMisses = 0, pmHits = 0, pmMisses = 0;
  for (const c of list) {
    const h = String(c.infoHash || '').toLowerCase();
    const tbCached = tbMap.has(h) ? tbMap.get(h) : undefined;
    const pmCached = pmMap.has(h) ? pmMap.get(h) : undefined;
    if (tbCached === true) tbHits++; else if (tbCached === false) tbMisses++;
    if (pmCached === true) pmHits++; else if (pmCached === false) pmMisses++;
    if (tbCached !== undefined || pmCached !== undefined) {
      c.cachedProviders = {
        ...(c.cachedProviders || {}),
        ...(tbCached !== undefined ? { tb: tbCached } : {}),
        ...(pmCached !== undefined ? { pm: pmCached } : {}),
        checkedAt,
      };
    }
  }
  try { streamcache.put(eventId, list); }
  catch (e) { log && log('  streamcache put failed: ' + e.message); }
  log && log('[power-tool] re-verify complete — TB: ' + tbHits + ' cached / ' + tbMisses + ' not, '
    + 'PM: ' + pmHits + ' cached / ' + pmMisses + ' not');
  return { ok: true, tbHits, tbMisses, pmHits, pmMisses };
}

module.exports = {
  getEvent, eventBrief, listEvents,
  searchEvent, listCandidates,
  warmHashes, reverifyEvent,
};
