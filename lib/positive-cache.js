// Positive resolve cache (0.24.0).
//
// Counterpart to the per-provider denylists. When a play-time resolve actually
// SUCCEEDS (we got a playable URL from the provider for this hash), we record
// it here. The row builder treats positive-cached (hash, provider) pairs as
// authoritative-cached on the next /stream request and advertises with
// confidence — same effective status as a warmer-verified hit.
//
// This is particularly valuable for Real-Debrid, where the API doesn't permit
// a non-destructive cache check (instantAvailability was deprecated in 2024)
// and the warmer can't pre-verify. A successful click becomes a reliable
// signal for future advertise decisions.
//
// On-disk shape (data/positive-cache.json):
//   {
//     "updatedAt": "...",
//     "entries": {
//       "<lowercaseHash>": {
//         "rd": { "ts": ..., "lastTitle": "..." },
//         "tb": { "ts": ... },
//         "pm": { "ts": ... }
//       }
//     }
//   }
//
// Each (hash, provider) entry has its own ts so a hash cached on RD doesn't
// expire just because TB's record is fresh. Default TTL is 7 days — short
// enough that a hash later evicted from a provider's cache stops appearing
// as positive-cached, long enough to dramatically reduce wasted RD clicks
// on repeat searches of the same event.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = (config.positiveCache && config.positiveCache.file) || './data/positive-cache.json';
const TTL_MS = Math.max(0, (config.positiveCache && config.positiveCache.ttlDays) || 7) * 24 * 60 * 60 * 1000;

function loadAll() {
  try {
    if (!fs.existsSync(FILE)) return { updatedAt: null, entries: {} };
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j || typeof j !== 'object') return { updatedAt: null, entries: {} };
    if (!j.entries) j.entries = {};
    return j;
  } catch (err) {
    console.error('[positive-cache] failed to load:', err.message);
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

function isFreshTs(ts) {
  if (!ts) return false;
  if (TTL_MS <= 0) return true;
  return (Date.now() - ts) < TTL_MS;
}

function pruneExpired(state) {
  let removed = 0;
  for (const h of Object.keys(state.entries)) {
    const providers = state.entries[h];
    for (const p of Object.keys(providers)) {
      if (!isFreshTs(providers[p].ts)) { delete providers[p]; removed++; }
    }
    if (Object.keys(providers).length === 0) delete state.entries[h];
  }
  return removed;
}

function normalizeHash(h) { return String(h || '').toLowerCase().trim(); }
function normalizeProv(p) { return String(p || '').toLowerCase().trim(); }

function isCached(hash, providerCode) {
  const h = normalizeHash(hash);
  const p = normalizeProv(providerCode);
  if (!h || !p) return false;
  const e = loadAll().entries[h];
  return !!(e && e[p] && isFreshTs(e[p].ts));
}

function record(hash, providerCode, title) {
  const h = normalizeHash(hash);
  const p = normalizeProv(providerCode);
  if (!h || !p) return false;
  const state = loadAll();
  if (!state.entries[h]) state.entries[h] = {};
  state.entries[h][p] = {
    ts: Date.now(),
    lastTitle: title ? String(title).slice(0, 200) : undefined,
  };
  pruneExpired(state);
  saveAll(state);
  return true;
}

// For batch lookups when building stream rows — avoid loading the file per
// candidate × provider. Returns a Set of "hash:provider" strings (lowercase).
function loadCachedSet() {
  const state = loadAll();
  const set = new Set();
  for (const h of Object.keys(state.entries)) {
    for (const p of Object.keys(state.entries[h])) {
      if (isFreshTs(state.entries[h][p].ts)) set.add(h + ':' + p);
    }
  }
  return set;
}

function wipe() { saveAll({ entries: {} }); }

function stats() {
  const state = loadAll();
  let totalHashes = 0, freshEntries = 0;
  const byProvider = {};
  for (const h of Object.keys(state.entries)) {
    totalHashes++;
    for (const p of Object.keys(state.entries[h])) {
      if (isFreshTs(state.entries[h][p].ts)) {
        freshEntries++;
        byProvider[p] = (byProvider[p] || 0) + 1;
      }
    }
  }
  return {
    totalHashes,
    freshEntries,
    byProvider,
    updatedAt: state.updatedAt,
    file: FILE,
    ttlDays: TTL_MS / 86400000,
  };
}

module.exports = { isCached, record, loadCachedSet, wipe, stats, FILE, TTL_MS };
