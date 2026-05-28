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

  let warmed = 0, failed = 0, totalCands = 0;
  for (const ev of events) {
    try {
      const found = await searchCandidates(ev, (m) => log('  ' + m));
      streamcache.put(ev.id, found);
      totalCands += found.length;
      warmed++;
      log('[stream-refresh] ' + ev.id + ' -> ' + found.length + ' candidate(s)');
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
    + ', failed ' + failed + ', ' + totalCands + ' total candidate(s)');
  return { ok: true, warmed, failed, totalCands };
}

if (require.main === module) {
  runStreamRefresh().then((r) => process.exit(r.ok ? 0 : 1))
    .catch((err) => { console.error('[stream-refresh] fatal:', err.message); process.exit(1); });
}

module.exports = { runStreamRefresh };
