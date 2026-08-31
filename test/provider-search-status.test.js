'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const settings = require('../lib/settings');
const companion = require('../lib/sources/companion-scraper');
const prowlarr = require('../lib/sources/prowlarr');
const streams = require('../lib/streams');
const availabilityStore = require('../lib/availability-index');

function response(body, status) {
  const code = status || 200;
  return {
    ok: code >= 200 && code < 300,
    status: code,
    statusText: code === 200 ? 'OK' : 'Error',
    headers: { get: () => null },
    body: Readable.from([body]),
  };
}

test('companion distinguishes a real empty search from a transport failure', async () => {
  const original = settings.getCompanion;
  settings.getCompanion = () => ({ url: 'http://scraper:8080', authToken: '' });
  try {
    const input = {
      promotion: { id: 'ufc' }, event: { id: 'ufc:1', name: 'UFC 1', date: '2026-08-30' },
      searchTitles: ['UFC 1'], log: () => {}, throwOnFailure: true,
    };
    const empty = await companion.scrape(Object.assign({}, input, {
      fetchImpl: async () => response('{"candidates":[]}'),
    }));
    assert.deepEqual(empty, []);
    await assert.rejects(companion.scrape(Object.assign({}, input, {
      fetchImpl: async () => { throw new Error('timeout'); },
    })), /timeout/);
  } finally {
    settings.getCompanion = original;
  }
});

test('detailed Prowlarr search reports all-failed instead of a cacheable empty result', async () => {
  const original = settings.getProwlarr;
  settings.getProwlarr = () => ({ url: 'http://prowlarr:9696', apiKey: 'secret' });
  try {
    const failed = await prowlarr.multiSearch(['UFC 1'], {
      detailed: true, log: () => {},
      fetchImpl: async () => { throw new Error('timeout'); },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'all-failed');

    const empty = await prowlarr.multiSearch(['UFC 1'], {
      detailed: true, log: () => {}, fetchImpl: async () => response('[]'),
    });
    assert.deepEqual(empty, { ok: true, error: null, results: [] });
  } finally {
    settings.getProwlarr = original;
  }
});

test('automatic preparation reports failed torrent discovery instead of a false success', async () => {
  const originalCompanionConfig = settings.getCompanion;
  const originalProwlarrConfig = settings.getProwlarr;
  const originalScrape = companion.scrape;
  const originalIndex = availabilityStore.getDefault;
  settings.getCompanion = () => ({ url: 'http://scraper:8080', authToken: '' });
  settings.getProwlarr = () => ({ url: '', apiKey: '' });
  companion.scrape = async () => { throw new Error('companion timeout'); };
  availabilityStore.getDefault = () => null;
  try {
    const result = await streams.prefetchAvailability({
      event: { id: 'ufc:1', name: 'UFC 1', date: '2026-08-30' },
      userConfig: {}, log: () => {},
      prepare: { prepareTorrent: true, prepareUsenet: false, prepareEasynews: false },
    });
    assert.deepEqual(result.providers, ['torrent']);
    assert.equal(result.outcomes[0].provider, 'torrent');
    assert.equal(result.outcomes[0].ok, false);
    assert.match(result.outcomes[0].error, /all-discovery-sources-failed/);
  } finally {
    settings.getCompanion = originalCompanionConfig;
    settings.getProwlarr = originalProwlarrConfig;
    companion.scrape = originalScrape;
    availabilityStore.getDefault = originalIndex;
  }
});
