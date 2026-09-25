'use strict';
// NHL as a built-in catalog and a Your teams choice (Discussions #43), on the
// same ESPN adapter as the NBA. Team names are ESPN's own (2026-09-25).
const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');
const presets = require('../lib/team-alias-presets');
const teamPicker = require('../lib/team-picker');

const nhl = promotions.all.find((p) => p.id === 'nhl');
// A real preseason game from ESPN's schedule, 2026-09-25 23:30 UTC.
const game = { id: 'nhl:1', name: 'New York Rangers at New York Islanders', date: '2026-09-25',
  time: '23:30', timestamp: '2026-09-25T23:30Z',
  teamNames: { away: ['New York Rangers', 'Rangers', 'NYR'], home: ['New York Islanders', 'Islanders', 'NYI'] } };

test('NHL ships as an ESPN-backed built-in promotion', () => {
  assert.ok(nhl, 'registered');
  assert.equal(nhl.isCustom, false);
  assert.deepEqual(nhl.source, { type: 'espn', league: 'nhl' });
  assert.equal(nhl.posterShape, 'square');
  assert.ok(nhl.catalogs.length > 0);
});

test('the NHL preset covers all 32 teams and never uses a shared city', () => {
  const preset = presets.getPreset('nhl');
  assert.equal(Object.keys(preset).length, 32);
  assert.ok(preset['Utah Mammoth'].includes('Utah Hockey Club'), 'last season\'s name still matches');
  for (const team of ['New York Islanders', 'New York Rangers']) {
    assert.ok(!preset[team].includes('New York'), team + ' must not claim the shared city');
  }
  assert.ok(presets.listPresetNames().includes('nhl'));
  assert.deepEqual(presets.getLeagueAliasDefaults('nhl'), ['NHL', 'National Hockey League']);
});

test('NHL releases match by full name, nickname and tracker format; wrong teams do not', () => {
  const ok = (title) => nhl.isRelevantStreamTitle(title, game).ok;
  assert.equal(ok('NHL.2026.09.25.New.York.Rangers.vs.New.York.Islanders.720p.WEB'), true);
  assert.equal(ok('NHL 2026.09.25 Rangers vs Islanders 1080p'), true);
  assert.equal(ok('NHL 2026-2027 / PS / 25.09.2026 / New York Rangers @ New York Islanders'), true);
  assert.equal(ok('NHL.2026.09.25.Maple.Leafs.vs.Islanders.720p'), false);
  assert.equal(ok('NHL.2026.09.18.Rangers.vs.Islanders.720p'), false, 'wrong date');
  assert.equal(ok('NHL Tonight 2026.09.25 Rangers Islanders'), false, 'studio show');
});

test('NHL searches lead with nickname pairs', () => {
  const titles = nhl.searchTitles(game);
  assert.equal(titles[0], 'Islanders Rangers 2026.09.25');
  assert.ok(titles.includes('NHL 2026.09.25 Islanders Rangers'));
});

test('NHL teams can be followed from Your teams', () => {
  const chooser = teamPicker.chooser('nhl');
  assert.ok(chooser);
  assert.equal(chooser.provider, 'espn');
  const spec = teamPicker.specFor('nhl', { id: '18', name: 'Toronto Maple Leafs', abbreviation: 'TOR', names: ['Toronto Maple Leafs', 'Maple Leafs', 'TOR'] });
  assert.equal(spec.id, 'nhl-tor');
  assert.equal(spec.league, 'nhl');
  const built = promotions.createGenericPromotion(spec);
  assert.equal(built.reviewParent, 'nhl', 'team searches show on the NHL Review aliases page');
});
