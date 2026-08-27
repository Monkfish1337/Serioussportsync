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
    close() { index.close(); fs.rmSync(dir, { recursive: true, force: true }); },
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
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
