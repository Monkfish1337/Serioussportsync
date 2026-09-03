// Stremio UFC Metadata Addon — entry point
const config = require('./config');

// 0.27.0: capture every console line into an in-memory ring buffer so the
// admin /logs page can render recent activity without SSH. Wrap BEFORE other
// modules load so their boot-time logs are captured too.
const logBuffer = require('./lib/log-buffer');
logBuffer.wrapConsole(console);

const { createApp } = require('./addon');
const store = require('./lib/store');
const { runRefresh } = require('./scripts/refresh');
const availabilityStore = require('./lib/availability-index');
const availabilityScheduler = require('./lib/availability-scheduler');
const sportVideo = require('./lib/sources/sport-video');

// SESSION_SECRET hard-fail (0.22.2). A missing or short shared secret would
// make session, resolve-signature, and encrypted-provider protections unsafe.
// Refuse to boot instead of permitting an implicit production fallback. Dev-only escape hatch:
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

// Open and migrate the availability index before accepting traffic. The
// original positive-cache file remains untouched as a rollback-safe source.
let availabilityIndex = null;
try {
  availabilityIndex = availabilityStore.getDefault();
  const availabilityMigration = availabilityIndex.migratePositiveCache(config.positiveCache.file);
  const availabilityPruned = availabilityIndex.prune();
  console.log('[availability] SQLite ready (' + availabilityIndex.stats().releases
    + ' releases, imported ' + availabilityMigration.imported + ', pruned '
    + Object.values(availabilityPruned).reduce((sum, value) => sum + value, 0) + ')');
} catch (error) {
  // Availability knowledge is an optimization. A damaged/locked cache must not
  // take the metadata and existing playback pipelines offline.
  console.error('[availability] disabled for this process:', error.message);
}

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
  const availabilityTimer = availabilityIndex && setInterval(() => {
    try {
      const removed = availabilityIndex.prune();
      const total = Object.values(removed).reduce((sum, value) => sum + value, 0);
      if (total) console.log('[availability] pruned ' + total + ' expired row(s)');
    } catch (error) {
      console.error('[availability] scheduled prune failed:', error.message);
    }
  }, 6 * 60 * 60 * 1000);
  if (availabilityTimer && typeof availabilityTimer.unref === 'function') availabilityTimer.unref();

  // Empty cache: refresh right away in the background.
  if (config.refreshOnEmptyCache && currentCount === 0) {
    console.log('[serioussportsync] cache empty — kicking off initial refresh in background');
    runRefresh({ log: (m) => console.log(m) })
      .then(() => triggerAvailabilityWarm('initial-refresh'))
      .catch((err) => {
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
      runRefresh({ log: (m) => console.log(m) })
        .then(() => triggerAvailabilityWarm('catalog-refresh'))
        .catch((err) => {
          console.error('[serioussportsync] scheduled refresh failed:', err.message);
        });
    }, ms);
    if (typeof t.unref === 'function') t.unref();
  } else {
    console.log('[serioussportsync] periodic refresh disabled (REFRESH_INTERVAL_HOURS=0)');
  }

  availabilityScheduler.start({
    available: Boolean(availabilityIndex),
    log: (message) => console.log('[availability] ' + message),
  });
  sportVideo.startScheduler();

}

function triggerAvailabilityWarm(reason) {
  if (!availabilityIndex) return Promise.resolve({ ok: false, skipped: 'unavailable' });
  return availabilityScheduler.runNow(reason).catch((error) => {
    console.error('[availability] warm-up failed:', error.message);
    return { ok: false, error: error.message };
  });
}

// Graceful shutdown so Docker's SIGTERM closes connections cleanly.
function shutdown(signal) {
  console.log(`[serioussportsync] ${signal} received, shutting down`);
  availabilityScheduler.stop();
  sportVideo.stopScheduler();
  server.close(() => {
    try { if (availabilityIndex) availabilityIndex.close(); } catch (_) { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
