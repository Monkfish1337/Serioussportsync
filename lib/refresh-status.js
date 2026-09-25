'use strict';

// The outcome of the last metadata refresh, kept so the Diagnosis page can
// show it. Until this existed a failed or skipped promotion (a missing TMDB
// key, a feed that timed out) was visible only in the log it scrolled out of.

const fs = require('fs');
const path = require('path');
const config = require('../config');

function file() {
  return path.join(path.dirname(config.availabilityDbFile || './data/availability.sqlite'), 'refresh-status.json');
}

// `run`: { finishedAt, ok, durationMs, scope, total, promotions: [{ id, status,
// fetched, added, updated, skipped, reason }] }. A targeted refresh updates
// only its own promotion's entry, so one per-promotion refresh does not erase
// what the last full refresh recorded about the rest.
function record(run) {
  try {
    const previous = load();
    const byId = new Map(((previous && previous.promotions) || []).map((p) => [p.id, p]));
    for (const entry of run.promotions || []) byId.set(entry.id, Object.assign({ at: run.finishedAt }, entry));
    const next = Object.assign({}, run, { promotions: Array.from(byId.values()) });
    if (run.scope !== 'all' && previous) {
      next.lastFullRefreshAt = previous.lastFullRefreshAt || null;
    } else {
      next.lastFullRefreshAt = run.finishedAt;
    }
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next, null, 1), { mode: 0o600 });
  } catch (error) {
    console.error('[refresh] could not save refresh status: ' + error.message);
  }
}

function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (_) { return null; }
}

module.exports = { record, load, file };
