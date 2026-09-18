'use strict';

// A tester reported "Money In The Bank" carrying the same date as
// "Saturday Nights Main Event" in the WWE catalog. TSDB's free-key data
// occasionally miscodes an event's dateEvent, and lib/transform.js passes
// raw.dateEvent straight through with no plausibility check — WWE does not
// run two televised shows on the same calendar day, so a same-date
// collision between two distinctly-named events is an upstream data error.
// lib/promotions.js wwe.sanitizeEvents() is the fix: it runs once per
// refresh across the whole promotion's batch (a per-event filter like
// includeEvent can't see siblings) and drops the weaker-metadata record of
// a colliding pair.

const test = require('node:test');
const assert = require('node:assert');
const promotions = require('../lib/promotions');

const wwe = promotions.all.find((p) => p.id === 'wwe');

function ev(overrides) {
  return Object.assign({
    id: 'wwe:0',
    name: 'Placeholder',
    date: '2026-09-06',
    venue: null,
    poster: null,
  }, overrides);
}

test('wwe.sanitizeEvents drops the weaker record of a same-date collision between distinct names', () => {
  const richer = ev({
    id: 'wwe:1', name: 'WWE Saturday Nights Main Event #45',
    venue: 'Madison Square Garden', poster: 'https://example.com/snme.jpg',
  });
  const weaker = ev({
    id: 'wwe:2', name: 'Money In The Bank', venue: null, poster: null,
  });
  const out = wwe.sanitizeEvents([richer, weaker], () => {});
  assert.deepStrictEqual(out.map((e) => e.id), ['wwe:1']);
});

test('wwe.sanitizeEvents leaves distinct dates alone', () => {
  const a = ev({ id: 'wwe:1', name: 'SummerSlam Saturday', date: '2026-08-01' });
  const b = ev({ id: 'wwe:2', name: 'SummerSlam Sunday', date: '2026-08-02' });
  const out = wwe.sanitizeEvents([a, b], () => {});
  assert.deepStrictEqual(out.map((e) => e.id).sort(), ['wwe:1', 'wwe:2']);
});

test('wwe.sanitizeEvents does not treat a same-name/same-date pair as a collision (true dupe ids, handled elsewhere)', () => {
  const a = ev({ id: 'wwe:1', name: 'WWE Main Event #710' });
  const b = ev({ id: 'wwe:2', name: 'WWE Main Event #710' });
  const out = wwe.sanitizeEvents([a, b], () => {});
  assert.strictEqual(out.length, 2);
});

test('wwe.sanitizeEvents leaves distinct WWE Main Event episodes (different numbers, different dates) untouched', () => {
  const events = [
    ev({ id: 'wwe:1', name: 'WWE Main Event #710', date: '2026-05-07' }),
    ev({ id: 'wwe:2', name: 'WWE Main Event #711', date: '2026-05-14' }),
    ev({ id: 'wwe:3', name: 'WWE Main Event #712', date: '2026-05-21' }),
  ];
  const out = wwe.sanitizeEvents(events, () => {});
  assert.strictEqual(out.length, 3);
});
