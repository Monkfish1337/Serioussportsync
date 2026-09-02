'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const uefa = require('../lib/sources/uefa');
const transform = require('../lib/transform');
const promotions = require('../lib/promotions');
const teamIdentities = require('../lib/team-identities');

test('maps calendar windows to UEFA final-year season identifiers', () => {
  assert.deepEqual(uefa.seasonsForRange('2026-09-01', '2026-12-01'), ['2027']);
  assert.deepEqual(uefa.seasonsForRange('2026-05-01', '2026-08-01'), ['2026', '2027']);
});

test('normalizes official UEFA fixtures using full English club identities', () => {
  const promotion = promotions.all.find((item) => item.id === 'ucl');
  const event = transform.fromUefa({
    id: '2049554', seasonYear: '2027',
    kickOffTime: { date: '2026-09-08', dateTime: '2026-09-08T19:00:00Z' },
    competition: { id: '1', code: 'UCL', metaData: { name: 'UEFA Champions League' } },
    round: { metaData: { name: 'League Phase' } },
    stadium: { translations: { name: { EN: 'Signal Iduna Park' } }, city: { translations: { name: { EN: 'Dortmund' } } } },
    homeTeam: {
      id: '52758', internationalName: 'B. Dortmund', mediumLogoUrl: 'https://img/dortmund.png',
      translations: { displayOfficialName: { EN: 'Borussia Dortmund' } },
    },
    awayTeam: {
      id: '50124', internationalName: 'Atleti', mediumLogoUrl: 'https://img/atletico.png',
      translations: { displayOfficialName: { EN: 'Atlético de Madrid' } },
    },
  }, promotion);
  assert.equal(event.name, 'Borussia Dortmund vs Atlético de Madrid');
  assert.equal(event.source.type, 'uefa');
  assert.equal(event.source.homeTeamId, '52758');
  assert.equal(event.source.awayTeamName, 'Atlético de Madrid');
  assert.equal(event.round, 'League Phase');
  assert.equal(promotion.searchTitles(event)[0],
    'UEFA Champions League 2026.09.08 Borussia Dortmund vs Atletico Madrid');
});

test('derives scene names for newly qualifying clubs without hardcoded aliases', () => {
  assert.equal(teamIdentities.sceneForm('NK Celje'), 'Celje');
  assert.equal(teamIdentities.sceneForm('ŠK Slovan Bratislava'), 'Slovan Bratislava');
  assert.equal(teamIdentities.sceneForm('FK Bodø/Glimt'), 'Bodo Glimt');
  assert.equal(teamIdentities.sceneForm('AEK Athens FC'), 'AEK Athens');

  const promotion = promotions.all.find((item) => item.id === 'ucl');
  const event = transform.fromUefa({
    id: 'qualifier-1', seasonYear: '2027',
    kickOffTime: { date: '2026-08-26', dateTime: '2026-08-26T19:00:00Z' },
    competition: { id: '1', code: 'UCL', metaData: { name: 'UEFA Champions League' } },
    round: { metaData: { name: 'Play-offs' } },
    leg: { translations: { name: { EN: '2nd leg' } } },
    homeTeam: {
      id: '10', internationalName: 'Celje', teamCode: 'CEL',
      translations: { displayOfficialName: { EN: 'NK Celje' }, displayName: { EN: 'Celje' } },
    },
    awayTeam: {
      id: '11', internationalName: 'Slovan Bratislava', teamCode: 'SLO',
      translations: { displayOfficialName: { EN: 'ŠK Slovan Bratislava' }, displayName: { EN: 'Slovan Bratislava' } },
    },
  }, promotion);
  const queries = promotion.searchTitles(event);
  assert.equal(queries[0], 'UEFA Champions League 2026.08.26 Celje vs Slovan Bratislava');
  assert.ok(queries.includes(
    'UEFA Champions League 2026.08.26 Play-offs Second Leg Celje vs Slovan Bratislava'
  ));
  assert.equal(promotion.isRelevantStreamTitle(
    'UEFA.Champions.League.2026.08.26.Celje.vs.Slovan.Bratislava.720p.WEB.h264-ULTRAS', event
  ).ok, true);
  assert.equal(promotion.isRelevantStreamTitle(
    'UEFA.Champions.League.2026.08.26.Celje.vs.AEK.Athens.720p.WEB.h264-ULTRAS', event
  ).reason, 'no-away-team-alias');
});
