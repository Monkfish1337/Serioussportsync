'use strict';

// Two compounding bugs let every NFL fixture match every American-football
// release on its date. In a real export, 234 of 252 NFL "matches" were wrong —
// college and CFL games attached to NFL fixtures, all of them offered as
// "Warm to TorBox" in the admin console.
//
//   1. Every team check reached its team list by splitting event.name, and the
//      splitter did not know " at " — the separator the ESPN adapter produces.
//      So for NFL and NBA no team check ran at all.
//   2. Relevance then fell through to the keyword check, which was satisfied by
//      Sport-Video's per-category blurb ("NFL CFL UFL NCAAFB …") appended to
//      every index entry in that section of the site.
//
// Either alone is enough to produce the failure, so both are tested here.

const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');
const transform = require('../lib/transform');
const espn = require('../lib/sources/espn');
const sportVideo = require('../lib/sources/sport-video');

// Verbatim from a Sport-Video index entry.
const AMERICAN_FOOTBALL_BLURB =
  ' NFL CFL UFL NCAAFB Torrent Live Stream Video Free Download American football';

function nflEvent(home, away) {
  const raw = espn.toRaw({
    id: home.abbreviation + away.abbreviation,
    date: '2026-08-29T23:00Z',
    competitions: [{ competitors: [
      { homeAway: 'home', team: home },
      { homeAway: 'away', team: away },
    ] }],
  }, 'nfl');
  return transform.fromWiki(raw, promotions.byPrefix.nfl);
}

const SAINTS_AT_COWBOYS = nflEvent(
  { id: '6', displayName: 'Dallas Cowboys', location: 'Dallas', name: 'Cowboys', abbreviation: 'DAL' },
  { id: '18', displayName: 'New Orleans Saints', location: 'New Orleans', name: 'Saints', abbreviation: 'NO' }
);

test('an "Away at Home" fixture name still yields both teams', () => {
  // The adapter's own convention must be one the matcher can read back.
  assert.equal(SAINTS_AT_COWBOYS.name, 'New Orleans Saints at Dallas Cowboys');
  assert.deepEqual(SAINTS_AT_COWBOYS.teamNames.home.slice(0, 2), ['Dallas Cowboys', 'Dallas']);
  assert.deepEqual(SAINTS_AT_COWBOYS.teamNames.away.slice(0, 2), ['New Orleans Saints', 'New Orleans']);
});

test('a different game on the same day is not the fixture', () => {
  const promotion = promotions.byPrefix.nfl;
  // All observed attached to "New Orleans Saints at Dallas Cowboys" in the
  // admin console, each one offered as warmable.
  const others = [
    'New York Giants at New York Jets 28.08.2026',
    'Cincinnati Bengals at Philadelphia Eagles 28.08.2026',
    'North Carolina Tar Heels at TCU Horned Frogs 29.08.2026',
    'Hamilton Tiger-Cats at Calgary Stampeders 29.08.2026',
    'Montreal Alouettes at Winnipeg Blue Bombers 28.08.2026',
    'Detroit Lions at Indianapolis Colts 29.08.2026',
    'Chicago Bears at Tennessee Titans 29.08.2026',
  ];
  for (const title of others) {
    const verdict = promotion.isRelevantStreamTitle(title, SAINTS_AT_COWBOYS);
    assert.equal(verdict.ok, false, 'wrongly accepted: ' + title);
    assert.match(verdict.reason, /team/, 'should be rejected on teams, got: ' + verdict.reason);
  }
});

test('the real fixture still matches, with or without a league prefix', () => {
  const promotion = promotions.byPrefix.nfl;
  for (const title of [
    'New Orleans Saints at Dallas Cowboys 29.08.2026',
    'NFL 2026 08 29 New Orleans Saints at Dallas Cowboys 1080p',
    'NFL 2026 08 29 Saints at Cowboys 1080p',
  ]) {
    assert.equal(promotion.isRelevantStreamTitle(title, SAINTS_AT_COWBOYS).ok, true,
      'should have matched: ' + title);
  }
});

test("the site's category blurb cannot make an unrelated release relevant", () => {
  const events = [SAINTS_AT_COWBOYS];
  const record = (title, date) => ({ title, date, indexTitle: title + AMERICAN_FOOTBALL_BLURB });
  for (const [title, date] of [
    ['North Carolina Tar Heels at TCU Horned Frogs 29.08.2026', '2026-08-29'],
    ['Hamilton Tiger-Cats at Calgary Stampeders 29.08.2026', '2026-08-29'],
    ['New York Giants at New York Jets 28.08.2026', '2026-08-28'],
  ]) {
    const matches = sportVideo.matchRelease(record(title, date), events, promotions, {});
    assert.equal(matches.length, 0, 'blurb wrongly rescued: ' + title);
  }
  const right = record('New Orleans Saints at Dallas Cowboys 29.08.2026', '2026-08-29');
  assert.equal(sportVideo.matchRelease(right, events, promotions, {}).length, 1);
});

// The index title genuinely earns its place for competition-gated promotions:
// the site appends "Spain La Liga", "UEFA Champions League" and the like, and a
// bare "Team vs Team date" release carries no competition of its own. That must
// keep working — the fix narrows when the supplement applies, not whether.
test('the competition suffix still rescues a release that names the right teams', () => {
  const event = {
    id: 'ucl:test', promotion: 'ucl', date: '2026-08-26',
    name: 'AEK Athens vs PFC Levski Sofia',
    teamNames: { home: ['AEK Athens', 'AEK'], away: ['Levski Sofia', 'PFC Levski Sofia'] },
  };
  const card = 'AEK Athens vs Levski Sofia 26.08.2026';
  const withSuffix = {
    title: card, date: '2026-08-26',
    indexTitle: card + ' UEFA Champions League Football torrent download free',
  };
  assert.equal(sportVideo.matchRelease(withSuffix, [event], promotions, {}).length, 1);
});
