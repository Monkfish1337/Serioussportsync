'use strict';

// TorBox cache audit: asks TorBox, read-only, whether it has the releases
// SSS has saved for recent events, so "Cached on TorBox" (Discovery →
// Overview, Diagnosis) is measured rather than waiting for someone to open
// each event. On v1.3.0 140 of 167 saved events had never been checked.
//
// Every 30 minutes it takes the saved torrent hashes of the last seven days'
// events that TorBox has not been asked about in 48 hours, checks up to 200
// in batches of 50 with an administrator's TorBox key, and records each
// answer in the availability database under that key, exactly as a stream
// request would. Nothing is added to TorBox. A batch that fails (network,
// HTTP error) records nothing, so an outage never reads as "not cached".

const INTERVAL_MS = 30 * 60 * 1000;
const MAX_PER_RUN = 200;
const BATCH = 50;
let timer = null;
let running = false;

function defaults() {
  return {
    now: Date.now,
    users: () => require('./users').listUsers(),
    index: () => require('./availability-index').getDefault(),
    checkCachedBatch: (hashes, key, log) => require('./sources/torbox-resolver').checkCachedBatch(hashes, key, log),
    coverage: (now) => {
      const promotions = require('./promotions');
      const coverage = require('./discovery-coverage');
      const queue = require('./prowlarr-discovery').getDefault();
      const index = require('./availability-index').getDefault();
      const data = {
        promotions: promotions.all.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, autoTeam: p.autoTeam,
          releaseDerived: p.source && p.source.type === 'sport-video' && String(p.id).startsWith('discovered-') })),
        events: require('./store').getEvents(), queue: queue.status(),
        releases: require('./sources/sport-video').load().releases || [],
        relevant: (title, event) => promotions.getByEventId(event.id)?.isRelevantStreamTitle(title, event).ok === true,
        queueHashes: (event) => queue.candidates(event).map((c) => c.infoHash),
        torboxStates: (hashes) => index.torboxStates(hashes),
      };
      data.indexTitles = index.eventReleaseTitles(coverage.recentEvents(data.events, now, data.promotions).map((e) => e.id),
        { providers: ['torrent'], identityKinds: ['torrent'] });
      return coverage.coverage(data, now);
    },
    log: (message) => console.log('[torbox audit] ' + message),
  };
}

async function runOnce(options) {
  const d = Object.assign(defaults(), options || {});
  if (running) return { skipped: 'running' };
  running = true;
  try {
    const admin = (d.users() || []).find((u) => u && u.role === 'admin' && String((u.config || {}).torboxApiKey || '').trim()
      && (u.config || {}).torboxEnabled !== false);
    if (!admin) return { skipped: 'no-admin-torbox-key' };
    const key = String(admin.config.torboxApiKey).trim();
    const result = d.coverage(d.now());
    const titles = new Map();
    for (const row of result.rows || []) {
      if (row.torbox !== 'unchecked') continue;
      for (const hash of row.hashes || []) if (!titles.has(hash)) titles.set(hash, row.name || row.id);
    }
    const hashes = Array.from(titles.keys()).slice(0, MAX_PER_RUN);
    if (!hashes.length) return { checked: 0, cached: 0 };
    const index = d.index();
    const scope = index.scopeFingerprint('torbox', { apiKey: key });
    let checked = 0;
    let cached = 0;
    for (let i = 0; i < hashes.length; i += BATCH) {
      const batch = hashes.slice(i, i + BATCH);
      let failed = false;
      const found = await d.checkCachedBatch(batch, key, (line) => { if (/checkcached|network error|bad JSON/i.test(line)) failed = true; });
      if (failed) { d.log('a batch of ' + batch.length + ' failed; nothing recorded for it'); continue; }
      for (const hash of batch) {
        const isCached = found.has(hash);
        index.observe({ provider: 'torbox', scope, state: isCached ? 'cached' : 'unavailable',
          candidate: { infoHash: hash, title: titles.get(hash) } });
        checked++;
        if (isCached) cached++;
      }
    }
    d.log('checked ' + checked + ' saved release(s) against TorBox: ' + cached + ' cached');
    return { checked, cached };
  } catch (error) {
    d.log('failed: ' + error.message);
    return { error: error.message };
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  const tick = () => { runOnce().catch(() => {}); };
  setTimeout(tick, 2 * 60 * 1000).unref();
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
}

function stop() { clearInterval(timer); timer = null; }

module.exports = { runOnce, start, stop, INTERVAL_MS, MAX_PER_RUN };
