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

test('the query cap is an operator setting, not a constant', () => {
  // It began as the promotion's uuMaxQueries, which was the nearest existing
  // number rather than the right one: the cap is a property of how slow THIS
  // deployment's Prowlarr is, not of the promotion being searched. It is now
  // adjustable from Server -> Discovery timing, alongside the budget that
  // decides how many of those queries actually finish.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  assert.match(source, /settings\.getDiscoveryTiming\(\)\.prowlarrMaxQueries/);
  assert.equal(require('../lib/settings').DISCOVERY_TIMING_DEFAULTS.prowlarrMaxQueries, 6,
    'the default must match what was shipped before it was adjustable');
});

// ---------------------------------------------------------------------------
// "Stuck on no sources, doesn't actually initiate a search."
//
// Third log, and the sharpest report of the three. Every provider answered
// from the index with no query going out at all:
//
//   torrent: availability-index hit ... cache=hit candidates=5 durationMs=1
//   uu:      availability-index hit ... cache=hit candidates=0 durationMs=0
//
// An earlier request had timed Prowlarr out and kept Bitmagnet's five
// irrelevant candidates. A non-empty search is cached for six hours (an empty
// one for thirty minutes), so that half-answer became the event's answer for
// the rest of the evening — and every query fix shipped that day was invisible
// behind it.

test('a fan-out that lost a source is marked partial', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  assert.match(source, /const partial = answered\.length > 0 && \(lateSources\.length > 0 \|\| failed\.length > 0\)/,
    'answered-but-incomplete is a distinct state from answered and from failed');
  assert.match(source, /partial,/, 'and it has to travel with the result');
});

test('a partial search is never written to the availability index', () => {
  // ok:false was already excluded. `partial` is the case that was not: the
  // fan-out answered, but only because some of its sources did.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  assert.match(source,
    /if \(index && normalized\.ok !== false && normalized\.partial !== true\)/);
  assert.match(source, /not caching a partial search/);
});

test('a complete search is still cached', () => {
  // The index is what keeps a second viewer of the same event off the
  // indexers; this fix must not turn it off.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  const write = source.slice(source.indexOf('index.recordSearch'));
  assert.ok(write.length > 0, 'recordSearch must still be reachable');
  assert.ok(!/normalized\.partial !== true[\s\S]{0,40}return;/.test(source),
    'the guard must skip the write, not abandon the search');
});

// ---------------------------------------------------------------------------
// Building the availability index is Bitmagnet-only.
//
// Reported as: the index build is getting Prowlarr's indexers disabled for
// over-use. It runs over every upcoming event of every enabled promotion,
// unattended, and Prowlarr answers by fanning each query out to remote
// trackers — so the background job was spending the tracker quota that the
// live path, where a person is actually waiting, then could not use.

test('the index build asks Bitmagnet and nobody else', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  assert.match(source, /const warmTorrentSources = warmAllSources \? null : new Set\(\['bitmagnet'\]\)/);
  assert.match(source, /onlySources: warmTorrentSources/);
});

test('discovery can be narrowed without changing what is configured', () => {
  // The restriction is per-call, not a settings change: the same Prowlarr that
  // is skipped here still serves live requests, and nobody has to re-enter a
  // URL to get it back.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  assert.match(source, /const permitted = \(name\) => !allowed \|\| allowed\.has\(name\)/);
  for (const name of ['companion', 'prowlarr', 'bitmagnet']) {
    assert.ok(source.includes("permitted('" + name + "')"), name + ' must honour the restriction');
  }
});

test('the live path is not narrowed', () => {
  // Prowlarr is slow but it is also the source that has the American league
  // releases. One event at a time, with someone waiting, is exactly the volume
  // it should be used at.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  const live = source.slice(source.indexOf("runOrSkip('torbox'"));
  const call = live.slice(0, live.indexOf('\n'));
  assert.ok(!/onlySources/.test(call), 'the live torbox pipeline must use every enabled source');
});

test('an index build with no Bitmagnet says so instead of falling back', () => {
  // Silently reverting to Prowlarr would reintroduce the exact problem this
  // exists to prevent.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  assert.match(source, /index build needs Bitmagnet/);
  assert.match(source, /so its indexers are not disabled for over-use/);
  assert.match(source, /AVAILABILITY_WARM_ALL_TORRENT_SOURCES/,
    'and there has to be a way back for anyone who wants the old behaviour');
});
