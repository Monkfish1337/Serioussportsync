'use strict';

process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'availability-test-secret-000000000000000000000000000000';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createAvailabilityIndex } = require('../lib/availability-index');
const { classifyReleasePart } = require('../lib/release-parts');
const { _test: streamInternals } = require('../lib/streams');

function temporaryIndex(start) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-availability-'));
  let timestamp = start || 1_800_000_000_000;
  const index = createAvailabilityIndex({
    file: path.join(dir, 'availability.sqlite'),
    secret: process.env.SESSION_SECRET,
    now: () => timestamp,
  });
  return {
    index,
    advance(ms) { timestamp += ms; },
    // close() before rmSync, and retries after: Windows refuses to unlink a
    // file whose handle is still open, and can hold one briefly even after.
    close() { index.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  };
}

test('stores encrypted reusable searches and isolates provider scopes', () => {
  const fixture = temporaryIndex();
  try {
    const a = fixture.index.scopeFingerprint('easynews', { username: 'a', password: 'secret-a' });
    const b = fixture.index.scopeFingerprint('easynews', { username: 'b', password: 'secret-b' });
    const input = {
      eventId: 'ufc:300', promotionId: 'ufc', provider: 'easynews', scope: a,
      queries: ['UFC 300'],
      results: [{ title: 'UFC.300.Main.Card.1080p', postHash: 'post-1', size: 1234, dlFarm: 'farm' }],
    };
    fixture.index.recordSearch(input);
    assert.equal(fixture.index.recordSearchOutcome({
      eventId: input.eventId, provider: input.provider, scope: input.scope,
      matchedCount: 2, readyCount: 1,
    }), 1);
    assert.deepEqual(fixture.index.recentSearches(1).map((row) => ({
      eventId: row.eventId, provider: row.provider, resultCount: row.resultCount,
      matchedCount: row.matchedCount, readyCount: row.readyCount,
    })), [{ eventId: 'ufc:300', provider: 'easynews', resultCount: 1,
      matchedCount: 2, readyCount: 1 }]);
    const hit = fixture.index.getSearch(input);
    assert.equal(hit.hit, true);
    assert.equal(hit.results[0].postHash, 'post-1');
    assert.equal(fixture.index.getSearch(Object.assign({}, input, { scope: b })).hit, false);
    const disk = fs.readFileSync(fixture.index.stats().file);
    assert.equal(disk.includes(Buffer.from('post-1')), false);
    assert.equal(disk.includes(Buffer.from('secret-a')), false);
  } finally { fixture.close(); }
});

test('negative searches expire sooner and query changes miss safely', () => {
  const fixture = temporaryIndex();
  try {
    const input = { eventId: 'ufc:300', provider: 'uu', scope: 'scope', queries: ['UFC 300'], results: [] };
    fixture.index.recordSearch(input);
    assert.equal(fixture.index.getSearch(input).hit, true);
    assert.equal(fixture.index.getSearch(Object.assign({}, input, { queries: ['UFC 300 Main Card'] })).hit, false);
    fixture.advance(31 * 60 * 1000);
    assert.equal(fixture.index.getSearch(input).hit, false);
  } finally { fixture.close(); }
});

test('unusable cached torrent candidates are discarded and searched again', async () => {
  let invalidated = 0;
  let produced = 0;
  const index = {
    getSearch() { return { hit: true, results: [{ title: 'WWE result without a magnet hash' }] }; },
    invalidateSearch() { invalidated++; },
    searchKey() { return { key: 'torrent-test' }; },
    recordSearch() {},
  };
  const out = await streamInternals.cachedProviderSearch({
    event: { id: 'wwe:2514762' }, promo: { id: 'wwe' }, provider: 'torrent', scope: 'scope',
    queries: ['WWE Sunday Nights Main Event'], index, log() {},
    validateCachedResults: (results) => results.some((row) => /^[a-f0-9]{40}$/i.test(row.infoHash || '')),
    producer: async () => {
      produced++;
      return { ok: true, results: [{ title: 'WWE Sunday Nights Main Event', infoHash: 'f'.repeat(40) }] };
    },
  });
  assert.equal(invalidated, 1);
  assert.equal(produced, 1);
  assert.equal(out.results[0].infoHash, 'f'.repeat(40));
});

test('clears cached discoveries only for the selected promotion', () => {
  const fixture = temporaryIndex();
  try {
    const wwe = { title: 'WWE Sunday Nights Main Event 2026 09 06', infoHash: 'd'.repeat(40) };
    const ufc = { title: 'UFC 300 Main Card', infoHash: 'e'.repeat(40) };
    const wweInput = { eventId: 'wwe:2514762', promotionId: 'wwe', provider: 'torrent', scope: 'source', queries: ['WWE Sunday Nights Main Event'], results: [wwe] };
    const ufcInput = { eventId: 'ufc:300', promotionId: 'ufc', provider: 'torrent', scope: 'source', queries: ['UFC 300'], results: [ufc] };
    fixture.index.recordSearch(wweInput);
    fixture.index.recordSearch(ufcInput);
    fixture.index.observe({ provider: 'torbox', scope: 'account', state: 'unavailable', candidate: wwe });
    fixture.index.observe({ provider: 'torbox', scope: 'account', state: 'cached', candidate: ufc });

    const removed = fixture.index.clearPromotion('wwe');
    assert.equal(removed.searches, 1);
    assert.equal(removed.observations, 0,
      'shared account availability is retained so the cache clear stays lightweight');
    assert.equal(fixture.index.getSearch(wweInput).hit, false);
    assert.equal(fixture.index.getSearch(ufcInput).hit, true);
    assert.equal(fixture.index.availabilityFor({ provider: 'torbox', scope: 'account', candidates: [wwe] }).size, 1);
    assert.equal(fixture.index.availabilityFor({ provider: 'torbox', scope: 'account', candidates: [ufc] }).size, 1);
  } finally { fixture.close(); }
});

test('tracks fresh availability independently for each credential scope', () => {
  const fixture = temporaryIndex();
  try {
    const candidate = { title: 'UFC.300.1080p', infoHash: 'a'.repeat(40) };
    fixture.index.observe({ provider: 'torbox', scope: 'account-a', state: 'cached', candidate });
    assert.equal(fixture.index.availabilityFor({ provider: 'torbox', scope: 'account-a', candidates: [candidate] }).size, 1);
    assert.equal(fixture.index.availabilityFor({ provider: 'torbox', scope: 'account-b', candidates: [candidate] }).size, 0);
    fixture.advance(7 * 60 * 60 * 1000);
    assert.equal(fixture.index.availabilityFor({ provider: 'torbox', scope: 'account-a', candidates: [candidate] }).size, 0);
  } finally { fixture.close(); }
});

test('recovers only fresh confirmed event candidates from matching source and account scopes', () => {
  const fixture = temporaryIndex();
  try {
    const candidate = { title: 'UFC.300.Main.Card.1080p', infoHash: 'c'.repeat(40), size: 999 };
    fixture.index.recordSearch({
      eventId: 'ufc:300', promotionId: 'ufc', provider: 'torrent',
      scope: 'torrent-source-a', queries: ['UFC 300'], results: [candidate],
    });
    fixture.index.observe({
      provider: 'torbox', scope: 'torbox-account-a', state: 'cached', candidate,
    });
    const recovered = fixture.index.confirmedForEvent({
      eventId: 'ufc:300', sourceProvider: 'torrent', sourceScope: 'torrent-source-a',
      availabilityProvider: 'torbox', availabilityScope: 'torbox-account-a',
      states: ['cached', 'verified'],
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].candidate.infoHash, candidate.infoHash);
    assert.equal(fixture.index.confirmedForEvent({
      eventId: 'ufc:300', sourceProvider: 'torrent', sourceScope: 'torrent-source-a',
      availabilityProvider: 'torbox', availabilityScope: 'another-account',
      states: ['cached', 'verified'],
    }).length, 0);
    fixture.advance(7 * 60 * 60 * 1000);
    assert.equal(fixture.index.confirmedForEvent({
      eventId: 'ufc:300', sourceProvider: 'torrent', sourceScope: 'torrent-source-a',
      availabilityProvider: 'torbox', availabilityScope: 'torbox-account-a',
      states: ['cached', 'verified'],
    }).length, 0);
  } finally { fixture.close(); }
});

test('imports legacy positive-cache knowledge without exposing it as a scoped fresh hit', () => {
  const fixture = temporaryIndex();
  const legacy = path.join(path.dirname(fixture.index.stats().file), 'positive-cache.json');
  fs.writeFileSync(legacy, JSON.stringify({ entries: {
    ['b'.repeat(40)]: { tb: { ts: 1_799_000_000_000, lastTitle: 'UFC 299' } },
  } }));
  try {
    assert.equal(fixture.index.migratePositiveCache(legacy).imported, 1);
    assert.equal(fixture.index.migratePositiveCache(legacy).alreadyImported, true);
    const stats = fixture.index.stats();
    assert.equal(stats.releases, 1);
    assert.equal(stats.byProvider.torbox, 1);
  } finally { fixture.close(); }
});

test('classifies reusable combat-sports release parts conservatively', () => {
  assert.equal(classifyReleasePart('UFC.300.Early.Prelims.1080p'), 'early-prelims');
  assert.equal(classifyReleasePart('UFC.300.Preliminary.Card.1080p'), 'prelims');
  assert.equal(classifyReleasePart('UFC.300.Main.Card.1080p'), 'main-card');
  assert.equal(classifyReleasePart('UFC.300.Full.Event.1080p'), 'full-event');
  assert.equal(classifyReleasePart('UFC.300.1080p'), 'unknown');
});

test('stream searches reuse fresh rows and coalesce simultaneous misses', async () => {
  const fixture = temporaryIndex();
  let calls = 0;
  let releaseProducer;
  const gate = new Promise((resolve) => { releaseProducer = resolve; });
  const input = {
    event: { id: 'ufc:300' }, promo: { id: 'ufc' }, provider: 'uu',
    scope: 'scope', queries: ['UFC 300'], index: fixture.index, log: () => {},
    producer: async () => {
      calls++;
      await gate;
      return { ok: true, results: [{ title: 'UFC.300.Main.Card', nzbUrl: 'https://indexer.example/get/1' }] };
    },
  };
  try {
    const first = streamInternals.cachedProviderSearch(input);
    const second = streamInternals.cachedProviderSearch(input);
    releaseProducer();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(a.results.length, 1);
    assert.equal(b.results.length, 1);
    const third = await streamInternals.cachedProviderSearch(Object.assign({}, input, {
      producer: async () => { calls++; return { ok: true, results: [] }; },
    }));
    assert.equal(calls, 1);
    assert.equal(third.cached, true);
  } finally { fixture.close(); }
});

test('refuses to downgrade a database created by a newer SSS schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-availability-newer-'));
  const file = path.join(dir, 'availability.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('schema_version', '999');
  db.close();
  try {
    assert.throws(() => createAvailabilityIndex({
      file, secret: process.env.SESSION_SECRET,
    }), /newer than supported/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('upgrades v1 search rows with discovery funnel columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-availability-v1-'));
  const file = path.join(dir, 'availability.sqlite');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key,value) VALUES ('schema_version','1');
    CREATE TABLE search_runs (
      search_key TEXT PRIMARY KEY,event_id TEXT NOT NULL,promotion_id TEXT,
      provider TEXT NOT NULL,scope_hash TEXT NOT NULL,query_hash TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,searched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  db.close();
  const index = createAvailabilityIndex({ file, secret: process.env.SESSION_SECRET });
  try {
    assert.equal(index.stats().schemaVersion, 2);
    index.recordSearch({ eventId: 'aew:test', provider: 'torrent', scope: 'scope',
      queries: ['AEW Test'], results: [] });
    assert.equal(index.recordSearchOutcome({ eventId: 'aew:test', provider: 'torrent',
      scope: 'scope', matchedCount: 2, readyCount: 1 }), 1);
    assert.deepEqual(index.recentSearches(1).map((row) => [row.matchedCount, row.readyCount]), [[2, 1]]);
  } finally {
    index.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
