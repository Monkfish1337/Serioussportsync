'use strict';

process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'confirmed-serving-test-secret-0000000000000000000000000000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAvailabilityIndex } = require('../lib/availability-index');
const availabilityStore = require('../lib/availability-index');
const settings = require('../lib/settings');
const torbox = require('../lib/sources/torbox-resolver');
const companionClient = require('../lib/sources/companion-scraper');
const { warmTorbox, _test: streams } = require('../lib/streams');

test('warming replaces a stale negative observation so Refresh Links rechecks TorBox', async () => {
  const index = createAvailabilityIndex({ file: ':memory:', secret: process.env.SESSION_SECRET });
  const originalDefault = availabilityStore.getDefault;
  const originalCompanion = settings.getCompanion;
  const originalProwlarr = settings.getProwlarr;
  const originalCheck = torbox.checkCachedBatch;
  const originalCreate = torbox.createTorrent;
  const candidate = {
    title: 'ONE.Friday.Fights.168.1080p.WEB-DL', infoHash: 'f'.repeat(40), size: 4_000_000_000,
  };
  const companion = { url: 'http://scraper:8080', authToken: 'token' };
  const prowlarr = { url: '', apiKey: '' };
  const sourceScope = index.scopeFingerprint('torrent', {
    companionUrl: companion.url, companionToken: companion.authToken,
    prowlarrUrl: prowlarr.url, prowlarrApiKey: prowlarr.apiKey,
  });
  const torboxScope = index.scopeFingerprint('torbox', { apiKey: 'torbox-key' });
  index.recordSearch({
    eventId: 'one:168', promotionId: 'one', provider: 'torrent', scope: sourceScope,
    queries: ['ONE Friday Fights 168'], results: [candidate],
  });
  index.observe({ provider: 'torbox', scope: torboxScope, state: 'unavailable', candidate });
  availabilityStore.getDefault = () => index;
  settings.getCompanion = () => companion;
  settings.getProwlarr = () => prowlarr;
  let checks = 0;
  torbox.checkCachedBatch = async () => (++checks < 3 ? new Set() : new Set([candidate.infoHash]));
  torbox.createTorrent = async () => 91;
  try {
    const warmed = await warmTorbox({
      eventId: 'one:168', infoHash: candidate.infoHash,
      creds: { torboxApiKey: 'torbox-key' }, username: 'demo',
      beforeSubmit: () => ({ ok: true }), log: () => {},
    });
    assert.equal(warmed.queued, true);
    assert.equal(index.availabilityFor({
      provider: 'torbox', scope: torboxScope, candidates: [candidate],
    }).get(index.releaseId(candidate)).state, 'warming');

    const pipelineInput = {
      promo: { id: 'one', isRelevantStreamTitle: () => ({ ok: true }) },
      event: { id: 'one:168', name: 'ONE Friday Fights 168', date: '2026-09-01', excludePatterns: [] },
      titles: ['ONE Friday Fights 168'], torboxKey: 'torbox-key', discoveryBudgetMs: 100,
      urlCtx: { origin: 'http://sss:7000', userId: 'user-1', apiToken: 'token', showWarmRows: true },
      log: () => {},
    };
    const stillWarming = await streams.pipelineTorrentTorbox(pipelineInput);
    assert.equal(checks, 2, 'an immediate Refresh Links action rechecks TorBox');
    assert.match(stillWarming[0].url, /\/warm\/torbox\//);
    assert.match(stillWarming[0].name, /Refresh Links when ready/);
    assert.match(stillWarming[0].title, /Check TorBox dashboard, then Refresh Links when complete/);
    assert.equal(index.availabilityFor({
      provider: 'torbox', scope: torboxScope, candidates: [candidate],
    }).get(index.releaseId(candidate)).state, 'warming',
    'an early refresh must not recreate the negative-cache state');

    const rows = await streams.pipelineTorrentTorbox(pipelineInput);
    assert.equal(checks, 3, 'a later Refresh Links action rechecks TorBox again');
    assert.equal(rows.length, 1);
    assert.match(rows[0].url, /\/resolve\/torbox\/one%3A168\//);
  } finally {
    availabilityStore.getDefault = originalDefault;
    settings.getCompanion = originalCompanion;
    settings.getProwlarr = originalProwlarr;
    torbox.checkCachedBatch = originalCheck;
    torbox.createTorrent = originalCreate;
    index.close();
  }
});

test('an old warm link starts playback when TorBox has become ready', async () => {
  const index = createAvailabilityIndex({ file: ':memory:', secret: process.env.SESSION_SECRET });
  const originalDefault = availabilityStore.getDefault;
  const originalCheck = torbox.checkCachedBatch;
  const originalResolve = torbox.resolveCached;
  const originalCreate = torbox.createTorrent;
  const hash = '9'.repeat(40);
  availabilityStore.getDefault = () => index;
  torbox.checkCachedBatch = async () => new Set([hash]);
  torbox.resolveCached = async () => 'https://play.example/video.mkv';
  let submitted = false;
  let rateLimited = false;
  torbox.createTorrent = async () => { submitted = true; return 1; };
  try {
    const result = await warmTorbox({
      eventId: 'one:168', infoHash: hash, creds: { torboxApiKey: 'torbox-key' },
      beforeSubmit: () => { rateLimited = true; return { ok: false }; }, log: () => {},
    });
    assert.equal(result.url, 'https://play.example/video.mkv');
    assert.equal(submitted, false);
    assert.equal(rateLimited, false, 'ready playback bypasses the add-torrent rate limiter');
  } finally {
    availabilityStore.getDefault = originalDefault;
    torbox.checkCachedBatch = originalCheck;
    torbox.resolveCached = originalResolve;
    torbox.createTorrent = originalCreate;
    index.close();
  }
});

test('serves an account-scoped confirmed TorBox row without repeating discovery or cache checks', async () => {
  const index = createAvailabilityIndex({ file: ':memory:', secret: process.env.SESSION_SECRET });
  const originalDefault = availabilityStore.getDefault;
  const originalCompanion = settings.getCompanion;
  const originalProwlarr = settings.getProwlarr;
  const originalAvailability = settings.getAvailabilityWarm;
  const originalCheck = torbox.checkCachedBatch;
  const companion = { url: 'http://scraper:8080', authToken: 'token' };
  const prowlarr = { url: '', apiKey: '' };
  const candidate = {
    title: 'UFC.300.Main.Card.1080p.WEB-DL', infoHash: 'd'.repeat(40), size: 8_000_000_000,
  };
  const sourceScope = index.scopeFingerprint('torrent', {
    companionUrl: companion.url, companionToken: companion.authToken,
    prowlarrUrl: prowlarr.url, prowlarrApiKey: prowlarr.apiKey,
  });
  const torboxScope = index.scopeFingerprint('torbox', { apiKey: 'torbox-key' });
  index.recordSearch({
    eventId: 'ufc:300', promotionId: 'ufc', provider: 'torrent', sourceScope,
    scope: sourceScope, queries: ['UFC 300'], results: [candidate],
  });
  index.observe({ provider: 'torbox', scope: torboxScope, state: 'cached', candidate });
  let cacheChecks = 0;
  availabilityStore.getDefault = () => index;
  settings.getCompanion = () => companion;
  settings.getProwlarr = () => prowlarr;
  settings.getAvailabilityWarm = () => ({ serveConfirmed: true });
  torbox.checkCachedBatch = async () => { cacheChecks++; return new Set(); };
  try {
    const rows = await streams.pipelineTorrentTorbox({
      promo: { id: 'ufc', isRelevantStreamTitle: () => ({ ok: true }) },
      event: { id: 'ufc:300', name: 'UFC 300', date: '2026-04-13', excludePatterns: [] },
      titles: ['UFC 300'], torboxKey: 'torbox-key', discoveryBudgetMs: 10,
      urlCtx: { origin: 'http://sss:7000', userId: 'user-1', apiToken: 'api-token', showWarmRows: false },
      log: () => {},
    });
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /UFC\.300\.Main\.Card/);
    assert.match(rows[0].url, /\/resolve\/torbox\/ufc%3A300\//);
    assert.equal(cacheChecks, 0, 'fresh confirmed state avoids another TorBox cache lookup');
    assert.deepEqual(index.recentSearches(1).map((row) => ({
      discovered: row.resultCount, matched: row.matchedCount, ready: row.readyCount,
    })), [{ discovered: 1, matched: null, ready: null }],
    'confirmed-only serving does not replace a full-search funnel with its subset');
  } finally {
    availabilityStore.getDefault = originalDefault;
    settings.getCompanion = originalCompanion;
    settings.getProwlarr = originalProwlarr;
    settings.getAvailabilityWarm = originalAvailability;
    torbox.checkCachedBatch = originalCheck;
    index.close();
  }
});

test('background mode ignores confirmed rows so discovery can refresh the index', async () => {
  const index = createAvailabilityIndex({ file: ':memory:', secret: process.env.SESSION_SECRET });
  const originalDefault = availabilityStore.getDefault;
  const originalCompanion = settings.getCompanion;
  const originalProwlarr = settings.getProwlarr;
  const originalAvailability = settings.getAvailabilityWarm;
  const originalCheck = torbox.checkCachedBatch;
  availabilityStore.getDefault = () => index;
  settings.getCompanion = () => ({ url: '', authToken: '' });
  settings.getProwlarr = () => ({ url: '', apiKey: '' });
  settings.getAvailabilityWarm = () => ({ serveConfirmed: true });
  torbox.checkCachedBatch = async () => new Set();
  const candidate = {
    title: 'UFC.300.Main.Card.1080p.WEB-DL', infoHash: 'e'.repeat(40), size: 8_000_000_000,
  };
  const sourceScope = index.scopeFingerprint('torrent', {
    companionUrl: '', companionToken: '', prowlarrUrl: '', prowlarrApiKey: '',
  });
  const torboxScope = index.scopeFingerprint('torbox', { apiKey: 'torbox-key' });
  index.recordSearch({
    eventId: 'ufc:300', promotionId: 'ufc', provider: 'torrent', scope: sourceScope,
    queries: ['UFC 300'], results: [candidate],
  });
  index.observe({ provider: 'torbox', scope: torboxScope, state: 'cached', candidate });
  const messages = [];
  try {
    const rows = await streams.pipelineTorrentTorbox({
      promo: { id: 'ufc', isRelevantStreamTitle: () => ({ ok: true }) },
      event: { id: 'ufc:300', name: 'UFC 300', date: '2026-04-13', excludePatterns: [] },
      titles: ['UFC 300'], torboxKey: 'torbox-key', discoveryBudgetMs: 10,
      allowConfirmed: false,
      urlCtx: { origin: 'http://sss:7000', userId: 'warm', apiToken: 'warm', showWarmRows: false },
      log: (message) => messages.push(message),
    });
    assert.equal(rows.length, 0);
    assert.ok(messages.some((message) => /no companion or direct Prowlarr configured/.test(message)));
    assert.ok(!messages.some((message) => /recovered .* confirmed/.test(message)));
  } finally {
    availabilityStore.getDefault = originalDefault;
    settings.getCompanion = originalCompanion;
    settings.getProwlarr = originalProwlarr;
    settings.getAvailabilityWarm = originalAvailability;
    torbox.checkCachedBatch = originalCheck;
    index.close();
  }
});

test('full Torrent/TorBox discovery records discovered, matched, and ready counts', async () => {
  const index = createAvailabilityIndex({ file: ':memory:', secret: process.env.SESSION_SECRET });
  const originalDefault = availabilityStore.getDefault;
  const originalCompanion = settings.getCompanion;
  const originalProwlarr = settings.getProwlarr;
  const originalScrape = companionClient.scrape;
  const originalCheck = torbox.checkCachedBatch;
  const candidates = [
    { title: 'AEW.All.In.London.2026.Good.A', infoHash: 'a'.repeat(40), size: 3 },
    { title: 'AEW.All.In.London.2026.Good.B', infoHash: 'b'.repeat(40), size: 2 },
    { title: 'Unrelated.London.Release', infoHash: 'c'.repeat(40), size: 1 },
  ];
  availabilityStore.getDefault = () => index;
  settings.getCompanion = () => ({ url: 'http://scraper:8080', authToken: '' });
  settings.getProwlarr = () => ({ url: '', apiKey: '' });
  companionClient.scrape = async () => candidates;
  torbox.checkCachedBatch = async () => new Set(['a'.repeat(40)]);
  try {
    const rows = await streams.pipelineTorrentTorbox({
      promo: { id: 'aew', isRelevantStreamTitle: (title) => title.includes('.Good.')
        ? { ok: true } : { ok: false, reason: 'no-event-name-overlap' } },
      event: { id: 'aew:test', name: 'All In London', date: '2026-08-31', excludePatterns: [] },
      titles: ['AEW All In London 2026'], torboxKey: 'torbox-key', discoveryBudgetMs: 1000,
      allowConfirmed: false,
      urlCtx: { origin: 'http://sss:7000', userId: 'warm', apiToken: 'warm', showWarmRows: false },
      log: () => {},
    });
    assert.equal(rows.length, 1);
    assert.deepEqual(index.recentSearches(1).map((row) => ({
      discovered: row.resultCount, matched: row.matchedCount, ready: row.readyCount,
    })), [{ discovered: 3, matched: 2, ready: 1 }]);
  } finally {
    availabilityStore.getDefault = originalDefault;
    settings.getCompanion = originalCompanion;
    settings.getProwlarr = originalProwlarr;
    companionClient.scrape = originalScrape;
    torbox.checkCachedBatch = originalCheck;
    index.close();
  }
});
