'use strict';

// Persistent, encrypted candidate references for deferred playback providers.
// Stream rows contain only a random id; sensitive provider payloads (notably a
// Newznab download URL carrying an API key) stay server-side.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cryptoKeys = require('./crypto-keys');

const DEFAULT_FILE = process.env.PLAYBACK_CANDIDATES_FILE || './data/playback-candidates.json';
const DEFAULT_TTL_MS = Math.max(5,
  parseInt(process.env.RESOLVE_URL_TTL_MINUTES || '240', 10)) * 60 * 1000;
const MAX_ENTRIES = Math.max(100, parseInt(process.env.PLAYBACK_CANDIDATES_MAX || '5000', 10));

function createCandidateStore(options) {
  const opts = options || {};
  const file = opts.file || DEFAULT_FILE;
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
  const maxEntries = Number(opts.maxEntries) > 0 ? Number(opts.maxEntries) : MAX_ENTRIES;

  function load() {
    try {
      if (!fs.existsSync(file)) return { version: 1, entries: {} };
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object') {
        return { version: 1, entries: {} };
      }
      return parsed;
    } catch (error) {
      console.error('[playback-candidates] load failed:', error.message);
      return { version: 1, entries: {} };
    }
  }

  function save(state) {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function pruneState(state, now) {
    const timestamp = Number(now) || Date.now();
    for (const [id, entry] of Object.entries(state.entries || {})) {
      if (!entry || Number(entry.expiresAt) <= timestamp) delete state.entries[id];
    }
    const remaining = Object.entries(state.entries || {});
    if (remaining.length > maxEntries) {
      remaining.sort((a, b) => Number(a[1].createdAt) - Number(b[1].createdAt));
      for (const [id] of remaining.slice(0, remaining.length - maxEntries)) {
        delete state.entries[id];
      }
    }
    return state;
  }

  function put(input) {
    const item = input || {};
    if (!item.userId || !item.eventId || !item.provider || !item.payload) {
      throw new TypeError('candidate requires userId, eventId, provider, and payload');
    }
    const now = Date.now();
    const state = pruneState(load(), now);
    const id = crypto.randomBytes(18).toString('base64url');
    const payload = cryptoKeys.encrypt(JSON.stringify(item.payload));
    state.entries[id] = {
      userId: String(item.userId),
      eventId: String(item.eventId),
      provider: String(item.provider).toLowerCase(),
      createdAt: now,
      expiresAt: now + (Number(item.ttlMs) > 0 ? Number(item.ttlMs) : ttlMs),
      payload,
    };
    pruneState(state, now);
    save(state);
    return { id, expiresAt: state.entries[id].expiresAt };
  }

  function get(input) {
    const query = input || {};
    const state = load();
    const entry = state.entries && state.entries[String(query.id || '')];
    if (!entry) return { ok: false, reason: 'not-found' };
    if (Number(entry.expiresAt) <= Date.now()) {
      delete state.entries[String(query.id || '')];
      save(state);
      return { ok: false, reason: 'expired' };
    }
    if (String(entry.userId) !== String(query.userId || '')) {
      return { ok: false, reason: 'wrong-user' };
    }
    if (String(entry.eventId) !== String(query.eventId || '')) {
      return { ok: false, reason: 'wrong-event' };
    }
    if (String(entry.provider) !== String(query.provider || '').toLowerCase()) {
      return { ok: false, reason: 'wrong-provider' };
    }
    try {
      const decoded = cryptoKeys.decrypt(entry.payload);
      const payload = JSON.parse(decoded);
      return {
        ok: true,
        candidate: {
          id: String(query.id),
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          payload,
        },
      };
    } catch (_) {
      return { ok: false, reason: 'invalid-payload' };
    }
  }

  function updatePayload(input) {
    const query = input || {};
    const found = get(query);
    if (!found.ok) return found;
    const nextPayload = typeof query.update === 'function'
      ? query.update(found.candidate.payload)
      : query.payload;
    if (!nextPayload || typeof nextPayload !== 'object') {
      throw new TypeError('candidate update requires an object payload');
    }
    const state = load();
    const entry = state.entries && state.entries[String(query.id || '')];
    if (!entry) return { ok: false, reason: 'not-found' };
    entry.payload = cryptoKeys.encrypt(JSON.stringify(nextPayload));
    save(state);
    return Object.assign({}, found, {
      candidate: Object.assign({}, found.candidate, { payload: nextPayload }),
    });
  }

  function prune() {
    const state = pruneState(load(), Date.now());
    save(state);
    return Object.keys(state.entries).length;
  }

  return Object.freeze({ put, get, updatePayload, prune, file });
}

const defaultStore = createCandidateStore();

module.exports = {
  createCandidateStore,
  put: defaultStore.put,
  get: defaultStore.get,
  updatePayload: defaultStore.updatePayload,
  prune: defaultStore.prune,
  DEFAULT_FILE,
  DEFAULT_TTL_MS,
};
