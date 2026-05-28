// Persistent stream-candidate cache.
//
// What lives here: the merged *candidate torrents* for an
// event (title/infoHash/size/seeders/magnet/etc), keyed by event ID. This is
// the expensive, user-agnostic part of stream resolution — the indexer
// search. Caching it means repeat requests (and every user) skip the live
// search, and scripts/refresh-streams.js can warm it proactively.
//
// What does NOT live here: resolved debrid streams. Those are per-user and
// short-lived, so they stay in the in-memory cache in lib/streams.js.
//
// On-disk shape (data/stream-cache.json), same atomic tmp+rename pattern as
// users.json / events.json:
//   { updatedAt, entries: { "<eventId>": { ts, candidates: [ ... ] } } }

const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = config.streamCache.file;
const TTL_MS = Math.max(0, config.streamCache.ttlHours) * 60 * 60 * 1000;
const EMPTY_TTL_MS = Math.max(0, config.streamCache.emptyTtlMinutes || 0) * 60 * 1000;

function loadAll() {
  try {
    if (!fs.existsSync(FILE)) return { updatedAt: null, entries: {} };
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j || typeof j !== 'object') return { updatedAt: null, entries: {} };
    if (!j.entries) j.entries = {};
    return j;
  } catch (err) {
    console.error('[streamcache] failed to load:', err.message);
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

// Empty entries use the shorter EMPTY_TTL_MS; populated entries use TTL_MS.
// A ttl of <= 0 means "never expire" for that class of entry.
function isFresh(entry) {
  if (!entry || !entry.ts) return false;
  const ttl = entry.empty ? EMPTY_TTL_MS : TTL_MS;
  if (ttl <= 0) return true;
  return (Date.now() - entry.ts) < ttl;
}

// Cached candidates for an event ID if present AND fresh; else null.
function get(eventId) {
  if (!eventId) return null;
  const entry = loadAll().entries[eventId];
  if (!entry || !isFresh(entry)) return null;
  return Array.isArray(entry.candidates) ? entry.candidates : null;
}

function put(eventId, candidates) {
  if (!eventId) return;
  const list = Array.isArray(candidates) ? candidates : [];
  const state = loadAll();
  state.entries[eventId] = {
    ts: Date.now(),
    empty: list.length === 0,
    candidates: list,
  };
  saveAll(state);
}

// Drop entries whose event ID is not in keepIds (events that aged out of the
// metadata window) so the file does not grow without bound. Returns count.
function prune(keepIds) {
  const keep = new Set(keepIds || []);
  const state = loadAll();
  let removed = 0;
  for (const id of Object.keys(state.entries)) {
    if (!keep.has(id)) { delete state.entries[id]; removed++; }
  }
  if (removed > 0) saveAll(state);
  return removed;
}

function stats() {
  const state = loadAll();
  const ids = Object.keys(state.entries);
  let fresh = 0;
  for (const id of ids) if (isFresh(state.entries[id])) fresh++;
  return {
    total: ids.length,
    fresh,
    stale: ids.length - fresh,
    updatedAt: state.updatedAt,
    file: FILE,
    ttlHours: TTL_MS / 3600000,
  };
}

module.exports = { get, put, prune, stats, isFresh, FILE, TTL_MS };
