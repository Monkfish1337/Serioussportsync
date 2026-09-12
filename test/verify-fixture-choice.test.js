'use strict';

// "Check it works" reported a broken install on a working one.
//
// Reported by a user and reproduced against the live instance. Three attempts,
// all empty:
//
//   UFC Fight Night 287 Hooker vs Parnasse   2026-09-05
//   ONE Fight Night 47                       2026-09-05
//   Italian Grand Prix Practice 3            2026-09-05
//
// Two faults. Every candidate is from the SAME DAY, because taking the newest
// event per promotion and then sorting the whole lot by recency selects for a
// single date — so one thin day takes all three attempts down with it. And one
// of them is a Friday practice session, which is close to the least-uploaded
// thing in the catalogue. The note in addon.js already said that picking the
// least-covered card was the bug; the previous fix picked one anyway, three
// times over.
//
// A miss on a fixture nobody uploads says nothing about the user's setup, which
// is the only question this step exists to answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');

function promotion(id) {
  const found = promotions.all.find((item) => item.id === id);
  assert.ok(found, 'missing promotion: ' + id);
  return found;
}

test('F1 will not spend an attempt on a practice session', () => {
  const f1 = promotion('f1');
  assert.equal(typeof f1.checkWorthiness, 'function');
  assert.ok(f1.checkWorthiness({ name: 'Italian Grand Prix Practice 3' }) < 0,
    'the exact fixture that produced the false negative');
  assert.ok(f1.checkWorthiness({ name: 'Pre-Season Testing' }) < 0);
  // And it prefers the session that actually gets released.
  assert.ok(f1.checkWorthiness({ name: 'Italian Grand Prix Race' })
    > f1.checkWorthiness({ name: 'Italian Grand Prix Qualifying' }));
});

test('MotoGP ranks its sessions the same way', () => {
  const motogp = promotion('motogp');
  assert.ok(motogp.checkWorthiness({ name: 'Aragon GP Practice 1' }) < 0);
  assert.ok(motogp.checkWorthiness({ name: 'Aragon GP' })
    > motogp.checkWorthiness({ name: 'Aragon GP Sprint' }));
});

test('UFC prefers a numbered PPV over a Fight Night', () => {
  const ufc = promotion('ufc');
  assert.ok(ufc.checkWorthiness({ name: 'UFC 330: Makhachev vs Machado Garry' })
    > ufc.checkWorthiness({ name: 'UFC Fight Night 287 Hooker vs Parnasse' }),
    'the Fight Night card is the one the check picked and missed on');
  assert.ok(ufc.checkWorthiness({ name: 'Dana White Contender Series 12' }) < 0);
});

test('a promotion with no opinion is neutral, not excluded', () => {
  // Most promotions have no session structure and should neither be preferred
  // nor skipped. The route treats a missing hook as 0, and anything below 0 is
  // dropped from the candidate list entirely — so a promotion that forgot to
  // implement this must not vanish from the check.
  for (const id of ['nfl', 'mlb', 'epl', 'boxing']) {
    const p = promotion(id);
    if (typeof p.checkWorthiness !== 'function') continue;
    assert.ok(p.checkWorthiness({ name: 'Anything at All' }) >= 0, id);
  }
});

test('the route ranks by worthiness and spreads attempts over days', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'addon.js'), 'utf8');
  assert.match(source, /checkWorthiness/, 'the route has to consult the hook');
  assert.match(source, /if \(worth < 0\) continue;/,
    'an event the promotion says is not worth checking is not a candidate');
  assert.match(source, /DAY_SPREAD_MS/,
    'candidates must not all come from the newest settled day');
  assert.match(source, /\(b\.worth - a\.worth\) \|\| \(b\.when - a\.when\)/,
    'recency breaks ties; it does not lead');
});
