'use strict';

// Query shapes emitted for a football fixture.
//
// These assertions come from measurement against the live 10.1M-row Bitmagnet
// index, not from taste. Bitmagnet ANDs every term of a query, so each extra
// word is one more thing the release name has to spell exactly the same way:
//
//   MCI COV                       -> 2
//   EPL MCI COV                   -> 2
//   MCI COV 20260905              -> 2
//   Premier League MCI COV        -> 0
//   MCI COV 2026-09-05            -> 0
//   Man City vs Coventry City     -> 0
//
// And from the last full run's log: of 832 queries, 9.4% were productive;
// league-prefixed ones 2.0%; dated ones 2.8%; queries carrying BOTH a league
// prefix and a date hit 0 times in 169 attempts.

const test = require('node:test');
const assert = require('node:assert');
const promotions = require('../lib/promotions');

function eplPromotion() {
  const found = promotions.all.find((p) => p && p.id === 'epl');
  assert.ok(found, 'the epl promotion must exist');
  return found;
}

// A real EPL fixture: both clubs are in the bundled alias preset, which is
// what the three-letter-code forms are drawn from.
const EVENT = {
  id: 'epl:2026-09-05:ars-che',
  name: 'Arsenal FC vs Chelsea FC',
  date: '2026-09-05',
};

const titles = eplPromotion().searchTitles(EVENT);
const lower = titles.map((t) => t.toLowerCase());

test('emits a compact YYYYMMDD date', () => {
  // The form rgfootball and most of the football scene use, and the form SSS
  // emitted zero times across 832 queries before this change.
  assert.ok(lower.some((t) => t.includes('20260905')),
    'no compact-date query in: ' + JSON.stringify(titles));
});

test('emits a bare three-letter code pair', () => {
  // The most specific query available: only a fixture between these two clubs
  // contains both codes, and it adds no word a release might spell otherwise.
  const bare = lower.filter((t) => /^[a-z]{3}[- ][a-z]{3}$/.test(t));
  assert.ok(bare.length > 0, 'no bare code pair in: ' + JSON.stringify(titles));
});

test('never combines a league prefix with a date', () => {
  const leagueWords = ['epl', 'premier league', 'english premier league'];
  const dateForms = ['2026-09-05', '2026.09.05', '2026 09 05', '20260905', '05.09.26'];
  const bad = titles.filter((t) => {
    const l = t.toLowerCase();
    return leagueWords.some((w) => l.includes(w)) && dateForms.some((d) => l.includes(d));
  });
  assert.deepEqual(bad, [], 'league prefix + date scored 0/169 in production');
});

test('multi-word league aliases are not stacked onto a constrained query', () => {
  // "Premier League MCI COV" -> 0 while "EPL MCI COV" -> 2. The prefix is not
  // the problem; the second word of it is.
  const stacked = titles.filter((t) => /^premier league |^english premier league /i.test(t)
    && /\b[A-Z]{3}[- ][A-Z]{3}\b/.test(t));
  assert.deepEqual(stacked, []);
});

test('the code-pair queries survive the per-event query cap', () => {
  // They are generated last, so before the priority ordering they were the
  // first thing the 60-query cap discarded.
  assert.ok(titles.length <= 60);
  const capIndex = lower.findIndex((t) => /^[a-z]{3}[- ][a-z]{3}$/.test(t));
  assert.ok(capIndex >= 0 && capIndex < 20,
    'code pairs must be near the front of the list, got index ' + capIndex);
});

test('still emits the plain fixture name for non-ANDing sources', () => {
  // Prowlarr and the companion are not going away, and Sport-Video names files
  // with the full club names. Precision for one source must not cost the other.
  assert.ok(lower.some((t) => t.includes('arsenal') && t.includes('chelsea')),
    'the full club names must still be queried');
});
