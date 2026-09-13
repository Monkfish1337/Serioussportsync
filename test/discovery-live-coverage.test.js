'use strict';
process.env.SESSION_SECRET ||= 'discovery-live-coverage-secret-0000000000000000000000';
const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../lib/settings');
const availability = require('../lib/availability-index');
const prowlarr = require('../lib/sources/prowlarr');
const torbox = require('../lib/sources/torbox-resolver');
const admin = require('../lib/admin-promotions');
const promotions = require('../lib/promotions');
const {_test: streams} = require('../lib/streams');

function configure() {
  const originals = [settings.getCompanion, settings.getBitmagnet, settings.getProwlarr, settings.getSportVideo,
    availability.getDefault, prowlarr.multiSearch, torbox.checkCachedBatch];
  settings.getCompanion = () => ({enabled: false});
  settings.getBitmagnet = () => ({enabled: false});
  settings.getProwlarr = () => ({url: 'http://example.invalid', apiKey: 'fixture', enabled: true});
  settings.getSportVideo = () => ({enabled: false});
  return () => { [settings.getCompanion, settings.getBitmagnet, settings.getProwlarr, settings.getSportVideo,
    availability.getDefault, prowlarr.multiSearch, torbox.checkCachedBatch] = originals; };
}
test('confirmed playable release stays selected despite twenty-four larger discoveries', async () => {
  const restore = configure();
  const index = availability.createAvailabilityIndex({file: ':memory:', secret: process.env.SESSION_SECRET});
  availability.getDefault = () => index;
  const good = {title: 'MLB.Mets.Yankees.720p', size: 100, infoHash: 'a'.repeat(40), indexer: 'RuTracker'};
  const event = {id: 'mlb:ranking', name: 'Mets vs Yankees', date: '2026-09-11'};
  index.recordEventCandidates({eventId: event.id, provider: 'torrent', scope: streams.torrentDiscoveryScope(index), results: [good]});
  index.observe({provider: 'torbox', scope: index.scopeFingerprint('torbox', {apiKey: 'fixture'}), state: 'cached', candidate: good});
  const candidates = Array.from({length: 24}, (_, i) => ({title: 'MLB.Mets.Yankees.1080p.' + i,
    size: 10000, infoHash: (i + 1).toString(16).padStart(40, '0'), indexer: 'RuTracker'}));
  prowlarr.multiSearch = async () => ({ok: true, partial: true, results: candidates});
  torbox.checkCachedBatch = async () => new Set();
  const input = {event, promo: {id: 'mlb', isRelevantStreamTitle: () => ({ok: true})}, titles: ['Mets Yankees'], torboxKey: 'fixture',
    discoveryBudgetMs: 1000, log: () => {}, urlCtx: {origin: 'http://sss.invalid', userId: 'one', apiToken: 'fixture', showWarmRows: false}};
  try {
    const rows = await streams.pipelineTorrentTorbox(input);
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /720p/);
    let refreshes = 0;
    prowlarr.multiSearch = async () => { refreshes++; await new Promise(resolve => setTimeout(resolve, 20)); return {ok: true, results: []}; };
    assert.equal((await streams.pipelineTorrentTorbox({...input, fastResponse: true})).length, 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(refreshes, 1, 'Fast confirmed response still refreshes live discovery');
    assert.equal((await streams.pipelineTorrentTorbox({...input, fastResponse: true,
      promo: {id: 'mlb', isRelevantStreamTitle: () => ({ok: false, reason: 'rule changed'})}})).length, 0,
      'Fast confirmed responses still respect current matching rules');
  } finally {restore(); index.close();}
});
test('Matching Lab uses shipped UCL queries and exposes direct-source timing and partial status', async () => {
  const restore = configure();
  settings.getBitmagnet = () => ({url: 'http://example.invalid', enabled: true});
  const title = 'UEFA.Champions.League.2026.08.25.LASK.vs.Celtic.720p.WEB.h264-ULTRAS';
  const event = {name: 'LASK vs Celtic FC', date: '2026-08-25'};
  try {
    const result = await admin.researchAliases({}, {promotionId: 'ucl', name: 'UEFA Champions League', eventName: event.name, eventDate: event.date}, {
      bitmagnetSearch: async queries => {
        const promo = promotions.all.find(p => p.id === 'ucl');
        assert.deepEqual(queries, promo.torrentSearchTitles(event));
        return {ok: true, results: [{title, infoHash: 'a'.repeat(40)}]};
      },
      prowlarrSearch: async queries => {assert.ok(queries.length <= 6); return {ok: true, partial: true, results: [{title, infoHash: 'b'.repeat(40)}]};},
    });
    assert.equal(result.counts.matched, 1);
    assert.deepEqual(result.groups.matched[0].providers, ['Bitmagnet', 'Prowlarr torrents']);
    assert.equal(result.providers.find(p => p.id === 'prowlarr').partial, true);
    assert.equal(typeof result.providers[0].durationMs, 'number');
    assert.match(result.report, /Queries by source:/);
    assert.doesNotMatch(result.report, /infoHash|apiKey|example.invalid/);
  } finally {restore();}
});
