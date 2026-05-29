#!/usr/bin/env node
// Proactive stream-candidate warmer.
//
// Walks the events currently in the metadata window and pre-populates
// data/stream-cache.json with merged candidate torrents, so
// that a user's stream request hits a warm cache instead of waiting on a live
// indexer search. Resolved debrid streams are NOT warmed here (those are
// per-user); only the user-agnostic candidate list.
//
// Run manually:  npm run refresh-streams
// Or on a timer: server.js schedules it every STREAM_CACHE_REFRESH_HOURS.

const config = require('../config');
const store = require('../lib/store');
const streamcache = require('../lib/streamcache');
const { searchCandidates } = require('../lib/streams');
const tb = require('../lib/sources/torbox');
const pm = require('../lib/sources/premiumize');

function withinRefreshWindow(ev) {
  if (!ev || !ev.date) return false;
  const back = Math.max(0, config.streamCache.windowDaysBack | 0);
  const ahead = Math.max(0, config.streamCache.windowDaysAhead | 0);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const evDate = new Date(ev.date + 'T00:00:00Z');
  const diffDays = (evDate - today) / (1000 * 60 * 60 * 24);
  if (diffDays >= 0) return diffDays <= ahead;
  return -diffDays <= back;
}

async function runStreamRefresh(options) {
  const opts = options || {};
  const { redact } = require('../lib/redact');
  const baseLog = opts.log || ((m) => console.log(m));
  const log = (m) => baseLog(redact(String(m)));
  const start = Date.now();

  const events = (store.loadFromDisk().events || []).filter(withinRefreshWindow);
  log('[stream-refresh] warming ' + events.length + ' event(s) in window (-'
    + config.streamCache.windowDaysBack + '/+' + config.streamCache.windowDaysAhead + 'd)');

  // Drop cache entries for events that have aged out of the window.
  const removed = streamcache.prune(events.map((e) => e.id));
  if (removed > 0) log('[stream-refresh] pruned ' + removed + ' out-of-window cache entr(y/ies)');

  // Warmer-time cache verification (0.23.1). If WARMER_TB_TOKEN /
  // WARMER_PM_KEY are set, batch-check every candidate hash against the
  // respective non-destructive cache API and stamp results into each
  // candidate as cachedProviders={tb,pm,checkedAt}. streams.js then skips
  // unverified-not-cached rows. RD intentionally not done here — its API
  // doesn't allow a clean non-destructive check.
  const tbToken  = (config.warmer && config.warmer.tbToken)  || '';
  const pmApiKey = (config.warmer && config.warmer.pmApiKey) || '';
  const verifyEnabled = !!(tbToken || pmApiKey);
  if (verifyEnabled) {
    log('[stream-refresh] cache verification: TB=' + (tbToken ? 'on' : 'off')
      + ', PM=' + (pmApiKey ? 'on' : 'off'));
  } else {
    log('[stream-refresh] cache verification disabled (set WARMER_TB_TOKEN / WARMER_PM_KEY to enable)');
  }

  let warmed = 0, failed = 0, totalCands = 0;
  let tbHits = 0, tbMisses = 0, pmHits = 0, pmMisses = 0;
  for (const ev of events) {
    try {
      const found = await searchCandidates(ev, (m) => log('  ' + m));
      const hashes = found.map((c) => String(c.infoHash || '').toLowerCase()).filter(Boolean);

      // Per-event cache verification. Batched; one HTTP call per provider per
      // event in most cases (TB/PM both support multi-hash queries).
      let tbMap = new Map(), pmMap = new Map();
      if (verifyEnabled && hashes.length > 0) {
        try {
          if (tbToken)  tbMap = await tb.checkCachedBatch(hashes, tbToken, (m) => log('  ' + m));
        } catch (e) { log('  tb verify error: ' + e.message); }
        try {
          if (pmApiKey) pmMap = await pm.cacheCheck(hashes, pmApiKey, (m) => log('  ' + m));
        } catch (e) { log('  pm verify error: ' + e.message); }
        const checkedAt = new Date().toISOString();
        for (const c of found) {
          const h = String(c.infoHash || '').toLowerCase();
          const tbCached = tbMap.has(h) ? tbMap.get(h) : undefined;
          const pmCached = pmMap.has(h) ? pmMap.get(h) : undefined;
          if (tbCached === true) tbHits++; else if (tbCached === false) tbMisses++;
          if (pmCached === true) pmHits++; else if (pmCached === false) pmMisses++;
          // Only attach the field when at least one provider returned something
          // — keeps the JSON clean for unconfigured providers.
          if (tbCached !== undefined || pmCached !== undefined) {
            c.cachedProviders = {
              ...(tbCached !== undefined ? { tb: tbCached } : {}),
              ...(pmCached !== undefined ? { pm: pmCached } : {}),
              checkedAt,
            };
          }
        }
      }

      streamcache.put(ev.id, found);
      totalCands += found.length;
      warmed++;
      log('[stream-refresh] ' + ev.id + ' -> ' + found.length + ' candidate(s)'
        + (verifyEnabled ? ' (verified tb+pm)' : ''));
    } catch (err) {
      failed++;
      log('[stream-refresh] ' + ev.id + ' FAILED: ' + err.message);
    }
    // Be polite to the indexers / VPN proxy between events. Some sources
    // throttle under rapid-fire queries, so keep this comfortably spaced.
    await new Promise((r) => setTimeout(r, 1500));
  }

  const dur = ((Date.now() - start) / 1000).toFixed(1);
  log('[stream-refresh] done in ' + dur + 's — warmed ' + warmed
    + ', failed ' + failed + ', ' + totalCands + ' total candidate(s)'
    + (verifyEnabled
      ? ' | TB: ' + tbHits + ' cached / ' + tbMisses + ' not'
        + ' | PM: ' + pmHits + ' cached / ' + pmMisses + ' not'
      : ''));
  return { ok: true, warmed, failed, totalCands, tbHits, tbMisses, pmHits, pmMisses };
}

if (require.main === module) {
  runStreamRefresh().then((r) => process.exit(r.ok ? 0 : 1))
    .catch((err) => { console.error('[stream-refresh] fatal:', err.message); process.exit(1); });
}

module.exports = { runStreamRefresh };
