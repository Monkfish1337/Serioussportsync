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
