'use strict';

// Diagnosis turns what SSS already records into findings with a fix link.
// Each case below is a real problem found by hand in September 2026, and the
// point is that the page now finds it on its own.

const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-diagnosis-'));
process.env.SESSION_SECRET ||= 'diagnosis-test-secret-000000000000000000000000000000';
process.env.AVAILABILITY_DB_FILE = path.join(dir, 'availability.sqlite');

const test = require('node:test');
const assert = require('node:assert/strict');
const diagnosis = require('../lib/diagnosis');
const page = require('../lib/admin-diagnosis');

const NOW = Date.parse('2026-09-25T13:00:00Z');
const day = (offset) => new Date(NOW + offset * 86400000).toISOString().slice(0, 10);

function sources(overrides) {
  const promotions = [
    { id: 'motogp', name: 'MotoGP', enabled: true, source: { type: 'thesportsdb' }, isRelevantStreamTitle: () => ({ ok: true }) },
    { id: 'motd', name: 'Match of the Day', enabled: true, source: { type: 'tmdb' }, isRelevantStreamTitle: () => ({ ok: true }) },
    { id: 'wwe-nxt', name: 'WWE NXT', enabled: true, weeklyShow: true, source: { type: 'thesportsdb' }, isRelevantStreamTitle: () => ({ ok: true }) },
    { id: 'nhl', name: 'NHL', enabled: true, source: { type: 'espn' }, isRelevantStreamTitle: () => ({ ok: true }) },
    { id: 'discovered-rugby', name: 'Discovered Rugby', enabled: true, source: { type: 'sport-video' }, isRelevantStreamTitle: () => ({ ok: true }) },
  ];
  return Object.assign({
    config: () => ({ publicUrl: '', refreshIntervalHours: 6 }),
    settings: () => ({ getTmdb: () => ({ apiKey: '' }), getFootballData: () => ({ apiKey: '' }), getApiFootball: () => ({ apiKey: '' }),
      getSportVideo: () => ({ enabled: true }) }),
    promotions: () => promotions,
    events: () => [
      { id: 'motogp:1', name: 'Austria GP', date: day(-5) },
      { id: 'wwe-nxt:856', name: 'WWE NXT #856', date: day(-3) },
    ],
    refreshStatus: () => ({ finishedAt: new Date(NOW - 3600000).toISOString(), lastFullRefreshAt: new Date(NOW - 3600000).toISOString(),
      promotions: [{ id: 'motd', status: 'failed', reason: 'TMDB_API_KEY is not configured' }, { id: 'motogp', status: 'ok' }] }),
    queueStatus: () => ({ indexers: [
      { name: '720pier', successes: 169, failures: 3, next_at: NOW + 3 * 3600000 },
      { name: 'RuTracker.org', successes: 28, failures: 0, next_at: 0 },
    ], eventStates: [] }),
    overrides: () => [{ promotionId: 'motogp', promotionAliases: ['MotoGP', 'MotoGP 2026x14 San Marino Qualifying'],
      relevanceKeywords: ['motogp'], searchTitleTemplates: ['{name}', '{name} {year}'] }],
    reviewRows: (id) => id === 'motogp' ? [{ pattern: 'motogp {date} austria', source: 'easynews', flag: 'Repeated zero hits', action: 'active' }] : [],
    clientReports: () => [{ startedAt: new Date(NOW - 3600000).toISOString(), events: [
      { verdict: 'fail', promotionName: 'MLB', eventName: 'Cubs at Mets', problems: ['no rows, although SSS holds a release for this event'], warnings: [] },
    ] }],
    sportVideoStatus: () => ({ lastError: '' }),
    sportVideoReleases: () => [],
    users: () => [{ username: 'monkeh', role: 'admin', config: { diyUsenetEnabled: true } }],
    usenetStatus: () => ({ enabled: true, discovery: true, playback: false, ready: false }),
    logs: () => [{ ts: NOW - 60000, category: 'prowlarr', line: '[prowlarr] Release download failed' }],
    availabilityIndex: () => ({ eventReleaseTitles: () => [], storedForEvent: () => [] }),
    coverage: () => ({ promotions: [{ id: 'motogp', total: 10, missing: 6, reasons: { 'No matches — awaiting retry': 6 } }] }),
  }, overrides || {});
}

const run = (overrides) => diagnosis.collect({ now: NOW, sources: sources(overrides) });
const titled = (result, re) => result.findings.find((f) => re.test(f.title));

test('each real problem from September becomes a finding with a fix link', () => {
  const result = run();
  const indexer = titled(result, /720pier has failed 3 times/);
  assert.equal(indexer.severity, 'critical', 'the most productive indexer failing is critical');
  assert.equal(indexer.fix.href, '/admin/discovery?tab=prowlarr');
  const alias = titled(result, /MotoGP has learned rules that name a single event/);
  assert.ok(alias, 'the San Marino alias is caught');
  assert.deepEqual(alias.evidence, ['"MotoGP 2026x14 San Marino Qualifying"']);
  assert.equal(alias.fix.href, '/admin/promotions/motogp/research');
  assert.ok(titled(result, /Match of the Day cannot refresh: no TMDB key/));
  assert.ok(titled(result, /Match of the Day failed to refresh/));
  assert.ok(!titled(result, /Match of the Day has no events/), 'the missing key is the cause, reported once');
  assert.ok(titled(result, /WWE NXT has no upcoming episodes/));
  assert.ok(titled(result, /NHL has no events/));
  assert.ok(!titled(result, /Discovered Rugby has no events/), 'Discovered catalogs are built from releases, not a schedule');
  assert.ok(titled(result, /PUBLIC_URL is not set/));
  assert.ok(titled(result, /MotoGP: 6 of 10 recent events have no saved torrent/));
  assert.ok(titled(result, /1 event failed the last Client check/));
  assert.ok(titled(result, /^Built-in Usenet is on for monkeh but is missing an NNTP provider$/));
  assert.ok(titled(result, /MotoGP: 1 search pattern never find/));
  assert.ok(titled(result, /1 error in "prowlarr"/));
  assert.equal(result.findings[0].severity, 'critical', 'most severe first');
});

test('a healthy server produces no findings', () => {
  const result = run({
    config: () => ({ publicUrl: 'https://sss.example.com', refreshIntervalHours: 6 }),
    settings: () => ({ getTmdb: () => ({ apiKey: 'k' }), getFootballData: () => ({ apiKey: 'k' }), getApiFootball: () => ({ apiKey: 'k' }), getSportVideo: () => ({ enabled: true }) }),
    events: () => [{ id: 'motogp:1', date: day(-5) }, { id: 'motd:1', date: day(-5) }, { id: 'wwe-nxt:857', date: day(4) }, { id: 'nhl:1', date: day(1) }],
    refreshStatus: () => ({ finishedAt: new Date(NOW).toISOString(), lastFullRefreshAt: new Date(NOW).toISOString(), promotions: [] }),
    queueStatus: () => ({ indexers: [{ name: '720pier', successes: 169, failures: 0 }], eventStates: [] }),
    overrides: () => [{ promotionId: 'motogp', promotionAliases: ['MotoGP'], relevanceKeywords: ['motogp'], searchTitleTemplates: ['{name}'] }],
    reviewRows: () => [], clientReports: () => [{ startedAt: new Date(NOW).toISOString(), events: [] }],
    usenetStatus: () => ({ enabled: true, discovery: true, playback: true, ready: true }), logs: () => [],
    coverage: () => ({ promotions: [{ id: 'motogp', total: 10, missing: 1, reasons: {} }] }),
  });
  assert.deepEqual(result.findings.map((f) => f.title), []);
  assert.ok(result.checked.length >= 10);
});

test('a check that cannot read its source is a notice, not a broken page', () => {
  const result = run({ queueStatus: () => { throw new Error('queue database locked'); } });
  assert.ok(titled(result, /The "indexers" check could not run/));
  assert.ok(titled(result, /PUBLIC_URL/), 'other checks still ran');
});

test('investigating an event gathers saved releases, requests and rejection reasons', () => {
  const lines = [
    { ts: NOW - 5000, line: '[stream] stream request started', requestId: 'r1', fields: { eventId: 'f1:2408188', queryVariants: ['F1 2026 Azerbaijan FP2'] } },
    { ts: NOW - 4000, line: '[stream] torrent candidate rejected', requestId: 'r1', fields: { eventId: 'f1:2408188', reason: 'practice(1≠2)', releaseTitle: 'Formula1.2026.Round15.Azerbaijan.FP1.1080p' } },
    { ts: NOW - 3000, line: '[stream] stream request complete', requestId: 'r1', user: 'monkeh', fields: { eventId: 'f1:2408188', durationMs: 11102, rows: 10, pipelineRows: { torbox: 1, easynews: 2 } } },
  ];
  const result = diagnosis.investigate('f1:2408188', { sources: sources({
    events: () => [{ id: 'f1:2408188', name: 'Azerbaijan Grand Prix Practice 2', date: '2026-09-24' }],
    promotions: () => [{ id: 'f1', name: 'Formula 1', source: { type: 'thesportsdb' }, disabledPipelines: [] }],
    availabilityIndex: () => ({ storedForEvent: ({ provider }) => provider === 'torrent' ? [{ title: 'Formula1.2026.Round15.Azerbaijan.FP2.1080p', infoHash: 'a'.repeat(40) }] : [] }),
    sportVideoReleases: () => [{ title: 'Formula 1 Azerbaijan Grand Prix Practice 2 24.09.2026', infoHash: 'b'.repeat(40), matches: [{ eventId: 'f1:2408188' }] }],
    logs: () => lines,
  }) });
  assert.equal(result.event.id, 'f1:2408188');
  assert.equal(result.stored.torrent.length, 1);
  assert.equal(result.sportVideo[0].prepared, true);
  assert.equal(result.requests[0].rows, 10);
  assert.equal(result.rejections[0].reason, 'practice(1≠2)');
  assert.deepEqual(result.queries, ['F1 2026 Azerbaijan FP2']);
  const html = page.renderEvent(result);
  assert.match(html, /Why releases were turned down/);
  assert.match(html, /\/admin\/promotions\/f1\/aliases/, 'links to the promotion\'s Review aliases');
  assert.match(html, /\/admin\/client-check\?eventId=f1%3A2408188/);
  const search = diagnosis.investigate('grand prix', { sources: sources({ events: () => [
    { id: 'f1:1', name: 'Azerbaijan Grand Prix', date: '2026-09-27' }, { id: 'f1:2', name: 'Spanish Grand Prix', date: '2026-09-13' }] }) });
  assert.equal(search.event, null);
  assert.deepEqual(search.matches.map((e) => e.id), ['f1:1', 'f1:2'], 'newest first');
});

test('the page renders findings, tabs and a tools directory that answers "where is Review aliases?"', () => {
  const html = page.render({ tab: 'findings', findings: run() });
  assert.match(html, /Needs attention/);
  assert.match(html, /href="\/admin\/client-check"/, 'Client check is a Diagnosis tab');
  const tools = page.render({ tab: 'tools' });
  assert.match(tools, /Review aliases/);
  assert.match(tools, /Improve matching/);
  assert.match(tools, /Prowlarr queue and indexer budgets/);
});

test('the refresh record keeps other promotions when one promotion refreshes on its own', () => {
  const status = require('../lib/refresh-status');
  status.record({ finishedAt: '2026-09-25T10:00:00Z', ok: false, scope: 'all', promotions: [
    { id: 'motd', status: 'failed', reason: 'no key' }, { id: 'nhl', status: 'ok', fetched: 665 }] });
  status.record({ finishedAt: '2026-09-25T11:00:00Z', ok: true, scope: 'nhl', promotions: [{ id: 'nhl', status: 'ok', fetched: 665 }] });
  const saved = status.load();
  assert.equal(saved.lastFullRefreshAt, '2026-09-25T10:00:00Z', 'a targeted refresh is not a full one');
  assert.equal(saved.promotions.find((p) => p.id === 'motd').status, 'failed', 'kept');
  assert.equal(saved.promotions.find((p) => p.id === 'nhl').at, '2026-09-25T11:00:00Z');
});
