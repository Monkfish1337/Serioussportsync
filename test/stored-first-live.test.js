'use strict';
process.env.PROWLARR_DISCOVERY_ENABLED = '0';
process.env.SESSION_SECRET ||= 'stored-first-live-test-secret-000000000000000000000000';
const test = require('node:test');
const assert = require('node:assert/strict');
const availability = require('../lib/availability-index');
const settings = require('../lib/settings');
const prowlarr = require('../lib/sources/prowlarr');
const torbox = require('../lib/sources/torbox-resolver');
const {_test: streams} = require('../lib/streams');

// Live log, 2026-09-24: a UFC 331 request with a Sport-Video match and a
// Bitmagnet answer in 120ms still ran live Prowlarr for 18s, downloading
// nineteen torrents through it. A release the database already matched to the
// event is served; live Prowlarr runs only when there is none.
test('a live request serves stored releases and skips live Prowlarr; an unknown event still searches', async () => {
  const index = availability.createAvailabilityIndex({file: ':memory:', secret: process.env.SESSION_SECRET});
  const originals = [availability.getDefault, settings.getCompanion, settings.getProwlarr,
    settings.getBitmagnet, settings.getSportVideo, prowlarr.multiSearch, torbox.checkCachedBatch];
  availability.getDefault = () => index;
  settings.getCompanion = () => ({enabled: false});
  settings.getProwlarr = () => ({enabled: true, url: 'http://example.invalid', apiKey: 'fixture'});
  settings.getBitmagnet = () => ({enabled: false});
  settings.getSportVideo = () => ({enabled: false});
  let searches = 0;
  prowlarr.multiSearch = async () => { searches++; return {ok: true, results: []}; };
  torbox.checkCachedBatch = async hashes => new Set(hashes);
  const stored = {title: 'UFC.331.Van.vs.Pantoja.2.1080p.WEB', infoHash: 'c'.repeat(40), size: 5000};
  const promo = {id: 'ufc', isRelevantStreamTitle: title => ({ok: /UFC.331/.test(title)})};
  const urlCtx = {origin: 'http://sss.invalid', userId: 'one', apiToken: 'fixture', showWarmRows: false};
  // Recorded by a background build under its own restricted scope.
  index.recordEventCandidates({eventId: 'ufc:331', provider: 'torrent',
    scope: index.scopeFingerprint('torrent', {sources: ['bitmagnet']}), results: [stored]});
  const messages = [];
  try {
    const rows = await streams.pipelineTorrentTorbox({event: {id: 'ufc:331', name: 'UFC 331', date: '2026-09-19'},
      promo, titles: ['UFC 331'], torboxKey: 'k', discoveryBudgetMs: 1000, urlCtx, liveProwlarr: true,
      log: message => messages.push(message)});
    assert.equal(rows.length, 1);
    assert.equal(searches, 0, 'live Prowlarr skipped');
    assert.ok(messages.some(message => /1 stored release\(s\) for this event — skipping live Prowlarr/.test(message)));
    await streams.pipelineTorrentTorbox({event: {id: 'ufc:332', name: 'UFC 332', date: '2026-10-03'},
      promo, titles: ['UFC 332'], torboxKey: 'k', discoveryBudgetMs: 1000, urlCtx, liveProwlarr: true, log: () => {}});
    assert.equal(searches, 1, 'nothing stored: live Prowlarr still searches');
  } finally {
    [availability.getDefault, settings.getCompanion, settings.getProwlarr, settings.getBitmagnet,
      settings.getSportVideo, prowlarr.multiSearch, torbox.checkCachedBatch] = originals;
    index.close();
  }
});

// Nuvio's Refresh re-sends the same stream request. Inside the window after a
// stored serve, that repeat runs a live search once; outside it, or on the
// next press, the database answer stands again.
test('Refresh shortly after a stored serve runs one live search', async () => {
  streams.STORED_SERVES.clear();
  const index = availability.createAvailabilityIndex({file: ':memory:', secret: process.env.SESSION_SECRET});
  const originals = [availability.getDefault, settings.getCompanion, settings.getProwlarr,
    settings.getBitmagnet, settings.getSportVideo, prowlarr.multiSearch, torbox.checkCachedBatch];
  availability.getDefault = () => index;
  settings.getCompanion = () => ({enabled: false});
  settings.getProwlarr = () => ({enabled: true, url: 'http://example.invalid', apiKey: 'fixture'});
  settings.getBitmagnet = () => ({enabled: false});
  settings.getSportVideo = () => ({enabled: false});
  let searches = 0;
  const fresh = {title: 'UFC.331.Van.vs.Pantoja.2.2160p.WEB', infoHash: 'd'.repeat(40), size: 9000};
  prowlarr.multiSearch = async () => { searches++; return {ok: true, results: [fresh]}; };
  torbox.checkCachedBatch = async hashes => new Set(hashes);
  const stored = {title: 'UFC.331.Van.vs.Pantoja.2.1080p.WEB', infoHash: 'c'.repeat(40), size: 5000};
  index.recordEventCandidates({eventId: 'ufc:331', provider: 'torrent', scope: 'bitmagnet-only', results: [stored]});
  const request = (userId) => streams.pipelineTorrentTorbox({event: {id: 'ufc:331', name: 'UFC 331', date: '2026-09-19'},
    promo: {id: 'ufc', isRelevantStreamTitle: title => ({ok: /UFC.331/.test(title)})},
    titles: ['UFC 331'], torboxKey: 'k', discoveryBudgetMs: 1000, liveProwlarr: true, log: () => {},
    urlCtx: {origin: 'http://sss.invalid', userId, apiToken: 'fixture', showWarmRows: false}});
  try {
    assert.equal((await request('one')).length, 1);
    assert.equal(searches, 0, 'first request: database serve');
    assert.equal((await request('two')).length, 1);
    assert.equal(searches, 0, 'another account is not a Refresh press');
    assert.equal((await request('one')).length, 2, 'the live result is served alongside the stored one');
    assert.equal(searches, 1, 'Refresh press: live search');
    assert.ok(index.storedForEvent({eventId: 'ufc:331', provider: 'torrent'}).some(c => c.infoHash === fresh.infoHash),
      'the live result is captured by the database');
    assert.equal(streams.takeRefreshPress('one|ufc:331'), false, 'the press is consumed');
    streams.noteStoredServe('three|ufc:331', Date.now() - 31000);
    assert.equal(streams.takeRefreshPress('three|ufc:331'), false, 'outside the window');
  } finally {
    [availability.getDefault, settings.getCompanion, settings.getProwlarr, settings.getBitmagnet,
      settings.getSportVideo, prowlarr.multiSearch, torbox.checkCachedBatch] = originals;
    streams.STORED_SERVES.clear();
    index.close();
  }
});

// A live Prowlarr search regularly outlasts the response budget. On a Refresh
// the answer that lands after the response is still written to the database,
// for any promotion, so the next request serves it.
test('a Refresh-forced live answer arriving after the response is still stored', async () => {
  streams.STORED_SERVES.clear();
  const index = availability.createAvailabilityIndex({file: ':memory:', secret: process.env.SESSION_SECRET});
  const originals = [availability.getDefault, settings.getCompanion, settings.getProwlarr,
    settings.getBitmagnet, settings.getSportVideo, prowlarr.multiSearch, torbox.checkCachedBatch];
  availability.getDefault = () => index;
  settings.getCompanion = () => ({enabled: false});
  settings.getProwlarr = () => ({enabled: true, url: 'http://example.invalid', apiKey: 'fixture'});
  settings.getBitmagnet = () => ({enabled: false});
  settings.getSportVideo = () => ({enabled: false});
  const late = {title: 'UFC.331.Van.vs.Pantoja.2.720p.WEB', infoHash: 'e'.repeat(40), size: 3000};
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  prowlarr.multiSearch = () => new Promise(resolve => setTimeout(() => { resolve({ok: true, results: [late]}); }, 150));
  torbox.checkCachedBatch = async hashes => { if (hashes.includes(late.infoHash)) finished(); return new Set(hashes); };
  const stored = {title: 'UFC.331.Van.vs.Pantoja.2.1080p.WEB', infoHash: 'c'.repeat(40), size: 5000};
  index.recordEventCandidates({eventId: 'ufc:331', provider: 'torrent', scope: 'bitmagnet-only', results: [stored]});
  try {
    streams.noteStoredServe('one|ufc:331');
    const rows = await streams.pipelineTorrentTorbox({event: {id: 'ufc:331', name: 'UFC 331', date: '2026-09-19'},
      promo: {id: 'ufc', isRelevantStreamTitle: title => ({ok: /UFC.331/.test(title)})},
      titles: ['UFC 331'], torboxKey: 'k', discoveryBudgetMs: 20, liveProwlarr: true, log: () => {},
      urlCtx: {origin: 'http://sss.invalid', userId: 'one', apiToken: 'fixture', showWarmRows: false}});
    assert.equal(rows.length, 1, 'the response went out with the stored release only');
    await Promise.race([done, new Promise(resolve => setTimeout(resolve, 2000))]);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(index.storedForEvent({eventId: 'ufc:331', provider: 'torrent'}).some(c => c.infoHash === late.infoHash),
      'the late live result is captured by the database');
  } finally {
    [availability.getDefault, settings.getCompanion, settings.getProwlarr, settings.getBitmagnet,
      settings.getSportVideo, prowlarr.multiSearch, torbox.checkCachedBatch] = originals;
    streams.STORED_SERVES.clear();
    index.close();
  }
});
