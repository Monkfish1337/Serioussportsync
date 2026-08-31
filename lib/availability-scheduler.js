'use strict';

const settings = require('./settings');
const warmer = require('./availability-warmer');

let timer = null;
let available = false;
let started = false;
let nextRunAt = null;
let log = (message) => console.log('[availability] ' + message);

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
  nextRunAt = null;
}

function schedule(delayMs) {
  clearTimer();
  const cfg = settings.getAvailabilityWarm();
  if (!started || !available || !cfg.enabled) return;
  const delay = Math.max(1000, Math.round(delayMs));
  nextRunAt = new Date(Date.now() + delay).toISOString();
  timer = setTimeout(() => {
    timer = null;
    nextRunAt = null;
    runNow('scheduled').catch((error) => log('scheduled warm-up failed: ' + error.message));
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

async function runNow(reason, options) {
  const opts = options || {};
  const cfg = settings.getAvailabilityWarm();
  if (!available) return { ok: false, skipped: 'unavailable' };
  if (!cfg.enabled && !opts.force) return { ok: false, skipped: 'disabled' };
  clearTimer();
  try {
    return await warmer.run({ reason: reason || 'manual', force: opts.force === true });
  } finally {
    if (started && settings.getAvailabilityWarm().enabled) {
      schedule(settings.getAvailabilityWarm().intervalHours * 60 * 60 * 1000);
    }
  }
}

function start(options) {
  const opts = options || {};
  available = opts.available !== false;
  started = true;
  if (typeof opts.log === 'function') log = opts.log;
  const cfg = settings.getAvailabilityWarm();
  if (!available) {
    log('automatic preparation disabled because SQLite is unavailable');
    return status();
  }
  if (!cfg.enabled) {
    log('automatic preparation disabled in Database settings');
    return status();
  }
  log('scheduling automatic preparation every ' + cfg.intervalHours + 'h (last '
    + cfg.windowDays + ' days, up to ' + cfg.maxEventsPerRun + ' events per run)');
  schedule(cfg.startDelaySeconds * 1000);
  return status();
}

function reconfigure() {
  if (!started) return status();
  const cfg = settings.getAvailabilityWarm();
  clearTimer();
  if (available && cfg.enabled) {
    log('automatic preparation schedule updated: every ' + cfg.intervalHours + 'h, last '
      + cfg.windowDays + ' days, up to ' + cfg.maxEventsPerRun + ' events');
    schedule(cfg.intervalHours * 60 * 60 * 1000);
  } else {
    log('automatic preparation schedule disabled');
  }
  return status();
}

function stop() {
  clearTimer();
  started = false;
}

function status() {
  return {
    started,
    available,
    nextRunAt,
    scheduled: Boolean(timer),
    settings: settings.getAvailabilityWarm(),
  };
}

module.exports = { start, stop, reconfigure, runNow, status };
