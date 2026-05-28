// Stremio UFC Metadata Addon — entry point
const config = require('./config');
const { createApp } = require('./addon');
const store = require('./lib/store');
const { runRefresh } = require('./scripts/refresh');

// SESSION_SECRET hard-fail (0.22.2). If unset or too short, sessions fall back
// to a derived secret that can be guessed across default-config instances,
// which is unsafe for any deployment that lets other people log in. Refuse to
// boot instead of silently using the weak fallback. Dev-only escape hatch:
// ALLOW_INSECURE_SECRET=1 (use only when iterating locally).
(function enforceSessionSecret() {
  const secret = process.env.SESSION_SECRET || '';
  const allowInsecure = process.env.ALLOW_INSECURE_SECRET === '1';
  if (secret.length >= 32) return;
  if (allowInsecure) {
    console.warn('[serioussportsync] WARNING: weak/missing SESSION_SECRET allowed via ALLOW_INSECURE_SECRET=1 — dev only, never use in production.');
    return;
  }
  console.error('[serioussportsync] FATAL: SESSION_SECRET must be set to a random string of at least 32 characters.');
  console.error('  Generate one with:  openssl rand -hex 32');
  console.error('  Then set it in your .env (or docker-compose env block) and restart.');
  console.error('  (Set ALLOW_INSECURE_SECRET=1 to bypass this check for local development ONLY.)');
  process.exit(1);
})();

const app = createApp();

// Warm the cache on boot so the first request is fast.
const initial = store.loadFromDisk();
const initialCount = (initial.events || []).length;
console.log(`[serioussportsync] loaded ${initialCount} events from cache (${config.dataFile})`);

// Start HTTP first, then handle background work.
const server = app.listen(config.port, config.host, () => {
  console.log(`[serioussportsync] listening on http://${config.host}:${config.port}`);
  console.log(`[serioussportsync] manifest:  http://${config.host}:${config.port}/manifest.json`);
  scheduleBackgroundWork(initialCount);
});

function scheduleBackgroundWork(currentCount) {
  // Empty cache: refresh right away in the background.
  if (config.refreshOnEmptyCache && currentCount === 0) {
    console.log('[serioussportsync] cache empty — kicking off initial refresh in background');
    runRefresh({ log: (m) => console.log(m) }).catch((err) => {
      console.error('[serioussportsync] initial refresh failed:', err.message);
    });
  } else if (currentCount === 0) {
    console.log('[serioussportsync] cache empty — run `npm run refresh` to populate.');
  }

  // Periodic refresh.
  const hours = config.refreshIntervalHours;
  if (hours > 0) {
    const ms = Math.round(hours * 60 * 60 * 1000);
    console.log(`[serioussportsync] scheduling refresh every ${hours}h`);
    const t = setInterval(() => {
      runRefresh({ log: (m) => console.log(m) }).catch((err) => {
        console.error('[serioussportsync] scheduled refresh failed:', err.message);
      });
    }, ms);
    if (typeof t.unref === 'function') t.unref();
  } else {
    console.log('[serioussportsync] periodic refresh disabled (REFRESH_INTERVAL_HOURS=0)');
  }

  // Proactive stream-candidate warmer (0.16.0). Pre-fills data/stream-cache.json
  // so user stream requests skip the live indexer search. Independent of the
  // metadata refresh above.
  if (config.streamCache.refresh && config.streamCache.refreshHours > 0) {
    const { runStreamRefresh } = require('./scripts/refresh-streams');
    const sms = Math.round(config.streamCache.refreshHours * 60 * 60 * 1000);
    console.log(`[serioussportsync] scheduling stream-cache warm every ${config.streamCache.refreshHours}h`);
    // First warm shortly after boot, delayed so an empty-cache metadata
    // refresh has a chance to land events first.
    const kick = setTimeout(() => {
      runStreamRefresh({ log: (m) => console.log(m) }).catch((err) =>
        console.error('[serioussportsync] stream warm failed:', err.message));
    }, 60 * 1000);
    if (typeof kick.unref === 'function') kick.unref();
    const st = setInterval(() => {
      runStreamRefresh({ log: (m) => console.log(m) }).catch((err) =>
        console.error('[serioussportsync] stream warm failed:', err.message));
    }, sms);
    if (typeof st.unref === 'function') st.unref();
  } else {
    console.log('[serioussportsync] proactive stream-cache warm disabled (STREAM_CACHE_REFRESH=off)');
  }
}

// Graceful shutdown so Docker's SIGTERM closes connections cleanly.
function shutdown(signal) {
  console.log(`[serioussportsync] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
