'use strict';
process.env.SESSION_SECRET ||= 'partial-live-confirmed-test-secret-00000000000000000000';
const test = require('node:test');
const assert = require('node:assert/strict');
const availability = require('../lib/availability-index');
const settings = require('../lib/settings');
const prowlarr = require('../lib/sources/prowlarr');
const torbox = require('../lib/sources/torbox-resolver');
const {_test: streams} = require('../lib/streams');

test('partial live Prowlarr matches survive as account-scoped confirmed results without caching the search', async () => {
  const index = availability.createAvailabilityIndex({file: ':memory:', secret: process.env.SESSION_SECRET});
  const originals = [availability.getDefault, settings.getCompanion, settings.getProwlarr,
    settings.getBitmagnet, settings.getSportVideo, prowlarr.multiSearch, torbox.checkCachedBatch];
  const good = {title: 'MLB.2026.09.11.New.York.Mets.vs.New.York.Yankees.1080p', infoHash: 'a'.repeat(40), indexer: 'RuTracker', size: 1000};
  const bad = {title: 'Unrelated fixture', infoHash: 'b'.repeat(40), indexer: 'RuTracker'};
  availability.getDefault = () => index;
  settings.getCompanion = () => ({enabled: false});
  settings.getProwlarr = () => ({enabled: true, url: 'http://example.invalid', apiKey: 'fixture'});
  settings.getBitmagnet = () => ({enabled: false});
  settings.getSportVideo = () => ({enabled: false});
  let searches = 0, checks = 0;
  prowlarr.multiSearch = async () => {
    searches++;
    return searches === 1 ? {ok: true, partial: true, results: [good, bad]} : {ok: false, results: []};
  };
  torbox.checkCachedBatch = async hashes => {checks++; assert.deepEqual(hashes, [good.infoHash]); return new Set(hashes);};
  const event = {id: 'mlb:partial-test', name: 'New York Mets vs New York Yankees', date: '2026-09-11'};
  const input = {event, promo: {id: 'mlb', isRelevantStreamTitle: title => ({ok: title === good.title})},
    titles: ['Mets Yankees 2026.09.11'], torboxKey: 'account-one', discoveryBudgetMs: 1000,
    urlCtx: {origin: 'http://sss.invalid', userId: 'one', apiToken: 'fixture', showWarmRows: false}, log: () => {}};
  try {
    assert.equal((await streams.pipelineTorrentTorbox(input)).length, 1);
    const sourceScope = streams.torrentDiscoveryScope(index);
    assert.equal(index.getSearch({eventId: event.id, provider: 'torrent', scope: sourceScope, queries: input.titles}).hit, false);
    assert.equal(index.recentSearches(10).length, 0, 'Individual matches do not create a completed search run');
    const lookup = {eventId: event.id, sourceProvider: 'torrent', sourceScope,
      availabilityProvider: 'torbox', availabilityScope: index.scopeFingerprint('torbox', {apiKey: 'account-one'}), states: ['cached', 'verified']};
    assert.deepEqual(index.confirmedForEvent(lookup).map(r => r.candidate.infoHash), [good.infoHash]);
    assert.equal(index.confirmedForEvent({...lookup, availabilityScope: index.scopeFingerprint('torbox', {apiKey: 'account-two'})}).length, 0);
    assert.equal((await streams.pipelineTorrentTorbox(input)).length, 1, 'Known cached result survives a later Prowlarr failure');
    assert.equal(searches, 2, 'Discovery is retried rather than treated as complete');
    assert.equal(checks, 1, 'Fresh TorBox confirmation is reused');
    assert.equal(index.stats().releases, 1, 'Rejected fixture is not retained from the partial answer');
  } finally {
    [availability.getDefault, settings.getCompanion, settings.getProwlarr, settings.getBitmagnet,
      settings.getSportVideo, prowlarr.multiSearch, torbox.checkCachedBatch] = originals;
    index.close();
  }
});
