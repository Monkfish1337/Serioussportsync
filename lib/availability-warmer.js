'use strict';

// Proactively fills the Smart Availability Index for a bounded rolling event
// window. Work is deliberately spread across runs: the newest events are
// visited first, then an in-memory cursor rotates through the rest of the
// seven-day window. Provider cache TTLs make revisiting an event cheap.

const store = require('./store');
const users = require('./users');
const streams = require('./streams');
const settings = require('./settings');
const promotions = require('./promotions');
const { effectiveCatalogSelection } = require('./catalog-selection');
const availabilityStore = require('./availability-index');

let cursor = 0;
let running = null;
const state = {
  lastStartedAt: null,
  lastCompletedAt: null,
  lastReason: null,
  eligibleEvents: 0,
  attemptedEvents: 0,
  attemptedProfiles: 0,
  errors: 0,
  lastError: null,
  currentEvent: null,
  currentProfile: null,
  completedProfiles: 0,
  totalProfiles: 0,
  batchEvents: 0,
  lastDurationMs: null,
  providerStatus: {},
  prunedRows: 0,
};

function providerRow(provider) {
  if (!state.providerStatus[provider]) {
    state.providerStatus[provider] = {
      attempts: 0, successes: 0, failures: 0, skipped: 0,
      totalDurationMs: 0, lastDurationMs: null, lastSuccessAt: null,
      lastError: null, suppressed: false,
    };
  }
  return state.providerStatus[provider];
}

function dayNumber(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 86400000) : null;
}

function eligibleEvents(events, options) {
  const opts = options || {};
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const today = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86400000);
  const windowDays = Math.max(1, Number(opts.windowDays) || 7);
  const firstDay = today - windowDays + 1;
  return (Array.isArray(events) ? events : [])
    .filter((event) => {
      const day = dayNumber(event && event.date);
      return day !== null && day >= firstDay && day <= today;
    })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))
      || String(a.id || '').localeCompare(String(b.id || '')));
}

function nextBatch(events, maximum) {
  if (!events.length) { cursor = 0; return []; }
  const size = Math.min(events.length, Math.max(1, Number(maximum) || 25));
  if (cursor >= events.length) cursor = 0;
  const batch = [];
  for (let offset = 0; offset < size; offset++) {
    batch.push(events[(cursor + offset) % events.length]);
  }
  cursor = (cursor + size) % events.length;
  return batch;
}

function configuredProfiles() {
  const profiles = users.listUsers().map((user) => users.findById(user.id)).filter(Boolean)
    .map((user) => ({ id: user.id, username: user.username, config: user.config || {} }));
  // Even before the first account is created, the anonymous profile can warm
  // the server-wide companion/Prowlarr torrent discovery cache.
  return profiles.length ? profiles : [{ id: 'system', username: 'system', config: {} }];
}

function profileIncludesEvent(profile, event) {
  if (!profile || profile.id === 'system') return true;
  const selected = effectiveCatalogSelection(profile.config || {});
  if (!selected) return true;
  const promotion = promotions.getByEventId(event && event.id);
  if (!promotion || !Array.isArray(promotion.catalogs)) return false;
  return promotion.catalogs.some((catalog) => selected.has(catalog.id)
    && (typeof catalog.filter !== 'function' || catalog.filter(event)));
}

async function execute(options) {
  const opts = options || {};
  const warmConfig = settings.getAvailabilityWarm();
  if (warmConfig.enabled === false && !opts.force) return { ok: false, skipped: 'disabled' };
  const all = eligibleEvents(opts.events || store.getEvents(), {
    now: opts.now,
    windowDays: opts.windowDays || warmConfig.windowDays,
  });
  const batch = nextBatch(all, opts.maxEvents || warmConfig.maxEventsPerRun);
  const profiles = opts.profiles || configuredProfiles();
  const work = batch.map((event) => ({
    event,
    profiles: profiles.filter((profile) => profileIncludesEvent(profile, event)),
  })).filter((item) => item.profiles.length > 0);
  const prefetch = opts.prefetch || streams.prefetchAvailability;
  const log = opts.log || ((message) => console.log('[availability] ' + message));

  state.lastStartedAt = new Date().toISOString();
  state.lastReason = opts.reason || 'scheduled';
  state.eligibleEvents = all.length;
  state.attemptedEvents = 0;
  state.attemptedProfiles = 0;
  state.errors = 0;
  state.lastError = null;
  state.currentEvent = null;
  state.currentProfile = null;
  state.completedProfiles = 0;
  state.totalProfiles = work.reduce((total, item) => total + item.profiles.length, 0);
  state.batchEvents = work.length;
  state.providerStatus = {};
  state.prunedRows = 0;
  try {
    const removed = availabilityStore.getDefault().prune();
    state.prunedRows = Object.values(removed || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  } catch (error) {
    log('automatic database cleanup skipped: ' + error.message);
  }
  const failureThreshold = Math.max(1,
    Number.parseInt(process.env.AVAILABILITY_WARM_FAILURE_THRESHOLD || '2', 10) || 2);
  const circuitFailures = new Map();
  const suppressedScopes = new Set();
  log('automatic preparation starting (' + work.length + '/' + all.length + ' recent event(s), '
    + state.totalProfiles + ' selected account-event check(s), reason: ' + state.lastReason + ')');

  for (const item of work) {
    const event = item.event;
    state.attemptedEvents++;
    state.currentEvent = String(event.name || event.id || 'Unknown event');
    for (const profile of item.profiles) {
      state.attemptedProfiles++;
      state.currentProfile = String(profile.username || 'account');
      try {
        const scopePrefix = String(profile.id || profile.username || 'account') + ':';
        const skipProviders = Array.from(suppressedScopes)
          .filter((key) => key.startsWith(scopePrefix)).map((key) => key.slice(scopePrefix.length));
        for (const provider of skipProviders) providerRow(provider).skipped++;
        const result = await prefetch({
          event,
          userConfig: profile.config || {},
          username: profile.username || 'account',
          prepare: warmConfig,
          skipProviders,
          log: (message) => log((profile.username || 'account') + ': ' + message),
        });
        for (const outcome of (result && result.outcomes || [])) {
          const provider = String(outcome.provider || 'unknown');
          const row = providerRow(provider);
          row.attempts++;
          row.lastDurationMs = Number(outcome.durationMs) || 0;
          row.totalDurationMs += row.lastDurationMs;
          const circuitKey = scopePrefix + provider;
          if (outcome.ok) {
            row.successes++;
            row.lastSuccessAt = new Date().toISOString();
            circuitFailures.set(circuitKey, 0);
          } else {
            row.failures++;
            row.lastError = String(outcome.error || 'search-failed');
            const failures = (circuitFailures.get(circuitKey) || 0) + 1;
            circuitFailures.set(circuitKey, failures);
            if (failures >= failureThreshold && !suppressedScopes.has(circuitKey)) {
              suppressedScopes.add(circuitKey);
              row.suppressed = true;
              log((profile.username || 'account') + ': ' + provider
                + ' suppressed for the rest of this run after ' + failures + ' consecutive failures');
            }
          }
        }
        if (result && Array.isArray(result.errors) && result.errors.length) {
          state.errors += result.errors.length;
          state.lastError = result.errors[result.errors.length - 1];
        }
      } catch (error) {
        state.errors++;
        state.lastError = error.message;
        log('warm-up event failed (' + String(event.id || event.name || 'unknown') + '): ' + error.message);
      } finally {
        state.completedProfiles++;
      }
    }
  }
  state.lastCompletedAt = new Date().toISOString();
  state.lastDurationMs = Date.parse(state.lastCompletedAt) - Date.parse(state.lastStartedAt);
  state.currentEvent = null;
  state.currentProfile = null;
  log('automatic preparation complete (' + state.attemptedEvents + ' event(s), '
    + state.attemptedProfiles + ' account scope(s), ' + state.errors + ' error(s))');
  return Object.assign({ ok: true }, status());
}

function run(options) {
  if (running) return running;
  running = execute(options).finally(() => { running = null; });
  return running;
}

function status() {
  const warmConfig = settings.getAvailabilityWarm();
  return Object.assign({}, state, {
    enabled: warmConfig.enabled !== false,
    running: Boolean(running),
    windowDays: warmConfig.windowDays || 3,
    intervalHours: warmConfig.intervalHours || 6,
    maxEventsPerRun: warmConfig.maxEventsPerRun || 25,
    startDelaySeconds: warmConfig.startDelaySeconds || 60,
  });
}

function resetForTests() {
  cursor = 0;
  running = null;
  Object.assign(state, {
    lastStartedAt: null, lastCompletedAt: null, lastReason: null,
    eligibleEvents: 0, attemptedEvents: 0, attemptedProfiles: 0,
    errors: 0, lastError: null,
    currentEvent: null, currentProfile: null, completedProfiles: 0,
    totalProfiles: 0, batchEvents: 0, lastDurationMs: null,
    providerStatus: {}, prunedRows: 0,
  });
}

module.exports = { eligibleEvents, run, status, _test: { nextBatch, profileIncludesEvent, resetForTests } };
