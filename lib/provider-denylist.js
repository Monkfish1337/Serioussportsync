// Provider-failure denylist factory (0.23.1).
//
// Generalisation of the original 0.22.1 / 0.22.3 RD-only denylist. Any provider
// (RD, TB, PM, …) can spin up its own instance — same on-disk shape, same
// dual-TTL semantics — so failures from any provider stop cluttering future
// stream rows for that hash, not just RD failures.
//
// Each provider stores its own JSON file in data/ so a TB failure can't
// accidentally pin RD out (and vice versa) and so the per-provider log line
// in streams.js can attribute skips correctly. The hard/soft semantics are
// the same as the original rd-denylist:
//   - reason '451'         → hard TTL  (default 30 days, for confirmed
//                            content blocks that won't reverse quickly)
//   - reason 'unresolvable'→ soft TTL  (default 24 hours, for "not cached"
//                            that may recover if someone else seeds it)
//   - omitted              → hard TTL  (safe default)
//
// Promotion: soft entries can be UPGRADED to hard if the same hash later
// gets a hard reason. Hard entries cannot be DEMOTED by a transient soft.

const fs = require('fs');
const path = require('path');

function createDenylist(opts) {
  const FILE = opts.file;
  const TTL_MS = Math.max(0, opts.hardTtlMs || 0);
  const SOFT_TTL_MS = Math.max(0, opts.softTtlMs || 0);
  const LOG_TAG = opts.logTag || 'denylist';

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
      console.error('[' + LOG_TAG + '] failed to load:', err.message);
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

  function pruneExpired(state) {
    let removed = 0;
    for (const k of Object.keys(state.entries)) {
      if (!isFresh(state.entries[k])) { delete state.entries[k]; removed++; }
    }
    return removed;
  }

  function normalizeHash(h) { return String(h || '').toLowerCase().trim(); }

  function isDenied(hash) {
    const h = normalizeHash(hash);
    if (!h) return false;
    const entry = loadAll().entries[h];
    return !!(entry && isFresh(entry));
  }

  function add(hash, title, reason) {
    const h = normalizeHash(hash);
    if (!h) return false;
    const r = reason || '451';
    const state = loadAll();
    const existing = state.entries[h];
    if (existing && isFresh(existing)) {
      const existingIsHard = (existing.reason || '451') === '451';
      const newIsHard = r === '451';
      if (existingIsHard || !newIsHard) return false;
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
      fresh, stale: ids.length - fresh, hard, soft,
      updatedAt: state.updatedAt,
      file: FILE,
      ttlDays: TTL_MS / 86400000,
      softTtlHours: SOFT_TTL_MS / 3600000,
    };
  }

  return { isDenied, add, loadDeniedSet, stats, FILE, TTL_MS, SOFT_TTL_MS };
}

module.exports = { createDenylist };
