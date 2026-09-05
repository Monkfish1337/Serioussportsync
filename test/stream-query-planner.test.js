'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const streams = require('../lib/streams');
const releaseFilter = require('../lib/sources/release-filter');

test('provider query planner prefers exact fixture dates and enforces its cap', () => {
  const titles = [
    'Bayern vs PSG',
    'Champions League 2026 Bayern vs PSG',
    'UCL 2026 05 06 Bayern vs PSG',
    'Champions League FINAL 2026 05 06 Bayern vs PSG',
    'Bayern vs PSG 2026-05-06',
    'PSG @ Bayern 06.05.2026',
    'PSG vs Bayern',
  ];
  const selected = streams._test.selectProviderQueries(
    titles, { name: 'Bayern vs PSG', date: '2026-05-06' }, 4
  );
  assert.equal(selected.length, 4);
  assert.ok(selected.every((title) => /2026(?:[ .-])05(?:[ .-])06|06\.05\.2026/.test(title)));
});

test('provider query planner preserves a promotion curated release query', () => {
  const titles = [
    'UEFA Champions League 2026.08.25 LASK vs Celtic',
    'LASK vs Celts 2026.08.25',
    'LASK vs Celtic 2026.08.25',
    'LASK vs Celtic FC 2026.08.25',
  ];
  const selected = streams._test.selectProviderQueries(
    titles, { name: 'LASK vs Celtic FC', date: '2026-08-25' }, 3
  );
  // The curated query still leads — that part has not changed. What changed in
  // 0.93.1 is the third slot: "LASK vs Celtic FC" is the same spelling as
  // "LASK vs Celtic" with an affix, so sending both is one query twice. The
  // nickname is a genuinely different spelling, so it is worth the slot.
  assert.deepEqual(selected, [
    'UEFA Champions League 2026.08.25 LASK vs Celtic',
    'LASK vs Celtic 2026.08.25',
    'LASK vs Celts 2026.08.25',
  ]);
});

test('the budget buys different spellings, not different punctuation', () => {
  // Four ways of writing one spelling. Before 0.93.1 all four were sent — the
  // scorer optimises for brevity, and every short-name variant scores alike —
  // so a fixture whose releases use the long club name matched nothing on any
  // provider while Sport-Video, which never issues a text search, kept working.
  const titles = [
    'EPL 2026.08.30 Man United vs Ipswich Town',
    'Man United vs Ipswich Town 2026.08.30',
    'Man United vs Ipswich Town 2026 08 30',
    'Man United vs Ipswich Town 2026-08-30',
    'Ipswich Town vs Man United 2026.08.30',
    'Manchester United vs Ipswich Town 2026.08.30',
  ];
  const selected = streams._test.selectProviderQueries(
    titles, { name: 'Man United vs Ipswich Town', date: '2026-08-30' }, 4
  );
  assert.ok(selected.some((t) => /Manchester United/.test(t)),
    'the long spelling must get a slot: ' + JSON.stringify(selected));

  // Every distinct spelling is tried before any one of them gets a third
  // shape. Leftover budget going back to more punctuation of the best spelling
  // is fine — that only happens once there is nothing new left to try.
  const beforeLong = selected.slice(0, selected.findIndex((t) => /Manchester United/.test(t)));
  assert.ok(beforeLong.length <= 2,
    'the long spelling must not queue behind three shapes of the short one: '
      + JSON.stringify(selected));
});

test('a promotion can opt into non-English sports releases', () => {
  const rows = [{ title: 'UEFA Champions League 06.05.2026 Bayern vs PSG SPANISH 1080p' }];
  assert.equal(releaseFilter.filterSportsNoise(rows, null, null).results.length, 0);
  assert.equal(releaseFilter.filterSportsNoise(rows, null, null, {
    allowForeignLanguage: true,
  }).results.length, 1);
});

// 0.93.2 — the budgets, and why they are different numbers.
test('the live budget stays inside the client\'s patience', () => {
  const streams = require('../lib/streams');
  const source = String(streams.handleStream);

  // The ceiling here is not ours to choose: Nuvio gives up at about ten
  // seconds, and the response still has to merge, dedupe and serialise after
  // the slowest pipeline returns. A 10000ms budget answers at ~10.1s and turns
  // partial results into no results.
  const match = source.match(/STREAM_PIPELINE_TIMEOUT_MS \|\| '(\d+)'/);
  assert.ok(match, 'the live budget must be readable from the source');
  const live = Number(match[1]);
  assert.ok(live >= 9000, 'a slow indexer fan-out needs more than 8s: ' + live);
  assert.ok(live < 10000, 'past the client deadline the user gets nothing at all: ' + live);

  // A caller with nothing waiting on it can ask for more.
  assert.match(source, /Number\(params\.budgetMs\)/,
    'the install check needs to opt out of the client-sized budget');
});

// A release offered by two pipelines is two ways to play it, not a duplicate.
//
// From a real log: 3 TorBox + 10 Usenet Ultimate + 3 Easynews rows arrived and
// 11 went out. Five disappeared — every Easynews row whose release title UU
// had already produced. The user saw Easynews links vanish as soon as UU
// caught up, which reads as results getting worse the more the addon finds.
test('a release offered by two pipelines keeps both rows', () => {
  const merge = streams._test.mergePipelineRows;
  const title = 'EPL.2026.08.30.Man.United.vs.Ipswich.1080p-DARKSPORT';
  const rows = merge([
    ['torbox', [{ name: 'TorBox', title: title + '\n7 GB' }]],
    ['uu', [
      { name: 'Usenet', title: title + '\n7 GB' },
      { name: 'Usenet', title: title + '\n7 GB' },
    ]],
    ['easynews', [{ name: 'Easynews', title: title + '\n7.8 GB' }]],
  ]);

  assert.equal(rows.length, 3, 'one row per pipeline, and the UU duplicate dropped');
  assert.deepEqual(rows.map((r) => r.name), ['TorBox', 'Usenet', 'Easynews']);
});

test('a pipeline returning the same release twice still dedupes', () => {
  const rows = streams._test.mergePipelineRows([
    ['uu', [{ title: 'A\nx' }, { title: 'A\ny' }, { title: 'B\nz' }]],
  ]);
  assert.equal(rows.length, 2, 'within one pipeline a repeat is a duplicate');
});

test('a row that names its own dedupe scope keeps it', () => {
  // nzbdav and nntp share a candidate list and set their own scopes so the
  // two playback paths do not cancel each other out.
  const rows = streams._test.mergePipelineRows([
    ['diy', [
      { name: 'NZB DAV', title: 'A\nx', _sssDedupeScope: 'nzbdav' },
      { name: 'NNTP', title: 'A\nx', _sssDedupeScope: 'nntp' },
    ]],
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]._sssDedupeScope, undefined, 'the marker must not reach the client');
});

test('a row with no title is passed through rather than dropped', () => {
  const rows = streams._test.mergePipelineRows([['torbox', [{ name: 'odd' }, null]]]);
  assert.equal(rows.length, 2, 'a malformed row is the pipeline\'s problem, not the merge\'s');
});
