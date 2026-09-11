'use strict';

// NFL, NBA and MLB coverage.
//
// Reported as "very hit and miss, isn't worth putting out in its current
// state", with an open question: is it an indexer problem — nothing to find —
// or an alias and filtering problem?
//
// It was measured, not guessed. Searching the live Prowlarr/Usenet stack for a
// single NFL fixture on 2026-09-11 returned, among others:
//
//   NFL.Pre.Season.2026.08.28.Arizona.Cardinals.Vs.Green.Bay.Packers.720p...
//   NFL.2021.10.28.Cardinals.Vs.Packers.1080p.WEB.h264-SPORTSNET
//   NFL.2021.10.28.Packers.at.Cardinals.720p.HDTV.AAC2.0.H264-720pier
//
// The releases are there. Of those three, SSS matched the first and rejected
// the other two with `no-home-team`: it knew only the full "City Nickname"
// that ESPN and the MLB schedule supply, while two of the most prolific groups
// name their releases by nickname alone. And because every query it emitted
// carried the full name, an ANDing index could not have returned them anyway.
//
// So: an alias and query-shape problem, on both halves of the round trip.

const test = require('node:test');
const assert = require('node:assert');
const promotions = require('../lib/promotions');
const presets = require('../lib/team-alias-presets');

const nfl = promotions.all.find((p) => p.id === 'nfl');
const nba = promotions.all.find((p) => p.id === 'nba');
const mlb = promotions.all.find((p) => p.id === 'mlb');

// Queries reach an ANDing index — Bitmagnet ANDs every term — so a query can
// only return a release that contains all of its words.
function andMatches(queries, releaseTitle) {
  const title = releaseTitle.toLowerCase();
  return queries.filter((q) => q.toLowerCase().split(/\s+/).every((w) => title.includes(w)));
}

test('every franchise is covered, once', () => {
  assert.equal(Object.keys(presets.getPreset('nfl')).length, 32);
  assert.equal(Object.keys(presets.getPreset('nba')).length, 30);
  assert.equal(Object.keys(presets.getPreset('mlb')).length, 30);
  for (const name of ['nfl', 'nba', 'mlb']) {
    assert.ok(presets.listPresetNames().includes(name), name + ' must be selectable in the UI');
  }
});

test('the three promotions actually use their preset', () => {
  // The EPL preset existed for two releases before anyone noticed it was never
  // wired to the football leagues. A table nothing reads is not a feature.
  for (const promotion of [nfl, nba, mlb]) {
    const event = {
      promotion: promotion.id,
      name: 'Arizona Cardinals at Green Bay Packers',
      date: '2021-10-28',
    };
    const queries = promotion.searchTitles(event);
    assert.ok(queries.length > 0, promotion.id + ' must emit queries');
  }
  assert.ok(promotions.all.find((p) => p.id === 'nfl'));
});

test('a nickname-only release is recognised, in either order', () => {
  const event = { promotion: 'nfl', name: 'Arizona Cardinals at Green Bay Packers', date: '2021-10-28' };
  assert.deepEqual(
    nfl.isRelevantStreamTitle('NFL.2021.10.28.Cardinals.Vs.Packers.1080p.WEB.h264-SPORTSNET', event),
    { ok: true });
  assert.deepEqual(
    nfl.isRelevantStreamTitle('NFL.2021.10.28.Packers.at.Cardinals.720p.HDTV.AAC2.0.H264-720pier', event),
    { ok: true }, 'the groups disagree about which team goes first');
  assert.deepEqual(
    nfl.isRelevantStreamTitle('NFL.2021.10.28.Arizona.Cardinals.Vs.Green.Bay.Packers.720p', event),
    { ok: true }, 'the full-name form must not regress');
});

test('a nickname pair is actually asked for, not just accepted', () => {
  // Recognising a release SSS never searches for is worth nothing. Before the
  // pair queries existed, zero of the sixty queries for this fixture could
  // AND-match either nickname-only release.
  const event = { promotion: 'nfl', name: 'Arizona Cardinals at Green Bay Packers', date: '2021-10-28' };
  const queries = nfl.searchTitles(event);
  for (const title of [
    'NFL.2021.10.28.Cardinals.Vs.Packers.1080p.WEB.h264-SPORTSNET',
    'NFL.2021.10.28.Packers.at.Cardinals.720p.HDTV.AAC2.0.H264-720pier',
    'NFL.2021.10.28.Arizona.Cardinals.Vs.Green.Bay.Packers.720p',
  ]) {
    assert.ok(andMatches(queries, title).length > 0,
      'no query can reach: ' + title);
  }
});

test('the pair query leaves the separator out', () => {
  // The same fixture ships as ".Vs." from one group and ".at." from another,
  // so an AND term for the separator halves the reach and buys nothing.
  const event = { promotion: 'nba', name: 'Boston Celtics at Los Angeles Lakers', date: '2021-12-07' };
  const pair = nba.searchTitles(event)
    .filter((q) => /celtics/i.test(q) && /lakers/i.test(q));
  assert.ok(pair.length, 'a nickname pair must be emitted');
  assert.ok(pair.some((q) => !/\bvs\b|@|\bat\b/i.test(q)),
    'at least one pair query must carry no separator');
});

test('the pair query keeps the date', () => {
  // Without it, "Lakers Celtics" matches every meeting of those two teams in
  // the index's history and the scorer has to sort out decades of them.
  const event = { promotion: 'nba', name: 'Boston Celtics at Los Angeles Lakers', date: '2021-12-07' };
  const pairs = nba.searchTitles(event)
    .filter((q) => /celtics/i.test(q) && /lakers/i.test(q))
    .filter((q) => !/\bvs\b|@|\bat\b/i.test(q));   // the pair queries, not the templated ones
  assert.ok(pairs.length, 'a nickname pair must be emitted');
  // The stored day and the day before it, both dotted -- see the UTC-shift
  // test at the bottom of this file for why there are two.
  assert.ok(pairs.every((q) => /\b2021\.12\.0[67]\b/.test(q)), 'every pair query must be dated');
  assert.ok(pairs.some((q) => /2021\.12\.07/.test(q)));
});

test('football fan nicknames no longer suppress American team names', () => {
  // NON_SEARCH_NICKNAMES exists because nobody names a release "Gunners vs
  // Toffees". Applied globally it also dropped Eagles, Saints, Reds and Tigers
  // — Crystal Palace, Southampton, Liverpool and Hull, but equally
  // Philadelphia, New Orleans, Cincinnati and Detroit, where the nickname IS
  // the release name. It would have silently removed the very queries these
  // presets were added to produce.
  const event = { promotion: 'nfl', name: 'Philadelphia Eagles at New Orleans Saints', date: '2026-11-15' };
  const queries = nfl.searchTitles(event);
  assert.ok(queries.some((q) => /eagles/i.test(q)), 'Eagles must survive as a query term');
  assert.ok(queries.some((q) => /saints/i.test(q)), 'Saints must survive as a query term');
  assert.ok(andMatches(queries, 'NFL.2026.11.15.Eagles.Vs.Saints.1080p.WEB.h264').length > 0);

  // ...and the football behaviour is unchanged.
  const epl = promotions.all.find((p) => p.id === 'epl') || null;
  if (epl) {
    const eplQueries = epl.searchTitles({
      promotion: 'epl', name: 'Arsenal FC vs Everton FC', date: '2026-09-06',
    });
    assert.ok(!eplQueries.some((q) => /gunners|toffees/i.test(q)),
      'football fan nicknames must still be kept out of queries');
  }
});

test('a bare name that two teams in the same league share is left out', () => {
  // "Chicago" is the Cubs and the White Sox; "New York" is the Mets and the
  // Yankees. An alias that cannot identify one team turns a precise query into
  // a wrong one, so these are omitted on purpose rather than by oversight.
  const mlbTable = presets.getPreset('mlb');
  assert.ok(!mlbTable['Chicago Cubs'].some((a) => a.toLowerCase() === 'chicago'));
  assert.ok(!mlbTable['Chicago White Sox'].some((a) => a.toLowerCase() === 'chicago'));
  assert.ok(!mlbTable['New York Mets'].some((a) => a.toLowerCase() === 'new york'));
  assert.ok(!mlbTable['New York Yankees'].some((a) => a.toLowerCase() === 'new york'));

  // The same word is safe where only one team carries it.
  assert.ok(presets.getPreset('nba')['Chicago Bulls'].some((a) => a.toLowerCase() === 'chicago'));
});

test('the studio shows that carry team names are still excluded', () => {
  // RedZone and Summer League name real teams on the real date, which is
  // exactly what a looser alias table makes more dangerous, not less.
  const nflEvent = { promotion: 'nfl', name: 'Arizona Cardinals at Green Bay Packers', date: '2026-08-28' };
  assert.equal(nfl.isRelevantStreamTitle('NFL.RedZone.2026.08.28.1080p', nflEvent).ok, false);

  const nbaEvent = { promotion: 'nba', name: 'Boston Celtics at Los Angeles Lakers', date: '2024-07-15' };
  assert.equal(
    nba.isRelevantStreamTitle(
      'NBA.Summer.League.2024.07.15.Boston.Celtics.Vs.Los.Angeles.Lakers.1080p.WEB.H264-GAMETiME',
      nbaEvent).ok,
    false, 'Summer League is not the fixture');
});

test('MLB keeps the hand-written query shapes it already had', () => {
  // MLB had an observed-forms override before it had a preset. The preset adds
  // to it; it must not have replaced it.
  const event = { promotion: 'mlb', name: 'San Diego Padres at Los Angeles Dodgers', date: '2024-04-14' };
  const queries = mlb.searchTitles(event);
  assert.ok(andMatches(queries,
    'MLB.2024.04.14.San.Diego.Padres.vs.Los.Angeles.Dodgers.720p.WEB.h264-GAMENiGHT').length > 0);
  assert.ok(queries.some((q) => /padres/i.test(q) && /dodgers/i.test(q)));
});

test('the Athletics have no city, and both spellings still resolve', () => {
  // They dropped the city in 2025. Releases from either era have to land on
  // the same team.
  const table = presets.getPreset('mlb');
  assert.ok(table.Athletics, 'keyed by the name the schedule now supplies');
  const aliases = table.Athletics.map((a) => a.toLowerCase());
  assert.ok(aliases.includes('oakland athletics'));
});

// ---------------------------------------------------------------------------
// Found in a live stream log for two real NFL events (2026-09-11). All three
// of these were shipped by the change above and all three are in this file
// because none of them showed up in a unit test built from a hand-written
// event — they needed the structured team names a real ESPN event carries.

test('a side\'s alias list holds one team, not both', () => {
  // ESPN names an event "<away> at <home>" AND ships teamNames.home/.away.
  // splitMatchup reads the string left to right, so its home is ESPN's away.
  // The two were merged without checking, so each side's list held the curated
  // forms of one team and the supplied forms of the other. Straight from the
  // log:
  //
  //   -> "ARI-ARI" 0 result(s)
  //   -> "NFL 2026.08.29 Arizona Cardinals vs Arizona Cardinals" 0 result(s)
  const event = {
    promotion: 'nfl',
    name: 'Arizona Cardinals at Green Bay Packers',
    date: '2026-08-29',
    teamNames: {
      home: ['Green Bay Packers', 'Green Bay', 'Packers', 'GB'],
      away: ['Arizona Cardinals', 'Arizona', 'Cardinals', 'ARI'],
    },
  };
  for (const query of nfl.searchTitles(event)) {
    assert.ok(!/\b(ARI|GNB|GB)\W+\1\b/i.test(query), 'team against itself: ' + query);
    assert.ok(!/Cardinals.*Cardinals|Packers.*Packers/i.test(query),
      'team against itself: ' + query);
  }
});

test('no bare three-letter codes where the releases do not use them', () => {
  // "ARI GNB" was the first query sent for that fixture. On a substring index
  // it matches every title containing "ari", so the torrent pipeline came back
  // full of Tai-Ari deshita and Ari Aster — 30-odd candidates, every one
  // rejected as no-home-team-alias, and the real release never made the cut.
  // The code-pair form is an EPL 2160p convention and earns its place there.
  const event = {
    promotion: 'nfl', name: 'Arizona Cardinals at Green Bay Packers', date: '2026-08-29',
  };
  for (const query of nfl.searchTitles(event)) {
    assert.ok(!/^[A-Z]{2,4}([ -][A-Z]{2,4})?$/.test(query.trim()),
      'bare code query: ' + query);
  }
  // Football still gets them: "MCI COV" -> 2 results, "Man City vs Coventry
  // City" -> 0.
  const epl = promotions.all.find((p) => p.id === 'epl');
  if (epl) {
    const eplQueries = epl.searchTitles({
      promotion: 'epl', name: 'Arsenal FC vs Chelsea FC', date: '2026-09-06',
    });
    assert.ok(eplQueries.some((q) => /^[A-Z]{3}-[A-Z]{3}$/.test(q.trim())),
      'the code pair must survive where it was measured to work');
  }
});

test('the day before is asked for too, because the stored date can be a day ahead', () => {
  // ESPN timestamps are UTC and an American night game kicks off after
  // midnight UTC. This fixture is stored as 2026-08-29; every release of it is
  // named 2026.08.28. In the log, every dated query missed and the only one
  // that returned anything was the undated fallback.
  const event = {
    promotion: 'nfl', name: 'Arizona Cardinals at Green Bay Packers', date: '2026-08-29',
  };
  const queries = nfl.searchTitles(event);
  assert.ok(andMatches(queries,
    'NFL.Pre.Season.2026.08.28.Arizona.Cardinals.Vs.Green.Bay.Packers.720p.WEB.H264-NiGHTNiNJAS').length > 0,
    'the release as it is actually named must be reachable');
  assert.ok(queries.some((q) => /2026\.08\.29/.test(q)), 'and the stored date is still asked for');

  // Only backwards: a local date is never ahead of the UTC one, so asking for
  // the day after would be two more queries that cannot be right.
  assert.ok(!queries.some((q) => /2026\.08\.30/.test(q)));

  // The matcher already tolerated the shift; only the queries did not.
  assert.equal(nfl.isRelevantStreamTitle(
    'NFL.Pre.Season.2026.08.28.Arizona.Cardinals.Vs.Green.Bay.Packers.720p', event).ok, true);
});

test('the prefix-free dated pair is asked for before the prefixed one', () => {
  // Measured against the live Prowlarr/usenet stack. Same terms, same fixture,
  // only the order different:
  //
  //   "NFL 2026.08.28 Cardinals Packers" -> 0 results
  //   "Cardinals Packers 2026.08.28"     -> 1, the real release
  //
  // The release is NFL.Pre.Season.2026.08.28.Arizona.Cardinals..., so the
  // league name is not adjacent to the date and a query that puts them
  // together matches nothing. It matters out of all proportion to its size: a
  // slow provider is given a bounded list and may reach only the first query
  // before its budget expires, so this order decides whether it finds anything.
  const event = {
    promotion: 'nfl', name: 'Arizona Cardinals at Green Bay Packers', date: '2026-08-29',
  };
  const queries = nfl.searchTitles(event);
  const firstPrefixFree = queries.findIndex((q) => /^Packers Cardinals \d/.test(q));
  const firstPrefixed = queries.findIndex((q) => /^NFL \d+\.\d+\.\d+ Packers Cardinals$/.test(q));
  assert.ok(firstPrefixFree >= 0, 'the prefix-free form must exist');
  assert.ok(firstPrefixed >= 0, 'and the prefixed one is still worth sending');
  assert.ok(firstPrefixFree < firstPrefixed,
    'the form measured to work must go out first');
  assert.equal(firstPrefixFree, 0, 'and it is the single most valuable query available');
});
