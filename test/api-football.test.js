'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const apiFootball = require('../lib/sources/api-football');
const transform = require('../lib/transform');
const promotions = require('../lib/promotions');

test('derives split-year and calendar-year seasons from a fixture window', () => {
  assert.deepEqual(apiFootball.seasonsForRange('2026-05-01', '2026-06-30'), ['2025', '2026']);
  assert.deepEqual(apiFootball.seasonsForRange('2026-06-20', '2026-07-10'), ['2025', '2026']);
  assert.deepEqual(apiFootball.seasonsForRange('2026-09-01', '2026-12-01'), ['2026']);
});

test('normalizes API-Football using full team names and stable identities', () => {
  const promotion = promotions.all.find((item) => item.id === 'ucl');
  assert.ok(promotion);
  const event = transform.fromApiFootball({
    fixture: { id: 987654, date: '2026-05-05T19:00:00+00:00', venue: { name: 'Emirates Stadium', city: 'London' } },
    league: { id: 2, name: 'UEFA Champions League', country: 'World', season: 2025, round: 'Semi-finals', logo: 'https://img/ucl.png' },
    teams: {
      home: { id: 42, name: 'Arsenal', logo: 'https://img/arsenal.png' },
      away: { id: 530, name: 'Atletico Madrid', logo: 'https://img/atletico.png' },
    },
  }, promotion);
  assert.equal(event.name, 'Arsenal vs Atletico Madrid');
  assert.equal(event.source.type, 'api-football');
  assert.equal(event.source.homeTeamId, '42');
  assert.equal(event.source.awayTeamName, 'Atletico Madrid');
  assert.equal(event.round, 'Semi-finals');
});

test('shipped Champions League promotion prioritizes the observed Usenet naming', () => {
  const promotion = promotions.all.find((item) => item.id === 'ucl');
  assert.equal(promotion.source.type, 'uefa');
  assert.equal(promotion.source.competitionId, '1');
  const event = { name: 'Arsenal vs Atletico Madrid', date: '2026-05-05' };
  const queries = promotion.searchTitles(event);
  assert.equal(queries[0], 'UEFA Champions League 2026.05.05 Arsenal vs Atletico Madrid');
  const release = 'UEFA.Champions.League.2026.05.05.Arsenal.vs.Atletico.Madrid.720p.WEB.h264-ULTRAS';
  assert.equal(promotion.isRelevantStreamTitle(release, event).ok, true);
  assert.equal(promotion.isRelevantStreamTitle(
    'UEFA.Womens.Champions.League.2026.05.05.Arsenal.vs.Atletico.Madrid.720p', event
  ).reason, 'excluded:women');
});

test('API-Football provider errors are converted into readable messages', () => {
  assert.equal(apiFootball._providerError({ errors: { token: 'Invalid token' } }), 'token: Invalid token');
  assert.equal(apiFootball._providerError({ errors: [] }), '');
});
