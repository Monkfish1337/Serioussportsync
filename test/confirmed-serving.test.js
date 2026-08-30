'use strict';

process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'confirmed-serving-test-secret-0000000000000000000000000000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAvailabilityIndex } = require('../lib/availability-index');
const availabilityStore = require('../lib/availability-index');
const settings = require('../lib/settings');
const torbox = require('../lib/sources/torbox-resolver');
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
