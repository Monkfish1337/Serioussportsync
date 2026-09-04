'use strict';

// The "select your team" wizard.
//
// The stated goal was: pick your Premier League club, NFL, NBA and MLB team,
// and the catalogs are produced with no further configuration. The interesting
// part is that a pick produces two different shapes depending on the provider,
// and getting that wrong would quietly cost the user most of their fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const teamPicker = require('../lib/team-picker');
const customPromotions = require('../lib/custom-promotions');
const promotions = require('../lib/promotions');
const transform = require('../lib/transform');
const espn = require('../lib/sources/espn');

const COWBOYS = {
  id: '6', name: 'Dallas Cowboys', fullName: 'Dallas Cowboys', abbreviation: 'DAL',
  crest: 'https://a.espncdn.com/i/teamlogos/nfl/500/dal.png',
  names: ['Dallas Cowboys', 'Dallas', 'Cowboys', 'DAL'],
};
const UNITED = {
  id: '66', name: 'Man United', fullName: 'Manchester United FC', abbreviation: 'MUN',
  crest: 'https://crests.football-data.org/66.png',
};

test.afterEach(() => teamPicker.clearCache());

// A football club gets a team-scoped feed, which is the whole reason the
// shipped Man United promotion spans the league, both cups and Europe.
// Substituting a league feed filtered to one club would silently drop every
// cup and European fixture — the opposite of what was asked for.
test('a football club is given a team feed, not a filtered league', () => {
  const spec = teamPicker.specFor('epl', UNITED);
  assert.equal(spec.source, 'football-data');
  assert.equal(spec.teamId, '66');
  assert.equal(spec.teamFilter, undefined, 'a team feed needs no filter');
  assert.equal(customPromotions.validateSpec(spec).ok, true);
});

// ESPN has no per-team schedule endpoint here, and the league call costs the
// same either way, so a US team fetches its league and keeps its own fixtures.
test('a US team is given its league, narrowed to it', () => {
  const spec = teamPicker.specFor('nfl', COWBOYS);
  assert.equal(spec.source, 'espn');
  assert.equal(spec.league, 'nfl');
  assert.equal(spec.teamFilter.id, '6');
  assert.ok(spec.teamFilter.names.includes('Cowboys'));
  assert.equal(customPromotions.validateSpec(spec).ok, true);
});

test('the narrowing keeps the club\'s fixtures and drops everyone else\'s', () => {
  const promotion = promotions.createGenericPromotion(
    customPromotions.normaliseSpec(teamPicker.specFor('nfl', COWBOYS)));
  const fixture = (home, away, homeId, awayId) => transform.fromWiki(espn.toRaw({
    id: homeId + '-' + awayId, date: '2026-08-29T23:00Z',
    competitions: [{ competitors: [
      { homeAway: 'home', team: { id: homeId, displayName: home, location: home.split(' ')[0], name: home.split(' ').pop(), abbreviation: 'H' } },
      { homeAway: 'away', team: { id: awayId, displayName: away, location: away.split(' ')[0], name: away.split(' ').pop(), abbreviation: 'A' } },
    ] }],
  }, 'nfl'), promotion);

  assert.equal(promotion.includeEvent(fixture('Dallas Cowboys', 'New Orleans Saints', '6', '18')), true);
  assert.equal(promotion.includeEvent(fixture('New Orleans Saints', 'Dallas Cowboys', '18', '6')), true,
    'an away fixture is still the club\'s fixture');
  assert.equal(promotion.includeEvent(fixture('Green Bay Packers', 'Chicago Bears', '9', '3')), false);
});

test('a promotion with no team filter keeps everything', () => {
  assert.equal(promotions.byPrefix.nfl.includeEvent({ name: 'Anything at All' }), true);
});

// Picking the same team twice must update the promotion rather than leaving a
// second copy of its catalogs behind.
test('the same pick always produces the same promotion id', () => {
  assert.equal(teamPicker.promotionIdFor('nfl', COWBOYS), teamPicker.promotionIdFor('nfl', COWBOYS));
  assert.notEqual(teamPicker.promotionIdFor('nfl', COWBOYS),
    teamPicker.promotionIdFor('nba', { id: '6', name: 'Dallas Mavericks', abbreviation: 'DAL' }));
});

test('a chooser reports why it cannot list teams instead of throwing', async () => {
  const unknown = await teamPicker.teamsFor('quidditch');
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.teams, []);

  // No football-data key configured: the wizard says so rather than failing.
  const noKey = await teamPicker.teamsFor('epl', { footballDataApiKey: '' });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /football-data/i);

  // A provider that throws must not take the whole wizard down.
  const broken = await teamPicker.teamsFor('nfl', {
    espn: { fetchTeams: async () => { throw new Error('upstream is down'); } },
  });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /upstream is down/);
});

test('team lists are cached, because they change once a season', async () => {
  let calls = 0;
  const stub = { fetchTeams: async () => { calls += 1; return [{ id: '1', name: 'A Team' }]; } };
  await teamPicker.teamsFor('nfl', { espn: stub });
  const second = await teamPicker.teamsFor('nfl', { espn: stub });
  assert.equal(calls, 1, 'a second read should come from the cache');
  assert.equal(second.cached, true);
  await teamPicker.teamsFor('nfl', { espn: stub, force: true });
  assert.equal(calls, 2, 'force should bypass the cache');
});

test('every chooser names a provider the code can actually reach', () => {
  assert.ok(teamPicker.CHOOSERS.length >= 4);
  for (const chooser of teamPicker.CHOOSERS) {
    assert.ok(chooser.key && chooser.label && chooser.hint);
    if (chooser.provider === 'espn') {
      assert.ok(espn.LEAGUES[chooser.league], chooser.key + ' names an unknown ESPN league');
    } else {
      assert.equal(chooser.provider, 'football-data');
      assert.ok(chooser.competitionId, chooser.key + ' has no competition code');
    }
  }
});
