'use strict';

// Real EPL releases, copied verbatim from a Bitmagnet listing, that SSS was
// discarding. Every one of them was found by the indexer and thrown away by
// the relevance filter — the search was working, the matching was not.
//
//   EPL.26-27.5th.round.ARS-CHE_06.09.26_2160.mkv        → no-away-team-alias
//   EPL.26-27.3rd.round.AVL-ARS_31.08.26_2160.mkv        → no-away-team-alias
//   EPL.26_27.2nd.round.LIV-NFO_29.08.26_2160.mkv        → no-away-team-alias
//   20260905_EPL_26.27_R.03_MCI_vs_COV_[...]_720p.50.mkv → no-date-in-title
//
// Two independent causes:
//
// 1. A club's three-letter code preceded by the OPPONENT'S code. teamPresent
//    checks the word before a match to stop "Inter Milan" matching an AC Milan
//    fixture. In "ARS-CHE" the word before CHE is "ars" — which is neither
//    Chelsea's nor a competition word, so the release was rejected. The
//    opponent in the same fixture is the strongest evidence available, and it
//    was the one case the guard did not allow.
//
// 2. Compact YYYYMMDD dates. Football sets requireDateInTitle, and the date
//    extractor needed separators, so rgfootball.net's leading "20260905" read
//    as no date at all and the whole group's output was rejected.
//
// The searches themselves were also missing the format: rankForSearch drops
// three-letter codes (correctly — "ARS" alone is a useless query), which
// silently dropped the PAIR too. A pair is the opposite of ambiguous.

const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');

const epl = promotions.all.find((p) => p.id === 'epl');

function fixture(name, home, away, date, round) {
  return { id: 'epl:test', promotion: 'epl', name, date, round, teamNames: { home, away } };
}

const ARS = ['Arsenal', 'Arsenal FC', 'ARS'];
const CHE = ['Chelsea', 'Chelsea FC', 'CHE'];
const AVL = ['Aston Villa', 'Aston Villa FC', 'AVL'];
const LIV = ['Liverpool', 'Liverpool FC', 'LIV'];
const NFO = ['Nottingham Forest', 'Nottingham Forest FC', 'NFO'];
const MCI = ['Man City', 'Manchester City FC', 'MCI'];
const COV = ['Coventry City', 'Coventry City FC', 'COV'];

test('a code pair joined by a separator matches its own fixture', () => {
  const cases = [
    [fixture('Arsenal vs Chelsea', ARS, CHE, '2026-09-06', '5'),
      'EPL.26-27.5th.round.ARS-CHE_06.09.26_2160.mkv'],
    [fixture('Aston Villa vs Arsenal', AVL, ARS, '2026-08-31', '3'),
      'EPL.26-27.3rd.round.AVL-ARS_31.08.26_2160.mkv'],
    [fixture('Liverpool vs Nottingham Forest', LIV, NFO, '2026-08-29', '2'),
      'EPL.26_27.2nd.round.LIV-NFO_29.08.26_2160.mkv'],
  ];
  for (const [event, title] of cases) {
    const verdict = epl.isRelevantStreamTitle(title, event);
    assert.equal(verdict.ok, true, title + ' → ' + JSON.stringify(verdict));
  }
});

test('a compact YYYYMMDD date is read as a date', () => {
  const event = fixture('Manchester City vs Coventry City', MCI, COV, '2026-09-05', '3');
  const title = '20260905_EPL_26.27_R.03_MCI_vs_COV_[rgfootball.net]_720p.50.mkv';
  assert.equal(epl.isRelevantStreamTitle(title, event).ok, true);

  // Still a date check, not a bypass: the same fixture a year earlier must not
  // match, or requireDateInTitle would have been quietly disabled.
  const wrongYear = fixture('Manchester City vs Coventry City', MCI, COV, '2025-09-05', '3');
  assert.equal(epl.isRelevantStreamTitle(title, wrongYear).reason, 'wrong-date');
});

test('the opponent allowance does not admit a different club', () => {
  // The guard being relaxed is the one that keeps "Inter Milan" away from an
  // AC Milan fixture. Only the actual opponent may license the preceding word.
  const event = fixture('Arsenal vs Chelsea', ARS, CHE, '2026-09-06', '5');

  // A code pair for a different tie on the same date.
  assert.equal(
    epl.isRelevantStreamTitle('EPL.26-27.5th.round.LIV-NFO_06.09.26_2160.mkv', event).ok,
    false, 'a different fixture must not match');

  // The right pairing on the wrong date is still the wrong release.
  assert.equal(
    epl.isRelevantStreamTitle('EPL.26-27.5th.round.ARS-CHE_06.09.25_2160.mkv', event).reason,
    'wrong-date');

  // One code present, the other absent.
  assert.equal(
    epl.isRelevantStreamTitle('EPL.26-27.5th.round.ARS-BOU_06.09.26_2160.mkv', event).ok,
    false, 'the away side must still be required');
});

test('code pairs are searched for, not only recognised', () => {
  // Finding these releases requires asking for them. Lone codes stay out of
  // the query set; the pair is what carries the specificity.
  const event = fixture('Arsenal vs Chelsea', ARS, CHE, '2026-09-06', '5');
  const titles = epl.searchTitles(event);
  const pairs = titles.filter((t) => /\bARS\b/.test(t) && /\bCHE\b/.test(t));
  assert.ok(pairs.length >= 2, 'expected code-pair queries, got ' + JSON.stringify(pairs));
  assert.ok(pairs.some((t) => /ARS-CHE/.test(t)), 'expected a hyphenated pair: ' + JSON.stringify(pairs));

  // A bare code on its own remains a bad query and must not be emitted.
  assert.ok(!titles.some((t) => /^(?:ARS|CHE)$/.test(t.trim())), 'lone codes must not be queries');
});

test('a compact date is not invented from other eight-digit runs', () => {
  const event = fixture('Arsenal vs Chelsea', ARS, CHE, '2026-09-06', '5');
  // Month 45 and day 99 are not dates; neither is a longer digit run.
  for (const title of [
    'EPL.26-27.ARS-CHE_20264599_2160.mkv',
    'EPL.26-27.ARS-CHE_202609061_2160.mkv',
  ]) {
    const verdict = epl.isRelevantStreamTitle(title, event);
    assert.equal(verdict.ok, false, title + ' → ' + JSON.stringify(verdict));
    assert.equal(verdict.reason, 'no-date-in-title');
  }
});
