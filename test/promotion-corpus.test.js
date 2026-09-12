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

test('MLB ships with its official schedule and keeps its observed RS queries', () => {
  // This used to assert that the torrent pipeline got exactly four queries,
  // led by the hand-written "MLB <year> RS <dmy> <home> @ <away>" form. That
  // was the bug, not the specification: all four are full-name queries
  // carrying a league prefix AND a date — the shape measured to be weakest —
  // and the four-query slice meant the torrent pipeline saw only those and
  // never a nickname pair. MLB returned nothing from Bitmagnet or rutracker
  // while NFL, which has no override at all, worked.
  //
  // The observed forms are kept, because they were taken from real releases.
  // They just no longer stand in front of the queries generated from
  // measurement, and no longer cut the list to four.
  const item = promotion('mlb');
  const event = { name: 'Toronto Blue Jays vs Boston Red Sox', date: '2026-07-25' };
  assert.equal(typeof item.torrentSearchTitles, 'undefined',
    'the torrent path takes the full list and applies its own budget');

  const queries = item.searchTitles(event);
  assert.ok(queries.includes('MLB 2026 RS 25.07.2026 Toronto Blue Jays @ Boston Red Sox'),
    'the observed RS form must survive');
  assert.ok(queries.length > 4, 'and it must no longer be one of only four');

  // The head of the list is what a bounded provider actually sends.
  const bareDated = queries.slice(0, 4);
  assert.ok(bareDated.every((query) => !/^MLB\b/.test(query)),
    'the weakest shape must not lead: ' + bareDated.join(' | '));
  assert.ok(bareDated.some((query) => /\d{4}\.\d{2}\.\d{2}/.test(query)), 'dotted ISO');
  assert.ok(bareDated.some((query) => /\d{2}\.\d{2}\.\d{4}/.test(query)), 'DMY, for rutracker');

  assert.deepEqual(item.source, { type: 'mlb' });
  assert.equal(item.isRelevantStreamTitle(
    'MLB 2026 RS 25.07.2026 Toronto Blue Jays @ Boston Red Sox WEB-DL 720p', event).ok, true);
  assert.equal(item.isRelevantStreamTitle(
    'MLB.2026.07.25.Blue.Jays.Vs.Red.Sox.1080p.WEB.h264-SPORTSNET', event).ok, true,
    'nickname-only, the form the presets were added for');
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

// Man United was removed in 0.89.1 — the Configure-page wizard creates a club
// promotion from a pick now, and keeping a hand-built duplicate of one club
// would have meant two promotions for the same fixtures. Its behaviour is
// covered by test/team-picker.js instead.
test('existing WWE, AEW and Match of the Day rules remain locked', () => {
  assert.equal(promotion('wwe').isRelevantStreamTitle(
    'WWE.Judgment.Day.2003.720p.WEB.H264', { name: 'Judgment Day', date: '2003-05-18' }).ok, true);
  assert.equal(promotion('aew').isRelevantStreamTitle(
    'AEW.All.In.London.2026.1080p.WEB.H264', { name: 'All In London', date: '2026-08-31' }).ok, true);
  assert.ok(promotion('motd').searchTitles(
    { name: 'Match of the Day 02 09 2026', date: '2026-09-02' }).length > 0);
});
