'use strict';

// Domestic leagues added from a real Sport-Video scan, where 233 football
// releases matched nothing because no promotion claimed the competition.
//
// The hard part is not the feed, it is that the two sides name clubs
// differently. football-data returns a registered name ("Manchester City FC")
// alongside a broadcast short name ("Man City"), and a release uses whichever
// the group felt like — usually neither exactly. Every case below is a real
// pairing observed in the export or in football-data's own responses.

const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');
const transform = require('../lib/transform');
const espn = require('../lib/sources/espn');

// A football-data match payload, shaped as the API returns it.
function fixture(promotionId, home, away, date) {
  return transform.fromFootballData({
    id: 'fx-' + promotionId,
    utcDate: date + 'T19:00:00Z',
    homeTeam: { id: 1, name: home[0], shortName: home[1], tla: home[2] },
    awayTeam: { id: 2, name: away[0], shortName: away[1], tla: away[2] },
    competition: { name: promotionId, code: 'XX' },
    season: { startDate: date },
  }, promotions.byPrefix[promotionId]);
}

const CELTA = ['RC Celta de Vigo', 'Celta Vigo', 'CEL'];
const SOCIEDAD = ['Real Sociedad de Futbol', 'Real Sociedad', 'RSO'];
const CITY = ['Manchester City FC', 'Man City', 'MCI'];
const ARSENAL = ['Arsenal FC', 'Arsenal', 'ARS'];
const INTER = ['FC Internazionale Milano', 'Inter', 'INT'];
const JUVE = ['Juventus FC', 'Juventus', 'JUV'];
const BAYERN = ['FC Bayern München', 'Bayern Munich', 'FCB'];
const OSNABRUCK = ['VfL Osnabrück', 'Osnabrück', 'OSN'];
const LILLE = ['LOSC Lille', 'Lille', 'LIL'];
const TOULOUSE = ['Toulouse FC', 'Toulouse', 'TOU'];

test('the leagues Sport-Video actually carries are registered', () => {
  for (const id of ['laliga', 'epl', 'efl-championship', 'seriea',
    'brasileirao', 'ligue1', 'bundesliga', 'eredivisie']) {
    const promotion = promotions.byPrefix[id];
    assert.ok(promotion, 'missing promotion: ' + id);
    assert.equal(promotion.source.type, 'football-data');
    assert.ok(promotion.source.competitionId, id + ' has no competition code');
    assert.equal(promotion.catalogs.length, 2);
  }
});

test('a club is recognised whichever naming form the release used', () => {
  const cases = [
    ['laliga', CELTA, SOCIEDAD, '2026-09-03', 'Real Sociedad vs Celta de Vigo 03.09.2026'],
    ['epl', CITY, ARSENAL, '2026-09-03', 'Arsenal vs Manchester City 03.09.2026'],
    ['seriea', INTER, JUVE, '2026-09-03', 'Juventus vs Inter Milan 03.09.2026'],
    ['bundesliga', BAYERN, OSNABRUCK, '2026-09-02', 'Osnabruck vs Bayern Munchen 02.09.2026'],
    ['ligue1', LILLE, TOULOUSE, '2026-09-03', 'Toulouse vs Lille 03.09.2026'],
  ];
  for (const [id, home, away, date, release] of cases) {
    const event = fixture(id, home, away, date);
    const verdict = promotions.byPrefix[id].isRelevantStreamTitle(release, event);
    assert.equal(verdict.ok, true,
      id + ': "' + event.name + '" should match "' + release + '", got ' + JSON.stringify(verdict));
  }
});

// Looser team matching is only safe if it still refuses the near misses. Each
// of these shares words with the fixture and is a different game.
test('a different fixture is still refused', () => {
  const laliga = fixture('laliga', CELTA, SOCIEDAD, '2026-09-03');
  assert.equal(promotions.byPrefix.laliga
    .isRelevantStreamTitle('Toulouse vs Lille 03.09.2026', laliga).ok, false);

  // "Real Madrid" must not be assembled out of "Real Sociedad" plus "Atletico
  // Madrid" — which is why connector words are dropped from both sides while
  // the match stays contiguous.
  const madrid = fixture('epl', ['Real Madrid CF', 'Real Madrid', 'RMA'], ['FC Barcelona', 'Barcelona', 'FCB'], '2026-09-03');
  assert.equal(promotions.byPrefix.epl
    .isRelevantStreamTitle('Real Sociedad vs Atletico Madrid 03.09.2026', madrid).ok, false);

  const city = fixture('epl', CITY, ARSENAL, '2026-09-03');
  assert.equal(promotions.byPrefix.epl
    .isRelevantStreamTitle('Arsenal vs Manchester United 03.09.2026', city).ok, false);
});

test('football-data fixtures carry every naming form the provider supplies', () => {
  const event = fixture('epl', CITY, ARSENAL, '2026-09-03');
  assert.deepEqual(event.teamNames.home, ['Man City', 'Manchester City FC', 'MCI']);
  assert.deepEqual(event.teamNames.away, ['Arsenal', 'Arsenal FC', 'ARS']);
});

// WNBA was the single largest unclaimed block in the scan (56 releases) and
// college football the next American one (33). Both are one line of ESPN
// configuration each, because the adapter already existed.
test('the added ESPN leagues resolve to verified endpoints', () => {
  assert.equal(espn.LEAGUES.wnba.path, 'basketball/wnba');
  assert.equal(espn.LEAGUES.ncaaf.path, 'football/college-football');
  // ESPN still serves a CFL path, but its newest fixture is from 2022, so it is
  // deliberately not offered.
  assert.equal(espn.LEAGUES.cfl, undefined);
  for (const id of ['wnba', 'ncaaf']) {
    const promotion = promotions.byPrefix[id];
    assert.ok(promotion, 'missing promotion: ' + id);
    assert.equal(promotion.source.type, 'espn');
    assert.ok(espn.LEAGUES[promotion.source.league], id + ' points at an unknown league');
  }
});

test('a college fixture matches its release and not the NFL game beside it', () => {
  const [raw] = espn.parseScoreboard({ events: [{
    id: '401', date: '2026-09-03T23:00Z',
    competitions: [{ competitors: [
      { homeAway: 'home', team: { id: '1', displayName: 'Georgia Tech Yellow Jackets', location: 'Georgia Tech', name: 'Yellow Jackets', abbreviation: 'GT' } },
      { homeAway: 'away', team: { id: '2', displayName: 'Colorado Buffaloes', location: 'Colorado', name: 'Buffaloes', abbreviation: 'COLO' } },
    ] }],
  }] }, 'ncaaf');
  const event = transform.fromWiki(raw, promotions.byPrefix.ncaaf);
  const promotion = promotions.byPrefix.ncaaf;
  assert.equal(promotion.isRelevantStreamTitle(
    'Colorado Buffaloes at Georgia Tech Yellow Jackets 03.09.2026', event).ok, true);
  assert.equal(promotion.isRelevantStreamTitle(
    'Idaho Vandals at 21 Utah Utes 03.09.2026', event).ok, false);
});

// Found in the first live export after the leagues shipped: the one genuine
// miss out of 233 matches. football-data registers "Club Atlético de Madrid";
// the release says "Atletico Madrid". "Club" is filler and now strips.
test('a filler club prefix does not hide the club', () => {
  const event = fixture('laliga',
    ['Club Atlético de Madrid', 'Atleti', 'ATM'], ['Málaga CF', 'Málaga', 'MAL'], '2026-08-19');
  assert.equal(promotions.byPrefix.laliga
    .isRelevantStreamTitle('Atletico Madrid vs Malaga 19.08.2026', event).ok, true);
});

// A club name can be a whole word inside a different club's name. AC Milan's
// short name is "Milan", which is present in "Inter Milan" — so both the
// boundary regex and the contiguous matcher said yes, and Serie A would have
// attached an Inter fixture to a Milan one. The preceding word decides: it has
// to belong to the same club.
test('one club is not found inside another club\'s name', () => {
  const milan = fixture('seriea', ['AC Milan', 'Milan', 'MIL'], ['Juventus FC', 'Juventus', 'JUV'], '2026-09-03');
  assert.equal(promotions.byPrefix.seriea
    .isRelevantStreamTitle('Juventus vs Inter Milan 03.09.2026', milan).ok, false);
  assert.equal(promotions.byPrefix.seriea
    .isRelevantStreamTitle('Juventus vs AC Milan 03.09.2026', milan).ok, true);

  // The reverse must still work: Inter really is Inter Milan.
  const inter = fixture('seriea', ['FC Internazionale Milano', 'Inter', 'INT'], ['Juventus FC', 'Juventus', 'JUV'], '2026-09-03');
  assert.equal(promotions.byPrefix.seriea
    .isRelevantStreamTitle('Juventus vs Inter Milan 03.09.2026', inter).ok, true);

  // And a leading word that IS part of the club's own name is not an objection.
  const dortmund = fixture('bundesliga',
    ['Borussia Dortmund', 'Dortmund', 'BVB'], ['FC Bayern München', 'Bayern Munich', 'FCB'], '2026-09-03');
  assert.equal(promotions.byPrefix.bundesliga
    .isRelevantStreamTitle('Bayern Munchen vs Borussia Dortmund 03.09.2026', dortmund).ok, true);

  const sparta = fixture('eredivisie',
    ['Sparta Rotterdam', 'Sparta', 'SPA'], ['PEC Zwolle', 'Zwolle', 'ZWO'], '2026-09-04');
  assert.equal(promotions.byPrefix.eredivisie
    .isRelevantStreamTitle('Sparta Rotterdam vs Zwolle 04.09.2026', sparta).ok, true);
});

// A regression caught by diffing two live exports: 0.87.1's collision rule cost
// one real match. football-data registers Atlético Mineiro as "CA Mineiro", so
// none of its three naming forms contain "Atletico" — and the release writes
// "Atletico Mineiro". The leading word is the club's own name spelled out, but
// the rule could not know that.
//
// The signal is the provider's own abbreviation: a multi-word form beginning
// with a short prefix ("CA") says the club HAS a spelled-out prefix, so a long
// leading word starting with one of those letters is plausibly it. Narrow on
// purpose — a standalone tla must never license this, because MIL would put
// "Inter" back through the gap the rule exists to close.
test('a spelled-out prefix the provider abbreviates is still the same club', () => {
  const MINEIRO = ['CA Mineiro', 'Mineiro', 'CAM'];
  const BAHIA = ['EC Bahia', 'Bahia', 'BAH'];
  const event = fixture('brasileirao', MINEIRO, BAHIA, '2026-07-21');
  assert.equal(promotions.byPrefix.brasileirao
    .isRelevantStreamTitle('Atletico Mineiro vs Bahia 21.07.2026', event).ok, true);

  // A different club whose name also starts with "Atletico" is still refused —
  // the rule licenses the leading word, not the club name behind it.
  assert.equal(promotions.byPrefix.brasileirao
    .isRelevantStreamTitle('Atletico Paranaense vs Bahia 21.07.2026', event).ok, false);

  // And the collision this all guards stays closed.
  const milan = fixture('seriea', ['AC Milan', 'Milan', 'MIL'], ['Juventus FC', 'Juventus', 'JUV'], '2026-09-03');
  assert.equal(promotions.byPrefix.seriea
    .isRelevantStreamTitle('Juventus vs Inter Milan 03.09.2026', milan).ok, false);
});
