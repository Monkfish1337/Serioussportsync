'use strict';

// A small persistent record of what clients experienced, for Diagnosis:
// every stream request (an "open"), every play click (a "play") and, per
// indexer and day, how many torrent downloads through Prowlarr worked.
//
// The log buffer holds the same facts for a few hours at most. Diagnosis needs
// a week: "links stopped appearing on Tuesday" and "720pier's downloads have
// failed since the Prowlarr update" are both invisible in a log that has
// already scrolled. Nothing here is sent anywhere; the file sits next to the
// availability database and is trimmed to seven days.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const DAY = 24 * 60 * 60 * 1000;
const KEEP_MS = 7 * DAY;
const MAX_ROWS = 4000;
const FLUSH_MS = 5000;

let state = null;
let timer = null;
let fileOverride = null;

function file() {
  return fileOverride || path.join(path.dirname(config.availabilityDbFile || './data/availability.sqlite'), 'diagnosis-journal.json');
}

function empty() { return { opens: [], plays: [], downloads: {} }; }

function load() {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    state = { opens: Array.isArray(raw.opens) ? raw.opens : [], plays: Array.isArray(raw.plays) ? raw.plays : [],
      downloads: raw.downloads && typeof raw.downloads === 'object' ? raw.downloads : {} };
  } catch (_) { state = empty(); }
  return state;
}

function trim(now) {
  const s = load();
  const cutoff = now - KEEP_MS;
  s.opens = s.opens.filter((r) => r.at >= cutoff).slice(-MAX_ROWS);
  s.plays = s.plays.filter((r) => r.at >= cutoff).slice(-MAX_ROWS);
  const oldestDay = new Date(cutoff).toISOString().slice(0, 10);
  for (const [indexer, days] of Object.entries(s.downloads)) {
    for (const day of Object.keys(days)) if (day < oldestDay) delete days[day];
    if (!Object.keys(days).length) delete s.downloads[indexer];
  }
}

function flush() {
  timer = null;
  try {
    trim(Date.now());
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(load()), { mode: 0o600 });
  } catch (error) {
    console.error('[diagnosis] could not save the journal: ' + error.message);
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_MS);
  if (timer.unref) timer.unref();
}

const text = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);

// One stream request: which event, for whom, how long, how many rows.
function recordOpen(entry) {
  try {
    load().opens.push({ at: entry.at || Date.now(), eventId: text(entry.eventId, 120), user: text(entry.user, 60),
      ms: Math.max(0, Math.round(Number(entry.ms) || 0)), rows: Math.max(0, Number(entry.rows) || 0),
      pipelines: entry.pipelines && typeof entry.pipelines === 'object' ? entry.pipelines : {} });
    schedule();
  } catch (_) { /* diagnosis must never break a request */ }
}

// One play click. outcome: ok | not-cached | error | rejected.
function recordPlay(entry) {
  try {
    load().plays.push({ at: entry.at || Date.now(), eventId: text(entry.eventId, 120), user: text(entry.user, 60),
      provider: text(entry.provider, 20), outcome: text(entry.outcome, 20), ms: Math.max(0, Math.round(Number(entry.ms) || 0)),
      error: text(entry.error, 160) });
    schedule();
  } catch (_) { /* never break playback */ }
}

// One torrent download through Prowlarr, to recover a release's hash.
function recordDownload(indexer, ok, status, at) {
  try {
    const name = text(indexer || 'unknown', 80);
    const now = at || Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const s = load();
    const days = s.downloads[name] || (s.downloads[name] = {});
    const row = days[day] || (days[day] = { ok: 0, failed: 0 });
    if (ok) { row.ok += 1; row.lastOkAt = now; } else { row.failed += 1; row.lastFailAt = now; row.lastStatus = text(status, 60); }
    schedule();
  } catch (_) { /* never break a search */ }
}

function snapshot() {
  const s = load();
  return { opens: s.opens.slice(), plays: s.plays.slice(), downloads: JSON.parse(JSON.stringify(s.downloads)) };
}

// Tests only.
function _reset(filePath) {
  if (timer) clearTimeout(timer);
  timer = null;
  fileOverride = filePath || null;
  state = null;
}

module.exports = { recordOpen, recordPlay, recordDownload, snapshot, flush, file, _reset, KEEP_MS };
