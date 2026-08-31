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
const { _test: streams } = require('../lib/streams');

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
