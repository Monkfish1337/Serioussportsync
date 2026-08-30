'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('../config');
const cryptoKeys = require('./crypto-keys');
const { classifyReleasePart } = require('./release-parts');

const SCHEMA_VERSION = 1;
const DEFAULT_FILE = config.availabilityDbFile || './data/availability.sqlite';
const SEARCH_TTLS = Object.freeze({
  torrent: hours(process.env.AVAILABILITY_TORRENT_TTL_HOURS, 6),
  uu: hours(process.env.AVAILABILITY_USENET_TTL_HOURS, 12),
  'native-indexer': hours(process.env.AVAILABILITY_USENET_TTL_HOURS, 12),
  easynews: hours(process.env.AVAILABILITY_EASYNEWS_TTL_HOURS, 12),
});
const NEGATIVE_TTL_MS = minutes(process.env.AVAILABILITY_NEGATIVE_TTL_MINUTES, 30);
const OBSERVATION_TTLS = Object.freeze({
  cached: hours(process.env.AVAILABILITY_TORBOX_TTL_HOURS, 6),
  unavailable: minutes(process.env.AVAILABILITY_NEGATIVE_TTL_MINUTES, 30),
  discovered: hours(process.env.AVAILABILITY_DISCOVERED_TTL_HOURS, 12),
  verified: hours(process.env.AVAILABILITY_VERIFIED_TTL_HOURS, 24),
  failed: minutes(process.env.AVAILABILITY_FAILURE_TTL_MINUTES, 15),
  historical: 0,
});
const RETENTION_MS = days(process.env.AVAILABILITY_RETENTION_DAYS, 30);
const parsedMaxResults = Number.parseInt(process.env.AVAILABILITY_MAX_RESULTS_PER_SEARCH || '', 10);
const MAX_RESULTS_PER_SEARCH = Number.isFinite(parsedMaxResults)
  ? Math.max(100, parsedMaxResults)
  : 2000;

function hours(value, fallback) {
  return Math.max(1, Number(value) || fallback) * 60 * 60 * 1000;
}
function minutes(value, fallback) {
  return Math.max(1, Number(value) || fallback) * 60 * 1000;
}
function days(value, fallback) {
  return Math.max(1, Number(value) || fallback) * 24 * 60 * 60 * 1000;
}
function sha(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}
function cleanScope(value) {
  return String(value || 'global').trim() || 'global';
}

function createAvailabilityIndex(options) {
  const opts = options || {};
  const file = opts.file || DEFAULT_FILE;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  if (file !== ':memory:') {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(file);
  if (file !== ':memory:') {
    try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort on Windows */ }
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const existingSchema = db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version');
  const existingVersion = Number(existingSchema && existingSchema.value) || 0;
  if (existingVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error('availability database schema ' + existingVersion
      + ' is newer than supported schema ' + SCHEMA_VERSION);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS releases (
      id TEXT PRIMARY KEY,
      identity_kind TEXT NOT NULL,
      identity_value TEXT NOT NULL,
      title TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      published_at TEXT,
      indexer TEXT,
      quality TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS releases_identity
      ON releases(identity_kind, identity_value);
    CREATE TABLE IF NOT EXISTS search_runs (
      search_key TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      promotion_id TEXT,
      provider TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      searched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS search_runs_event
      ON search_runs(event_id, provider, scope_hash, expires_at);
    CREATE TABLE IF NOT EXISTS event_releases (
      event_id TEXT NOT NULL,
      release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      card_part TEXT NOT NULL DEFAULT 'unknown',
      match_score REAL NOT NULL DEFAULT 0,
      payload_enc TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY(event_id, release_id, provider, scope_hash)
    );
    CREATE INDEX IF NOT EXISTS event_releases_lookup
      ON event_releases(event_id, provider, scope_hash, last_seen_at);
    CREATE TABLE IF NOT EXISTS search_results (
      search_key TEXT NOT NULL REFERENCES search_runs(search_key) ON DELETE CASCADE,
      release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY(search_key, release_id)
    );
    CREATE INDEX IF NOT EXISTS search_results_order
      ON search_results(search_key, position);
    CREATE TABLE IF NOT EXISTS availability (
      release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      observed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_success_at INTEGER,
      last_error TEXT,
      PRIMARY KEY(release_id, provider, scope_hash)
    );
    CREATE INDEX IF NOT EXISTS availability_fresh
      ON availability(provider, scope_hash, expires_at);
    CREATE TABLE IF NOT EXISTS counters (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('schema_version', String(SCHEMA_VERSION));

  const increment = db.prepare(`
    INSERT INTO counters(key,value) VALUES (?,1)
    ON CONFLICT(key) DO UPDATE SET value=value+1
  `);
  const findRelease = db.prepare('SELECT id FROM releases WHERE identity_kind=? AND identity_value=?');
  const upsertRelease = db.prepare(`
    INSERT INTO releases(id,identity_kind,identity_value,title,size_bytes,published_at,indexer,quality,first_seen_at,last_seen_at)
    VALUES (@id,@identityKind,@identityValue,@title,@size,@publishedAt,@indexer,@quality,@timestamp,@timestamp)
    ON CONFLICT(id) DO UPDATE SET
      title=CASE
        WHEN excluded.title='' OR excluded.title=excluded.identity_value THEN releases.title
        ELSE excluded.title
      END,
      size_bytes=CASE WHEN excluded.size_bytes > 0 THEN excluded.size_bytes ELSE releases.size_bytes END,
      published_at=COALESCE(excluded.published_at,releases.published_at),
      indexer=COALESCE(excluded.indexer,releases.indexer),
      quality=COALESCE(excluded.quality,releases.quality),
      last_seen_at=excluded.last_seen_at
  `);

  function scopeFingerprint(provider, values) {
    const secret = String(opts.secret || config.sessionSecret || process.env.SESSION_SECRET || '');
    if (secret.length < 32 && process.env.ALLOW_INSECURE_SECRET !== '1') {
      throw new Error('SESSION_SECRET must be at least 32 characters');
    }
    return crypto.createHmac('sha256', secret || 'explicit-insecure-dev-availability')
      .update(normalizeProvider(provider) + '\n' + JSON.stringify(stable(values || {})))
      .digest('hex');
  }

  function candidateIdentity(candidate) {
    const item = candidate || {};
    const infoHash = String(item.infoHash || '').toLowerCase();
    if (/^[a-f0-9]{40}$/.test(infoHash)) {
      return { kind: 'torrent', value: infoHash };
    }
    const postHash = String(item.postHash || '').trim();
    if (postHash) return { kind: 'easynews', value: sha(postHash) };
    const nzbUrl = String(item.nzbUrl || '').trim();
    if (nzbUrl) return { kind: 'nzb', value: scopeFingerprint('nzb-identity', { url: nzbUrl }) };
    const fallback = {
      title: String(item.title || ''), size: Number(item.size) || 0,
      publishedAt: item.publishedAt || item.publishDate || null,
    };
    return { kind: 'metadata', value: sha(JSON.stringify(fallback)) };
  }

  function releaseId(candidate) {
    const identity = candidateIdentity(candidate);
    const existing = findRelease.get(identity.kind, identity.value);
    return existing ? existing.id : sha(identity.kind + ':' + identity.value);
  }

  function searchKey(input) {
    const item = input || {};
    const provider = normalizeProvider(item.provider);
    const scope = cleanScope(item.scope);
    const queries = Array.from(new Set((item.queries || [])
      .map((value) => String(value || '').trim()).filter(Boolean)));
    const queryHash = sha(JSON.stringify(queries));
    return {
      key: sha([String(item.eventId || ''), provider, scope, queryHash].join('|')),
      queryHash,
    };
  }

  function getSearch(input) {
    const identity = searchKey(input);
    const run = db.prepare('SELECT * FROM search_runs WHERE search_key=?').get(identity.key);
    if (!run || Number(run.expires_at) <= now()) {
      increment.run('search_misses');
      return { hit: false, results: [], searchKey: identity.key };
    }
    const rows = db.prepare(`
      SELECT er.payload_enc
      FROM search_results sr
      JOIN event_releases er ON er.release_id=sr.release_id
        AND er.event_id=? AND er.provider=? AND er.scope_hash=?
      WHERE sr.search_key=?
      ORDER BY sr.position ASC
    `).all(String(input.eventId || ''), normalizeProvider(input.provider), cleanScope(input.scope), identity.key);
    const results = [];
    for (const row of rows) {
      try { results.push(JSON.parse(cryptoKeys.decrypt(row.payload_enc))); }
      catch (_) { /* corrupted rows are ignored and refreshed after expiry */ }
    }
    if (results.length !== Number(run.result_count)) {
      db.prepare('DELETE FROM search_runs WHERE search_key=?').run(identity.key);
      increment.run('search_misses');
      return { hit: false, results: [], searchKey: identity.key };
    }
    increment.run('search_hits');
    return {
      hit: true,
      results,
      searchKey: identity.key,
      searchedAt: run.searched_at,
      expiresAt: run.expires_at,
    };
  }

  const recordSearchTransaction = db.transaction((input) => {
    const timestamp = now();
    const provider = normalizeProvider(input.provider);
    const scope = cleanScope(input.scope);
    const identity = searchKey(input);
    const candidates = (Array.isArray(input.results) ? input.results : [])
      .slice(0, MAX_RESULTS_PER_SEARCH);
    const ttlMs = Number(input.ttlMs) > 0
      ? Number(input.ttlMs)
      : (candidates.length ? (SEARCH_TTLS[provider] || hours(null, 6)) : NEGATIVE_TTL_MS);
    db.prepare(`
      INSERT INTO search_runs(search_key,event_id,promotion_id,provider,scope_hash,query_hash,result_count,searched_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(search_key) DO UPDATE SET
        promotion_id=excluded.promotion_id,result_count=excluded.result_count,
        searched_at=excluded.searched_at,expires_at=excluded.expires_at
    `).run(identity.key, String(input.eventId || ''), String(input.promotionId || ''), provider,
      scope, identity.queryHash, candidates.length, timestamp, timestamp + ttlMs);
    db.prepare('DELETE FROM search_results WHERE search_key=?').run(identity.key);
    const relation = db.prepare(`
      INSERT INTO event_releases(event_id,release_id,provider,scope_hash,card_part,match_score,payload_enc,first_seen_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(event_id,release_id,provider,scope_hash) DO UPDATE SET
        card_part=excluded.card_part,match_score=excluded.match_score,
        payload_enc=excluded.payload_enc,last_seen_at=excluded.last_seen_at
    `);
    const resultLink = db.prepare('INSERT INTO search_results(search_key,release_id,position) VALUES (?,?,?)');
    candidates.forEach((candidate, position) => {
      const itemIdentity = candidateIdentity(candidate);
      const id = releaseId(candidate);
      const title = String(candidate.title || '').trim().slice(0, 500);
      upsertRelease.run({
        id, identityKind: itemIdentity.kind, identityValue: itemIdentity.value,
        title, size: Math.max(0, Number(candidate.size) || 0),
        publishedAt: candidate.publishedAt || candidate.publishDate || null,
        indexer: candidate.indexer ? String(candidate.indexer).slice(0, 120) : null,
        quality: candidate.quality ? String(candidate.quality).slice(0, 40) : null,
        timestamp,
      });
      relation.run(String(input.eventId || ''), id, provider, scope,
        classifyReleasePart(title), Number(candidate.matchScore) || 0,
        cryptoKeys.encrypt(JSON.stringify(candidate)), timestamp, timestamp);
      resultLink.run(identity.key, id, position);
      observe({ provider, scope, state: 'discovered', candidate });
    });
    return { searchKey: identity.key, resultCount: candidates.length, expiresAt: timestamp + ttlMs };
  });

  function recordSearch(input) {
    const result = recordSearchTransaction(input || {});
    increment.run('search_writes');
    return result;
  }

  function availabilityFor(input) {
    const provider = normalizeProvider(input && input.provider);
    const scope = cleanScope(input && input.scope);
    const output = new Map();
    const statement = db.prepare(`
      SELECT a.state,a.confidence,a.observed_at,a.expires_at,a.last_success_at
      FROM availability a
      JOIN releases r ON r.id=a.release_id
      WHERE r.identity_kind=? AND r.identity_value=?
        AND a.provider=? AND a.scope_hash=? AND a.expires_at>?
    `);
    for (const candidate of (input && input.candidates) || []) {
      const identity = candidateIdentity(candidate);
      const row = statement.get(identity.kind, identity.value, provider, scope, now());
      if (row) output.set(releaseId(candidate), row);
    }
    return output;
  }

  const observeStatement = db.prepare(`
    INSERT INTO availability(release_id,provider,scope_hash,state,confidence,observed_at,expires_at,last_success_at,last_error)
    VALUES (@releaseId,@provider,@scope,@state,@confidence,@observedAt,@expiresAt,@lastSuccessAt,@lastError)
    ON CONFLICT(release_id,provider,scope_hash) DO UPDATE SET
      state=excluded.state,confidence=excluded.confidence,observed_at=excluded.observed_at,
      expires_at=excluded.expires_at,
      last_success_at=COALESCE(excluded.last_success_at,availability.last_success_at),
      last_error=excluded.last_error
  `);

  function observe(input) {
    const item = input || {};
    const candidate = item.candidate || {};
    const timestamp = Number(item.observedAt) || now();
    const state = String(item.state || 'discovered').toLowerCase();
    const identity = candidateIdentity(candidate);
    const id = releaseId(candidate);
    upsertRelease.run({
      id, identityKind: identity.kind, identityValue: identity.value,
      title: String(candidate.title || item.title || identity.value).slice(0, 500),
      size: Math.max(0, Number(candidate.size) || 0),
      publishedAt: candidate.publishedAt || candidate.publishDate || null,
      indexer: candidate.indexer ? String(candidate.indexer).slice(0, 120) : null,
      quality: candidate.quality ? String(candidate.quality).slice(0, 40) : null,
      timestamp,
    });
    const ttlMs = Number(item.ttlMs) >= 0
      ? Number(item.ttlMs) : (OBSERVATION_TTLS[state] == null ? hours(null, 6) : OBSERVATION_TTLS[state]);
    observeStatement.run({
      releaseId: id,
      provider: normalizeProvider(item.provider),
      scope: cleanScope(item.scope),
      state,
      confidence: Number(item.confidence) || (state === 'verified' ? 1 : state === 'cached' ? 0.9 : 0.5),
      observedAt: timestamp,
      expiresAt: ttlMs === 0 ? 0 : timestamp + ttlMs,
      lastSuccessAt: ['verified', 'cached', 'historical'].includes(state) ? timestamp : null,
      lastError: item.error ? String(item.error).slice(0, 200) : null,
    });
    increment.run('availability_writes');
    return id;
  }

  function prune() {
    const cutoff = now() - RETENTION_MS;
    return db.transaction(() => {
      const searches = db.prepare('DELETE FROM search_runs WHERE expires_at<?').run(cutoff).changes;
      const observations = db.prepare('DELETE FROM availability WHERE expires_at>0 AND expires_at<?').run(cutoff).changes;
      const matches = db.prepare(`
        DELETE FROM event_releases
        WHERE last_seen_at<? AND NOT EXISTS (
          SELECT 1 FROM search_results sr WHERE sr.release_id=event_releases.release_id
        )
      `).run(cutoff).changes;
      const releases = db.prepare(`
        DELETE FROM releases WHERE last_seen_at<?
          AND NOT EXISTS (SELECT 1 FROM event_releases er WHERE er.release_id=releases.id)
          AND NOT EXISTS (SELECT 1 FROM availability a WHERE a.release_id=releases.id)
      `).run(cutoff).changes;
      return { searches, observations, matches, releases };
    })();
  }

  function migratePositiveCache(positiveCacheFile) {
    if (!positiveCacheFile || !fs.existsSync(positiveCacheFile)) return { imported: 0 };
    const marker = db.prepare('SELECT value FROM meta WHERE key=?').get('positive_cache_imported_v1');
    if (marker) return { imported: 0, alreadyImported: true };
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(positiveCacheFile, 'utf8')); }
    catch (_) { return { imported: 0, invalid: true }; }
    let imported = 0;
    db.transaction(() => {
      for (const [hash, providers] of Object.entries(parsed.entries || {})) {
        if (!/^[a-f0-9]{40}$/i.test(hash)) continue;
        for (const [legacyProvider, entry] of Object.entries(providers || {})) {
          const provider = ({ tb: 'torbox', rd: 'realdebrid', pm: 'premiumize' })[legacyProvider] || legacyProvider;
          observe({
            provider, scope: 'legacy-history', state: 'historical', ttlMs: 0,
            observedAt: Number(entry && entry.ts) || now(),
            candidate: { infoHash: hash, title: entry && entry.lastTitle || hash },
          });
          imported++;
        }
      }
      db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('positive_cache_imported_v1', String(now()));
    })();
    return { imported };
  }

  function stats() {
    const scalar = (sql, params) => Number(db.prepare(sql).pluck().get(...(params || []))) || 0;
    const counters = Object.fromEntries(db.prepare('SELECT key,value FROM counters').all().map((row) => [row.key, row.value]));
    const byProvider = Object.fromEntries(db.prepare(`
      SELECT provider,COUNT(*) count FROM availability
      WHERE expires_at=0 OR expires_at>? GROUP BY provider ORDER BY provider
    `).all(now()).map((row) => [row.provider, row.count]));
    const hits = Number(counters.search_hits) || 0;
    const misses = Number(counters.search_misses) || 0;
    return {
      file,
      schemaVersion: SCHEMA_VERSION,
      releases: scalar('SELECT COUNT(*) FROM releases'),
      eventMatches: scalar('SELECT COUNT(*) FROM event_releases'),
      freshSearches: scalar('SELECT COUNT(*) FROM search_runs WHERE expires_at>?', [now()]),
      freshObservations: scalar('SELECT COUNT(*) FROM availability WHERE expires_at=0 OR expires_at>?', [now()]),
      searchHits: hits,
      searchMisses: misses,
      hitRate: hits + misses ? hits / (hits + misses) : 0,
      byProvider,
    };
  }

  function recentSearches(limit) {
    const maximum = Math.max(1, Math.min(100, Number(limit) || 25));
    return db.prepare(`
      SELECT event_id eventId,promotion_id promotionId,provider,result_count resultCount,
             searched_at searchedAt,expires_at expiresAt
      FROM search_runs ORDER BY searched_at DESC LIMIT ?
    `).all(maximum);
  }

  function wipe() {
    db.transaction(() => {
      db.prepare('DELETE FROM search_runs').run();
      db.prepare('DELETE FROM availability').run();
      db.prepare('DELETE FROM event_releases').run();
      db.prepare('DELETE FROM releases').run();
      db.prepare('DELETE FROM counters').run();
    })();
  }

  return Object.freeze({
    availabilityFor,
    candidateIdentity,
    checkpoint: () => db.pragma('wal_checkpoint(TRUNCATE)'),
    close: () => db.close(),
    getSearch,
    migratePositiveCache,
    observe,
    prune,
    recentSearches,
    recordSearch,
    releaseId,
    scopeFingerprint,
    searchKey,
    stats,
    wipe,
  });
}

let defaultIndex;
function getDefault() {
  if (!defaultIndex) defaultIndex = createAvailabilityIndex();
  return defaultIndex;
}

module.exports = {
  createAvailabilityIndex,
  getDefault,
  DEFAULT_FILE,
  NEGATIVE_TTL_MS,
  SCHEMA_VERSION,
  SEARCH_TTLS,
};
