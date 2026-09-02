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
  assert.deepEqual(selected, [
    'UEFA Champions League 2026.08.25 LASK vs Celtic',
    'LASK vs Celtic 2026.08.25',
    'LASK vs Celtic FC 2026.08.25',
  ]);
});

test('a promotion can opt into non-English sports releases', () => {
  const rows = [{ title: 'UEFA Champions League 06.05.2026 Bayern vs PSG SPANISH 1080p' }];
  assert.equal(releaseFilter.filterSportsNoise(rows, null, null).results.length, 0);
  assert.equal(releaseFilter.filterSportsNoise(rows, null, null, {
    allowForeignLanguage: true,
  }).results.length, 1);
});
