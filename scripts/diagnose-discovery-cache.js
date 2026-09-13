'use strict';
process.env.SESSION_SECRET = 'offline-diagnostic-secret-0000000000000000000000';

// Offline reproduction. Only the real cache and discovery orchestration run;
// all provider calls use deterministic fixtures and no network is contacted.
const assert = require('node:assert/strict');
const settings = require('../lib/settings');
const availability = require('../lib/availability-index');
const bitmagnet = require('../lib/sources/bitmagnet');
const prowlarr = require('../lib/sources/prowlarr');
const streams = require('../lib/streams');
const promotions = require('../lib/promotions');

async function main() {
  const index = availability.createAvailabilityIndex({file: ':memory:', secret: 'offline-diagnostic-secret-0000000000000000000000'});
  availability.getDefault = () => index;
  settings.getCompanion = () => ({enabled: false});
  settings.getProwlarr = () => ({enabled: true, url: 'http://example.invalid', apiKey: 'fixture'});
  settings.getBitmagnet = () => ({enabled: true, url: 'http://example.invalid', videoOnly: true, limit: 1000});
  settings.getSportVideo = () => ({enabled: false});
  settings.getDiscoveryTiming = () => ({prowlarrMaxQueries: 6, prowlarrQueryTimeoutMs: 1000});
  let bitmagnetCalls = 0, prowlarrCalls = 0;
  bitmagnet.multiSearch = async () => { bitmagnetCalls++; return {ok: true, results: [{infoHash: 'a'.repeat(40), title: 'irrelevant torrent', indexer: 'Bitmagnet'}]}; };
  prowlarr.multiSearch = async () => { prowlarrCalls++; return {ok: true, results: [{infoHash: 'b'.repeat(40), title: 'matching torrent', indexer: 'Prowlarr'}]}; };
  const input = {promo: {id: 'nfl'}, event: {id: 'nfl:offline-cache-repro', name: 'Packers vs Cardinals', date: '2026-08-29'}, titles: ['Packers Cardinals 2026.08.29'], discoveryBudgetMs: 1000, log: message => console.log(message)};
  try {
    const warm = await streams._test.discoverTorrentCandidates({...input, onlySources: new Set(['bitmagnet'])});
    const live = await streams._test.discoverTorrentCandidates(input);
    assert.equal(warm.length, 1);
    assert.equal(bitmagnetCalls, 2);
    assert.equal(prowlarrCalls, 1);
    assert.equal(live.length, 2);
    assert.deepEqual(await streams._test.discoverTorrentCandidates(input), live);
    assert.equal(prowlarrCalls, 1, 'Full searches should still reuse their own cache');
    assert.deepEqual(await streams._test.discoverTorrentCandidates({...input, onlySources: new Set(['bitmagnet'])}), warm);
    assert.equal(bitmagnetCalls, 2, 'Restricted warming should still reuse its own cache');
    const partialInput = {...input, event: {...input.event, id: 'nfl:offline-partial-repro'}};
    prowlarr.multiSearch = async () => { prowlarrCalls++; return {ok: true, partial: true, results: [{infoHash: 'b'.repeat(40), title: 'matching torrent', indexer: 'Prowlarr'}]}; };
    assert.equal((await streams._test.discoverTorrentCandidates(partialInput)).length, 2);
    assert.equal((await streams._test.discoverTorrentCandidates(partialInput)).length, 2);
    assert.equal(prowlarrCalls, 3, 'Usable partial Prowlarr answers must not suppress the next search');
    console.log(JSON.stringify({verifiedFix: 'Bitmagnet-only preparation and live discovery use separate caches', bitmagnetCalls, prowlarrCalls, liveSources: live.map(row => row.indexer)}, null, 2));
    for (const event of [
      {id: 'mlb:823498', name: 'New York Mets vs New York Yankees', date: '2026-09-11'},
      {id: 'nfl:sample', name: 'Green Bay Packers at Arizona Cardinals', date: '2026-08-29'},
      {id: 'ucl:sample', name: 'Liverpool FC vs Atlético de Madrid', date: '2026-09-09'},
    ]) {
      const promo = promotions.getByEventId(event.id);
      const titles = promo.searchTitles(event);
      console.log(JSON.stringify({event: event.name, providerQueries: streams._test.selectProviderQueries(titles, event, promo.uuMaxQueries || 6, promo), torrentFirstSix: (promo.torrentSearchTitles ? promo.torrentSearchTitles(event) : titles).slice(0, 6)}, null, 2));
    }
  } finally { index.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
