// Real-Debrid 451 / "infringing_file" denylist (persistent, per-instance).
//
// Background: around 2026-05-10, Real-Debrid began returning HTTP 451 for any
// cached torrent whose filename matches a keyword list (WEB-DL/WEBRip/AMZN/NF/
// CR/YTS/RARBG and similar release-tag conventions). The block is per-filename,
// applied at addMagnet AND unrestrict/link. ElfHosted/AIOStreams patched by
// dropping flagged streams from their aggregator's result list reactively. For
// us — a primary addon under optimistic resolution — the equivalent is to
// REMEMBER hashes that 451'd at play time and stop advertising RD rows for
// them. Combined with the keyword pre-filter in streams.js, this means a
// known-bad hash burns at most one click ever, then disappears from RD output
// for ~30 days for every user on the instance.
//
// On-disk shape (data/rd-denylist.json), same atomic tmp+rename pattern as
// streamcache.json:
//   { updatedAt, entries: { "<lowercaseHash>": { ts, lastTitle? } } }
//
// Reads are lightweight (single JSON parse) and we lazy-prune expired entries
// on each save. The file is tiny — a hash key is 40 chars and we only store a
// timestamp plus an optional short title for the admin view.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = (config.rdDenylist && config.rdDenylist.file) || './data/rd-denylist.json';
// Hard TTL — used for explicit 451 ("infringing_file") blocks. RD won't reverse
// these quickly, so a long TTL avoids re-probing.
const TTL_MS = Math.max(0, (config.rdDenylist && config.rdDenylist.ttlDays) || 30) * 24 * 60 * 60 * 1000;
// Soft TTL — used for "not cached / unresolvable" outcomes (no 451). The hash
// could become cached later if another user adds it, so the entry expires
// fast enough to give it another chance. 0.22.3.
const SOFT_TTL_MS = Math.max(0, (config.rdDenylist && config.rdDenylist.softTtlHours) || 24) * 60 * 60 * 1000;

// Reason → TTL map. Default to the long (hard) TTL on unknown reasons so any
// future codepath that forgets to pass a reason still gets a safe block.
function ttlForReason(reason) {
  if (reason === '451') return TTL_MS;
  if (reason === 'unresolvable') return SOFT_TTL_MS;
  return TTL_MS;
}

function loadAll() {
  try {
    if (!fs.existsSync(FILE)) return { updatedAt: null, entries: {} };
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j || typeof j !== 'object') return { updatedAt: null, entries: {} };
    if (!j.entries) j.entries = {};
    return j;
  } catch (err) {
    console.error('[rd-denylist] failed to load:', err.message);
    return { updatedAt: null, entries: {} };
  }
}

function saveAll(state) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

function isFresh(entry) {
  if (!entry || !entry.ts) return false;
  const ttl = ttlForReason(entry.reason);
  if (ttl <= 0) return true;
  return (Date.now() - entry.ts) < ttl;
}

// Lazy-prune: drop expired entries during a save so the file doesn't grow
// without bound. Returns the count removed.
function pruneExpired(state) {
  let removed = 0;
  for (const k of Object.keys(state.entries)) {
    if (!isFresh(state.entries[k])) { delete state.entries[k]; removed++; }
  }
  return removed;
}

function normalizeHash(h) {
  return String(h || '').toLowerCase().trim();
}

function isDenied(hash) {
  const h = normalizeHash(hash);
  if (!h) return false;
  const entry = loadAll().entries[h];
  return !!(entry && isFresh(entry));
}

// add(hash, title, reason?) — reason picks the TTL:
//   '451'           → hard (RD_DENYLIST_TTL_DAYS, default 30 days)
//   'unresolvable'  → soft (RD_SOFT_DENYLIST_HOURS, default 24 hours)
//   omitted         → hard (safe default)
// If a fresh entry already exists, we only OVERWRITE it when promoting from a
// soft reason to a hard one (so a hash that later 451s gets the longer TTL),
// never the other way around (so a hard-blocked hash isn't softened by a
// subsequent transient 'unresolvable').
function add(hash, title, reason) {
  const h = normalizeHash(hash);
  if (!h) return false;
  const r = reason || '451';
  const state = loadAll();
  const existing = state.entries[h];
  if (existing && isFresh(existing)) {
    const existingIsHard = (existing.reason || '451') === '451';
    const newIsHard = r === '451';
    if (existingIsHard || !newIsHard) return false; // keep existing
  }
  state.entries[h] = {
    ts: Date.now(),
    reason: r,
    lastTitle: title ? String(title).slice(0, 200) : undefined,
  };
  pruneExpired(state);
  saveAll(state);
  return true;
}

// For batch lookups when building stream rows — avoid loading the file once
// per candidate. Returns a Set of denied hashes (lowercase).
function loadDeniedSet() {
  const state = loadAll();
  const set = new Set();
  for (const k of Object.keys(state.entries)) {
    if (isFresh(state.entries[k])) set.add(k);
  }
  return set;
}

function stats() {
  const state = loadAll();
  const ids = Object.keys(state.entries);
  let fresh = 0, hard = 0, soft = 0;
  for (const id of ids) {
    const e = state.entries[id];
    if (!isFresh(e)) continue;
    fresh++;
    if ((e.reason || '451') === '451') hard++; else soft++;
  }
  return {
    total: ids.length,
    fresh,
    stale: ids.length - fresh,
    hard,
    soft,
    updatedAt: state.updatedAt,
    file: FILE,
    ttlDays: TTL_MS / 86400000,
    softTtlHours: SOFT_TTL_MS / 3600000,
  };
}

module.exports = { isDenied, add, loadDeniedSet, stats, FILE, TTL_MS, SOFT_TTL_MS };
