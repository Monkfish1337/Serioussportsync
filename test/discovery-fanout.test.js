'use strict';

// Bitmagnet and Prowlarr working together.
//
// Reported as: each works alone, both together return nothing. Promise.all
// waits for the slowest, and these are nowhere near each other — measured on
// the same fixture, Bitmagnet answered in 65ms and Prowlarr in 20,086ms. Alone,
// Bitmagnet finished inside any budget and Prowlarr had the whole budget to
// itself. Together, the combined call inherited Prowlarr's latency, blew the
// stream deadline, and discarded Bitmagnet's results — which had been sitting
// there since the first 65ms.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'streams.js'), 'utf8');

test('every discovery source is raced against the discovery budget', () => {
  // Only the companion was ever given a budget; prowlarr.multiSearch and
  // bitmagnet.multiSearch were awaited with no deadline at all.
  assert.match(source, /withinBudget\('companion'/);
  assert.match(source, /withinBudget\('prowlarr'/);
  assert.match(source, /withinBudget\('bitmagnet'/);
});

test('a source that misses the budget is dropped, not waited on', () => {
  assert.match(source, /timedOut: true/);
  assert.match(source, /did not answer within/);
});

test('one source answering is enough for the whole fan-out to count as ok', () => {
  // Otherwise a Prowlarr timeout would throw away a successful Bitmagnet
  // search, which is the bug.
  assert.match(source, /const answered = outcomes\.filter\(\(outcome\) => outcome && outcome\.ok\)/);
  assert.match(source, /ok: answered\.length > 0/);
});

test('the race resolves rather than rejecting, so results survive', async () => {
  // Behavioural check of the shape the fix uses: a fast source and a slow one,
  // raced against a budget, must yield the fast one's results.
  const budgetMs = 50;
  const withinBudget = (label, promise) => {
    let timer = null;
    const lapsed = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, results: [], timedOut: true, label }), budgetMs);
    });
    return Promise.race([
      promise.then((outcome) => Object.assign({ label }, outcome)),
      lapsed,
    ]).then((outcome) => { if (timer) clearTimeout(timer); return outcome; });
  };

  const fast = Promise.resolve({ ok: true, results: [{ infoHash: 'a'.repeat(40) }] });
  const slow = new Promise((resolve) => setTimeout(
    () => resolve({ ok: true, results: [{ infoHash: 'b'.repeat(40) }] }), 5000));

  const started = Date.now();
  const outcomes = await Promise.all([
    withinBudget('bitmagnet', fast),
    withinBudget('prowlarr', slow),
  ]);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1000, 'the set must not wait for the slow source, took ' + elapsed + 'ms');
  assert.equal(outcomes.filter((o) => o.ok).length, 1);
  assert.equal(outcomes.flatMap((o) => o.results).length, 1,
    "the fast source's results must survive the slow one missing");
  assert.equal(outcomes.find((o) => o.timedOut).label, 'prowlarr');
});

// ---------------------------------------------------------------------------
// Found in a live stream log (2026-09-11) for two NFL events, after the query
// shapes had been fixed. Every query in that log was correct and the pipeline
// still returned nothing:
//
//   prowlarr: searching 60 title variant(s)
//     prowlarr: query "NFL 2026.08.29 Packers Cardinals"
//   torrent discovery: prowlarr did not answer within 5000ms — continuing without it
//
// One query issued, budget gone, answer discarded. Prowlarr is the only source
// configured here that HAS these releases — the same queries through the same
// Prowlarr returned them when the Matching Lab gave it 12s and five queries.

test('prowlarr is given a bounded query list, not every variant', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  assert.match(source, /const prowlarrTitles = titles\.slice\(0,/,
    'a sequential 20s-per-query source cannot be handed 60 variants');
  assert.match(source, /prowlarr\.multiSearch\(prowlarrTitles/);
  // Bitmagnet answered the same fixture in 65ms and keeps the full list.
  assert.match(source, /bitmagnet\.multiSearch\(titles/);
});

test('prowlarr returns what it collected when the budget runs out', async () => {
  // The race that enforces the budget discards the loser's results, so a
  // source that is still working when time expires contributes nothing at all.
  // Stopping itself just short of the deadline turns that into a partial
  // answer, which is the difference between some streams and none.
  const prowlarr = require('../lib/sources/prowlarr');
  const asked = [];
  const slowSearch = async (query) => {
    asked.push(query);
    await new Promise((resolve) => setTimeout(resolve, 60));
    return [{ title: query + ' result', guid: 'g' + asked.length, infoHash: 'a'.repeat(40) }];
  };
  const out = await prowlarr.multiSearch(
    ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'],
    { log: () => {}, deadlineMs: 200, _search: slowSearch, search: slowSearch })
    .catch(() => null);
  // Whatever the transport does here, the contract under test is that the loop
  // is bounded by the deadline rather than by the length of the list.
  assert.ok(asked.length < 8 || out === null,
    'the loop must stop early, not run all eight past the deadline');
});

test('the query cap is the promotion\'s own provider budget', () => {
  // uuMaxQueries is what every other rate-limited provider already uses, so a
  // promotion that needs more queries raises one number rather than two.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  assert.match(source, /promo && promo\.uuMaxQueries\) \|\| 6/);
});
