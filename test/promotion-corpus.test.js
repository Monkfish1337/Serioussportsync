'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');

function promotion(id) {
  const found = promotions.all.find((item) => item.id === id);
  assert.ok(found, 'missing shipped promotion: ' + id);
  return found;
}

test('ONE queries lead with the dominant indexed release family', () => {
  const item = promotion('one');
  const event = { name: 'ONE Friday Fights 168 & The Inner Circle 27', date: '2026-09-04' };
  assert.equal(item.searchTitles(event)[0], 'ONE Championship ONE Friday Fights 168');
  assert.equal(item.isRelevantStreamTitle(
    'One Championship ONE Friday Fights 168 60fps 1080p WEBRip h264-TJ', event).ok, true);
});

test('UFC corpus naming remains searchable and precisely matched', () => {
  const item = promotion('ufc');
  const event = { name: 'UFC 330: Makhachev vs Machado Garry', date: '2026-08-22' };
  assert.ok(item.searchTitles(event).includes('UFC 330'));
  assert.equal(item.isRelevantStreamTitle(
    'UFC.330.Makhachev.vs.Machado.Garry.Prelims.1080p.WEB.h264-TRB', event).ok, true);
});

test('F1 accepts round-keyed international releases but rejects support series', () => {
  const item = promotion('f1');
  const event = { name: 'Hungarian Grand Prix Race', date: '2026-07-26', round: 11 };
  assert.ok(item.searchTitles(event).includes('Formula 1 2026 Этап 11'));
  assert.equal(item.isRelevantStreamTitle(
    'Формула 1 / S2026 / Этап 11 / Гонка / 1080p H.264', event).ok, true);
  assert.equal(item.isRelevantStreamTitle(
    'Formula 2 2026 Hungary Weekend Sky Sports F1 HD 1080p', event).ok, false);
});

test('MotoGP accepts an observed combined-class full-weekend package', () => {
  const item = promotion('motogp');
  const event = { name: 'Aragon GP', date: '2026-09-02', round: 13 };
  const title = 'Moto Grand Prix (MotoGP, Moto2, Moto3) 2026 Этап 13 Spain (Aragon) Полный уикэнд 1080p';
  assert.equal(item.isRelevantStreamTitle(title, event).ok, true);
});

test('boxing uses both fighter names from the observed release family', () => {
  const item = promotion('boxing');
  const event = { name: 'Errol Spence Jr. vs Tim Tszyu', date: '2026-07-26' };
  assert.equal(item.isRelevantStreamTitle(
    'Errol Spence Jr. vs. Tim Tszyu 26.07.2026 Boxing 1080p', event).ok, true);
});

test('MLB ships with its official schedule and observed RS date matchup queries', () => {
  const item = promotion('mlb');
  const event = { name: 'Toronto Blue Jays vs Boston Red Sox', date: '2026-07-25' };
  const queries = item.torrentSearchTitles(event);
  assert.equal(queries[0], 'MLB 2026 RS 25.07.2026 Toronto Blue Jays @ Boston Red Sox');
  assert.equal(queries.length, 4);
  assert.deepEqual(item.source, { type: 'mlb' });
  assert.equal(item.isRelevantStreamTitle(
    'MLB 2026 RS 25.07.2026 Toronto Blue Jays @ Boston Red Sox WEB-DL 720p', event).ok, true);
  assert.equal(item.isRelevantStreamTitle(
    'MLB Network Daily Show 25.07.2026 Toronto Blue Jays Boston Red Sox', event).ok, false);
});

test('Champions League gives TorBox three focused scene queries', () => {
  const item = promotion('ucl');
  const event = { name: 'Celje vs Slovan Bratislava', date: '2026-08-26' };
  const queries = item.torrentSearchTitles(event);
  assert.equal(queries.length, 3);
  assert.match(queries[0], /^UEFA Champions League 2026\.08\.26/);
  assert.ok(queries.some((query) => /^Champions League\b/.test(query)));
  assert.ok(queries.some((query) => /^UCL\b/.test(query)));
  assert.equal(item.isRelevantStreamTitle(
    'UEFA.Champions.League.2026.08.26.Celje.vs.Slovan.Bratislava.720p.WEB.h264-ULTRA', event).ok, true);
});

test('existing WWE, AEW, Match of the Day and Man United rules remain locked', () => {
  assert.equal(promotion('wwe').isRelevantStreamTitle(
    'WWE.Judgment.Day.2003.720p.WEB.H264', { name: 'Judgment Day', date: '2003-05-18' }).ok, true);
  assert.equal(promotion('aew').isRelevantStreamTitle(
    'AEW.All.In.London.2026.1080p.WEB.H264', { name: 'All In London', date: '2026-08-31' }).ok, true);
  assert.ok(promotion('motd').searchTitles(
    { name: 'Match of the Day 02 09 2026', date: '2026-09-02' }).length > 0);
  assert.ok(promotion('manutd').torrentSearchTitles({
    name: 'Manchester United FC vs Arsenal FC', date: '2026-09-02', competitionCode: 'PL',
  })[0].startsWith('EPL 2026 09 02'));
});
