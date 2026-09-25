'use strict';

// Diagnosis follows an event's journey and says where it breaks. Each case
// below is a real problem found by hand in September 2026; the point is that
// the page now finds it on its own, files it under the right stage and says
// how to fix it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-diagnosis-'));
process.env.SESSION_SECRET ||= 'diagnosis-test-secret-000000000000000000000000000000';
process.env.AVAILABILITY_DB_FILE = path.join(dir, 'availability.sqlite');

const test = require('node:test');
const assert = require('node:assert/strict');
const diagnosis = require('../lib/diagnosis');
const journal = require('../lib/diagnosis-journal');
const page = require('../lib/admin-diagnosis');

const NOW = Date.parse('2026-09-25T13:00:00Z');
const H = 3600000;
const day = (offset) => new Date(NOW + offset * 86400000).toISOString().slice(0, 10);
const noJournal = () => ({ opens: [], plays: [], downloads: {} });

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
      getSportVideo: () => ({ enabled: true }), getProwlarr: () => ({ url: 'http://prowlarr', apiKey: 'k' }), getBitmagnet: () => ({}) }),
    promotions: () => promotions,
    events: () => [
      { id: 'motogp:1', name: 'Austria GP', date: day(-5) },
      { id: 'wwe-nxt:856', name: 'WWE NXT #856', date: day(-3) },
    ],
    refreshStatus: () => ({ finishedAt: new Date(NOW - H).toISOString(), lastFullRefreshAt: new Date(NOW - H).toISOString(),
      promotions: [{ id: 'motd', status: 'failed', reason: 'TMDB_API_KEY is not configured' }, { id: 'motogp', status: 'ok' }] }),
    queueStatus: () => ({ indexers: [
      { name: '720pier', successes: 169, failures: 3, next_at: NOW + 3 * H },
      { name: 'RuTracker.org', successes: 28, failures: 0, next_at: 0 },
    ], eventStates: [] }),
    overrides: () => [{ promotionId: 'motogp', promotionAliases: ['MotoGP', 'MotoGP 2026x14 San Marino Qualifying'],
      relevanceKeywords: ['motogp'], searchTitleTemplates: ['{name}', '{name} {year}'] }],
    reviewRows: (id) => (id === 'motogp' ? [{ pattern: 'motogp {date} austria', source: 'easynews', flag: 'Repeated zero hits', action: 'active' }] : []),
    clientReports: () => [{ startedAt: new Date(NOW - H).toISOString(), manifest: { verdict: 'pass' }, catalogs: [], events: [
      { verdict: 'fail', promotionName: 'MLB', eventName: 'Cubs at Mets', problems: ['no rows, although SSS holds a release for this event'], warnings: [] },
    ] }],
    sportVideoStatus: () => ({ lastError: '' }),
    sportVideoReleases: () => [],
    users: () => [{ username: 'monkeh', role: 'admin', config: { diyUsenetEnabled: true, torboxApiKey: 'tb' } }],
    usenetStatus: () => ({ enabled: true, discovery: true, playback: false, ready: false }),
    logs: () => [{ ts: NOW - 60000, category: 'prowlarr', line: '[prowlarr] Release download failed' }],
    availabilityIndex: () => ({ eventReleaseTitles: () => [], storedForEvent: () => [] }),
    coverage: () => ({ total: 10, matched: 4, missing: 6, promotions: [{ id: 'motogp', total: 10, missing: 6, reasons: { 'No matches — awaiting retry': 6 } }] }),
    journal: noJournal,
    startAt: (e) => (e.timestamp ? Date.parse(e.timestamp) : NaN),
    muted: () => ({}),
  }, overrides || {});
}

const run = (overrides) => diagnosis.collect({ now: NOW, sources: sources(overrides) });
const titled = (result, re) => result.findings.find((f) => re.test(f.title));
const stage = (result, id) => result.stages.find((s) => s.id === id);

test('each real problem from September is found, filed under its stage, with a fix', () => {
  const result = run();
  const indexer = titled(result, /720pier has failed 3 times/);
  assert.equal(indexer.stage, 'sources');
  assert.equal(indexer.severity, 'critical', 'the most productive indexer failing is critical');
  assert.equal(indexer.fix.href, '/admin/discovery?tab=prowlarr');
  assert.ok(indexer.steps.length >= 3, 'says how to fix it, step by step');
  const alias = titled(result, /MotoGP has learned rules that name one event/);
  assert.equal(alias.stage, 'matching');
  assert.deepEqual(alias.evidence, ['"MotoGP 2026x14 San Marino Qualifying"']);
  assert.equal(alias.fix.href, '/admin/promotions/motogp/research');
  assert.equal(titled(result, /Match of the Day cannot refresh: no TMDB key/).stage, 'schedule');
  assert.ok(titled(result, /Match of the Day failed to refresh/));
  assert.ok(!titled(result, /Match of the Day has no events/), 'the missing key is the cause, reported once');
  assert.ok(titled(result, /WWE NXT has no upcoming episodes/));
  assert.ok(titled(result, /NHL has no events/));
  assert.ok(!titled(result, /Discovered Rugby has no events/), 'Discovered catalogs are built from releases, not a schedule');
  assert.equal(titled(result, /PUBLIC_URL is not set/).stage, 'access');
  assert.equal(titled(result, /MotoGP: 6 of 10 recent events have no saved release/).stage, 'coverage');
  assert.equal(titled(result, /1 event failed the last Client check/).stage, 'playback');
  assert.ok(titled(result, /^Built-in Usenet for monkeh is missing an NNTP provider$/));
  assert.ok(titled(result, /MotoGP: 1 search pattern never find/));
  assert.equal(titled(result, /1 error in "prowlarr"/).stage, 'sources', 'log errors go to the stage they affect');
  assert.equal(result.findings[0].severity, 'critical', 'most severe first');
  assert.deepEqual(result.stages.map((s) => s.id), ['access', 'schedule', 'sources', 'matching', 'coverage', 'playback']);
  assert.equal(stage(result, 'sources').status, 'problem');
  assert.ok(stage(result, 'coverage').vitals.some(([k, v]) => /saved release/.test(k) && /4 of 10/.test(v)));
});

test('a healthy server produces no findings and every stage reads Working', () => {
  const result = run({
    config: () => ({ publicUrl: 'https://sss.example.com', refreshIntervalHours: 6 }),
    settings: () => ({ getTmdb: () => ({ apiKey: 'k' }), getFootballData: () => ({ apiKey: 'k' }), getApiFootball: () => ({ apiKey: 'k' }),
      getSportVideo: () => ({ enabled: true }), getProwlarr: () => ({ url: 'http://p', apiKey: 'k' }), getBitmagnet: () => ({}) }),
    events: () => [{ id: 'motogp:1', date: day(-5) }, { id: 'motd:1', date: day(-5) }, { id: 'wwe-nxt:857', date: day(4) }, { id: 'nhl:1', date: day(1) }],
    refreshStatus: () => ({ finishedAt: new Date(NOW).toISOString(), lastFullRefreshAt: new Date(NOW).toISOString(), promotions: [] }),
    queueStatus: () => ({ indexers: [{ name: '720pier', successes: 169, failures: 0 }], eventStates: [] }),
    overrides: () => [{ promotionId: 'motogp', promotionAliases: ['MotoGP'], relevanceKeywords: ['motogp'], searchTitleTemplates: ['{name}'] }],
    reviewRows: () => [], clientReports: () => [{ startedAt: new Date(NOW).toISOString(), manifest: { verdict: 'pass' }, catalogs: [], events: [] }],
    usenetStatus: () => ({ enabled: true, discovery: true, playback: true, ready: true }), logs: () => [],
    coverage: () => ({ total: 10, matched: 9, missing: 1, promotions: [{ id: 'motogp', total: 10, missing: 1, reasons: {} }] }),
  });
  assert.deepEqual(result.findings.map((f) => f.title), []);
  assert.ok(result.stages.every((s) => s.status === 'ok'));
  assert.ok(result.checked.length >= 15);
});

test('a check that cannot read its source is a notice, not a broken page', () => {
  const result = run({ queueStatus: () => { throw new Error('queue database locked'); } });
  assert.ok(titled(result, /The "indexers" check could not run/));
  assert.ok(titled(result, /PUBLIC_URL/), 'other checks still ran');
});

// Found on the live server on 2026-09-25: Prowlarr 2.6.5 rejected every
// 720pier torrent file. Searches kept returning results, so neither the
// failure counter nor the cookie looked wrong; only the downloads failed.
test('an indexer whose torrent downloads fail is flagged, with the Prowlarr-version step', () => {
  const result = run({ journal: () => ({ opens: [], plays: [], downloads: {
    '720pier': { [day(0)]: { ok: 0, failed: 14, lastFailAt: NOW - H, lastStatus: 'HTTP 500' }, [day(-3)]: { ok: 30, failed: 0, lastOkAt: NOW - 3 * 86400000 } },
    'RuTracker.org': { [day(0)]: { ok: 5, failed: 1, lastFailAt: NOW - H, lastStatus: 'timed out' } },
  } }) });
  const failing = titled(result, /720pier: torrent downloads are failing/);
  assert.equal(failing.severity, 'critical');
  assert.ok(failing.steps.some((s) => /Invalid torrent file/.test(s) && /previous Prowlarr version/.test(s)));
  assert.ok(failing.evidence.includes('Last error: HTTP 500'));
  assert.ok(!titled(result, /720pier has failed 3 times/), 'one finding per indexer, the most specific');
  assert.ok(!titled(result, /RuTracker/), 'an occasional failure is fine');
  assert.ok(stage(result, 'sources').vitals.some(([k, v]) => /downloads/.test(k) && /25% worked \(20\)/.test(v)));
});

test('an indexer that stopped saving matches is flagged even when its failure counter looks fine', () => {
  const result = run({ queueStatus: () => ({
    indexers: [
      { name: '720pier', successes: 169, failures: 1, requests: 19, day: day(0), next_at: 0 },
      { name: 'RuTracker.org', successes: 36, failures: 0, requests: 91, day: day(0), next_at: 0 },
    ],
    matchedEvents: [{ event: 'mlb:1', at: NOW - 4 * 86400000, indexers: ['720pier'] }, { event: 'mlb:2', at: NOW - H, indexers: ['RuTracker.org'] }],
    eventStates: [],
  }) });
  const stopped = titled(result, /720pier has saved nothing since/);
  assert.equal(stopped.severity, 'critical');
  assert.ok(!titled(result, /RuTracker/));
});

test('weekly-show rules are judged as they are used, after episode numbers are stripped', () => {
  const result = run({
    promotions: () => [{ id: 'wwe-raw', name: 'WWE Raw', enabled: true, weeklyShow: true, source: { type: 'thesportsdb' }, isRelevantStreamTitle: () => ({ ok: true }) }],
    overrides: () => [{ promotionId: 'wwe-raw', promotionAliases: ['WWE Raw', 'WWE Monday Night Raw S34E36'],
      relevanceKeywords: ['wwe monday night raw s34e36'], searchTitleTemplates: ['{name}'] }],
    sanitizeWeekly: require('../lib/promotion-overrides').sanitizeWeekly,
  });
  assert.ok(!titled(result, /learned rules/), 'S34E36 is never searched with');
});

test('coverage advice follows the reason: an unselected promotion points at the Prowlarr selection', () => {
  const result = run({ coverage: () => ({ total: 47, matched: 9, missing: 38, promotions: [{ id: 'nhl', total: 47, missing: 38,
    reasons: { 'Not selected for Prowlarr; no saved match recorded': 38 } }] }) });
  const nhl = titled(result, /NHL: 38 of 47 recent events have no saved release/);
  assert.equal(nhl.severity, 'warning', 'unconfigured, not broken');
  assert.equal(nhl.fix.href, '/admin/discovery?tab=prowlarr');
});

test('playback: empty opens of past events, failed plays and accounts that cannot play', () => {
  const events = [
    { id: 'mlb:1', name: 'Cardinals vs Pirates', date: day(-2), timestamp: new Date(NOW - 2 * 86400000).toISOString() },
    { id: 'mlb:2', name: 'Tomorrow game', date: day(1), timestamp: new Date(NOW + 86400000).toISOString() },
  ];
  const opens = [];
  for (let i = 0; i < 6; i++) opens.push({ at: NOW - i * H, eventId: 'mlb:1', user: 'monkeh', ms: 20000, rows: i < 4 ? 0 : 3 });
  for (let i = 0; i < 5; i++) opens.push({ at: NOW - i * H, eventId: 'mlb:2', user: 'monkeh', ms: 900, rows: 0 });
  const plays = [
    { at: NOW - H, eventId: 'mlb:1', provider: 'TB', outcome: 'not-cached' },
    { at: NOW - H, eventId: 'mlb:1', provider: 'TB', outcome: 'not-cached' },
    { at: NOW - H, eventId: 'mlb:1', provider: 'TB', outcome: 'error', error: 'TorBox 401' },
    { at: NOW - H, eventId: 'mlb:1', provider: 'TB', outcome: 'ok' },
  ];
  const result = run({
    events: () => events, journal: () => ({ opens, plays, downloads: {} }),
    users: () => [{ username: 'monkeh', role: 'admin', config: { torboxApiKey: 'tb' } }, { username: 'guest', role: 'user', config: {} }],
  });
  const empty = titled(result, /of past events opened today showed no links/);
  assert.ok(empty, 'future events with no links are not counted');
  assert.match(empty.title, /^67%/, '4 of 6 opens of the aired game; the unaired game is ignored');
  assert.equal(empty.fix.href, '/admin/diagnosis?tab=event&q=mlb%3A1');
  assert.ok(titled(result, /One open in ten takes over/));
  const plays2 = titled(result, /3 of 4 plays failed today/);
  assert.match(plays2.detail, /no longer cached/);
  assert.deepEqual(titled(result, /1 account cannot play anything/).evidence, ['guest']);
  assert.ok(stage(result, 'playback').vitals.some(([k, v]) => k === 'Plays that started' && v === '1 of 4'));
});

test('a hidden finding stays hidden until it gets worse', () => {
  const muted = { 'coverage:motogp': { until: NOW + 86400000, severity: 'critical' }, 'public-url': { until: NOW + 86400000, severity: 'notice' },
    'upcoming:wwe-nxt': { until: NOW - 1, severity: 'warning' } };
  const result = run({ muted: () => muted });
  assert.ok(!titled(result, /MotoGP: 6 of 10/), 'hidden');
  assert.ok(result.hidden.some((f) => f.id === 'coverage:motogp'));
  assert.ok(titled(result, /PUBLIC_URL/), 'hidden as a notice, now a warning: shown again');
  assert.ok(titled(result, /WWE NXT has no upcoming/), 'expired');
});

test('hiding and showing a finding is saved', () => {
  const saved = () => { const s = sources(); delete s.muted; return diagnosis.collect({ now: NOW, sources: s }); };
  diagnosis.mute('public-url', 'warning', 30, NOW);
  assert.ok(saved().hidden.some((f) => f.id === 'public-url'));
  diagnosis.unmute('public-url');
  assert.ok(!saved().hidden.length);
});

// ---------------------------------------------------------------- one event

const f1 = (overrides) => sources(Object.assign({
  events: () => [{ id: 'f1:2408188', name: 'Azerbaijan Grand Prix Practice 2', date: '2026-09-24', timestamp: '2026-09-24T12:30:00Z' }],
  promotions: () => [{ id: 'f1', name: 'Formula 1', enabled: true, source: { type: 'thesportsdb' } }],
}, overrides));
const verdicts = (r) => Object.fromEntries(r.steps.map((s) => [s.id, s.verdict]));

test('troubleshooting a working event passes every step', () => {
  const lines = [
    { ts: NOW - 5000, line: '[stream] stream request started', fields: { eventId: 'f1:2408188', queryVariants: ['F1 2026 Azerbaijan FP2'] } },
    { ts: NOW - 4000, line: '[stream] torrent candidate rejected', fields: { eventId: 'f1:2408188', reason: 'practice(1≠2)', releaseTitle: 'Formula1.2026.Round15.Azerbaijan.FP1.1080p' } },
  ];
  const result = diagnosis.investigate('f1:2408188', { now: NOW, sources: f1({
    availabilityIndex: () => ({ storedForEvent: ({ provider }) => (provider === 'torrent' ? [{ title: 'Formula1.2026.Round15.Azerbaijan.FP2.1080p', infoHash: 'a'.repeat(40) }] : []) }),
    logs: () => lines,
    journal: () => ({ opens: [{ at: NOW - H, eventId: 'f1:2408188', user: 'monkeh', ms: 2100, rows: 10 }],
      plays: [{ at: NOW - H, eventId: 'f1:2408188', user: 'monkeh', provider: 'TB', outcome: 'ok' }], downloads: {} }),
  }) });
  assert.deepEqual(verdicts(result), { listed: 'pass', aired: 'pass', searched: 'pass', found: 'pass', shown: 'pass', played: 'pass' });
  assert.equal(result.verdict.text, 'Working');
  assert.equal(result.rejections[0].reason, 'practice(1≠2)');
  assert.deepEqual(result.queries, ['F1 2026 Azerbaijan FP2']);
  const html = page.renderEvent(result);
  assert.match(html, /Working/);
  assert.match(html, /\/admin\/promotions\/f1\/aliases/);
  assert.match(html, /\/admin\/client-check\?eventId=f1%3A2408188/);
});

test('troubleshooting stops at the step that fails', () => {
  // Releases were found but all turned down.
  const rejected = diagnosis.investigate('f1:2408188', { now: NOW, sources: f1({
    logs: () => [{ ts: NOW, line: 'rejected', fields: { eventId: 'f1:2408188', reason: 'practice(1≠2)', releaseTitle: 'F1.FP1' } }],
    journal: () => ({ opens: [{ at: NOW - H, eventId: 'f1:2408188', ms: 9000, rows: 0 }], plays: [], downloads: {} }),
  }) });
  assert.equal(rejected.verdict.step, 'found');
  assert.equal(rejected.steps.find((s) => s.id === 'found').fix.href, '/admin/promotions/f1/research');
  assert.match(page.renderEvent(rejected), /Where it breaks/);

  // Saved, but the account got no links: the debrid side.
  const hidden = diagnosis.investigate('f1:2408188', { now: NOW, sources: f1({
    availabilityIndex: () => ({ storedForEvent: ({ provider }) => (provider === 'torrent' ? [{ title: 'F1.FP2' }] : []) }),
    journal: () => ({ opens: [{ at: NOW - H, eventId: 'f1:2408188', user: 'guest', ms: 900, rows: 0 }], plays: [], downloads: {} }),
  }) });
  assert.equal(hidden.verdict.step, 'shown');
  assert.match(hidden.steps.find((s) => s.id === 'shown').summary, /SSS holds releases, but guest got no links/);
});

test('an event that has not aired, or has only just finished, is "not ready yet", not broken', () => {
  const future = diagnosis.investigate('f1:x', { now: NOW, sources: f1({ events: () => [{ id: 'f1:x', name: 'Qualifying', date: day(2), timestamp: new Date(NOW + 2 * 86400000).toISOString() }] }) });
  assert.equal(future.verdict.tone, 'wait');
  assert.ok(!future.steps.some((s) => s.verdict === 'fail'));
  const recent = diagnosis.investigate('f1:y', { now: NOW, sources: f1({ events: () => [{ id: 'f1:y', name: 'Race', date: day(0), timestamp: new Date(NOW - 3 * H).toISOString() }] }) });
  assert.equal(recent.verdict.tone, 'wait');
  assert.match(recent.steps.find((s) => s.id === 'aired').summary, /few hours after the end/);
});

test('an event search that matches several lists them, newest first', () => {
  const search = diagnosis.investigate('grand prix', { now: NOW, sources: sources({ events: () => [
    { id: 'f1:1', name: 'Azerbaijan Grand Prix', date: '2026-09-27' }, { id: 'f1:2', name: 'Spanish Grand Prix', date: '2026-09-13' }] }) });
  assert.equal(search.event, null);
  assert.deepEqual(search.matches.map((e) => e.id), ['f1:1', 'f1:2']);
});

// ---------------------------------------------------------------- page and journal

test('the overview reads as a journey: stages, Start here, fixes and hiding', () => {
  const html = page.render({ tab: 'overview', findings: run() });
  for (const label of ['Access', 'Schedule', 'Sources', 'Matching', 'Coverage', 'Playback']) assert.match(html, new RegExp('href="#stage-' + label.toLowerCase() + '"'));
  assert.match(html, /problems need attention/);
  assert.match(html, /Start here/);
  assert.match(html, /How to fix/);
  assert.match(html, /action="\/admin\/diagnosis\/hide"/);
  assert.match(html, /href="\/admin\/client-check"/, 'Client check is a Diagnosis tab');
  const healthy = page.render({ tab: 'overview', findings: { at: new Date(NOW).toISOString(), summary: { critical: 0, warning: 0, notice: 0 },
    findings: [], hidden: [], checked: [], stages: diagnosis.STAGES.map((s) => Object.assign({}, s, { findings: [], vitals: [], status: 'ok' })) } });
  assert.match(healthy, /Everything is working/);
  assert.doesNotMatch(healthy, /Start here/);
  const tools = page.render({ tab: 'tools' });
  assert.match(tools, /Review aliases/);
  assert.match(tools, /Prowlarr queue/);
});

test('the journal records opens, plays and downloads, and keeps seven days', () => {
  journal._reset(path.join(dir, 'journal.json'));
  journal.recordOpen({ at: NOW, eventId: 'mlb:1', user: 'monkeh', ms: 1234.4, rows: 5, pipelines: { torbox: 5 } });
  journal.recordOpen({ at: NOW - 8 * 86400000, eventId: 'mlb:old', ms: 1, rows: 0 });
  journal.recordPlay({ at: NOW, eventId: 'mlb:1', user: 'monkeh', provider: 'TB', outcome: 'ok', ms: 800 });
  journal.recordDownload('720pier', false, 'HTTP 500', NOW);
  journal.recordDownload('720pier', true, '', NOW);
  journal.flush();
  journal._reset(path.join(dir, 'journal.json'));
  const saved = journal.snapshot();
  assert.deepEqual(saved.opens.map((o) => o.eventId), ['mlb:1'], 'older than seven days is dropped');
  assert.equal(saved.opens[0].ms, 1234);
  assert.equal(saved.plays[0].outcome, 'ok');
  const today = saved.downloads['720pier'][new Date(NOW).toISOString().slice(0, 10)];
  assert.equal(today.ok, 1);
  assert.equal(today.failed, 1);
  assert.equal(today.lastStatus, 'HTTP 500');
  journal._reset();
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

test('a queued promotion missing games offers Search now, sent as a form that returns here', () => {
  const result = run({ queueStatus: () => ({ indexers: [], eventStates: [], options: { enabled: true, promotions: ['motogp'] } }) });
  const gap = titled(result, /MotoGP: 6 of 10/);
  assert.deepEqual(gap.fix.post, { action: '/admin/prowlarr-discovery/search-now', fields: { back: '/admin/diagnosis#stage-coverage', promotion: 'motogp' } });
  const html = page.render({ tab: 'overview', findings: result, flash: 'Searching MOTOGP now' });
  assert.match(html, /<form method="POST" action="\/admin\/prowlarr-discovery\/search-now" class="dx-post"><input type="hidden" name="back" value="\/admin\/diagnosis#stage-coverage"><input type="hidden" name="promotion" value="motogp"><button class="btn sm primary">Search MotoGP now<\/button>/);
  assert.match(html, /Searching MOTOGP now/);
});
