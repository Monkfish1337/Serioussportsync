'use strict';

// A slow usenet source used to fail permanently, not intermittently.
//
// A stream request must answer inside Nuvio's ~10s patience, so each pipeline
// gets about 7.5s. A Usenet Ultimate or Newznab instance that fans out to
// several indexers routinely needs longer — and a search that times out returns
// nothing AND caches nothing, because only a successful result is recorded. So
// every request repeated the same doomed search, while torrents, which are also
// warmed in the background at a 15s budget, kept working.
//
// Verbatim from a real log:
//   uu: network error: network timeout at: http://192.168.1.16:1337/...
//   stream request complete rows=2 pipelineRows={"usenetUltimate":0,...}
//
// The event had usenet coverage; the pipeline never got long enough to find it.

const test = require('node:test');
const assert = require('node:assert/strict');
const streams = require('../lib/streams');

const { isBudgetFailure, scheduleUsenetBackfill, USENET_BACKFILL_INFLIGHT } = streams._test;

test('a search that ran out of budget is told apart from one that answered', () => {
  // These are the shapes a timed-out usenet search actually returns.
  assert.equal(isBudgetFailure({ ok: false, error: 'network: network timeout at: http://box:1337/search' }), true);
  assert.equal(isBudgetFailure({ ok: false, error: 'network: fetch failed' }), true);
  assert.equal(isBudgetFailure({ ok: false, error: 'ETIMEDOUT' }), true);

  // A source that answered — even to say "nothing here", or to refuse — must
  // not trigger a retry. Backfilling those spends indexer API calls, which are
  // metered per day, to re-learn an answer already given.
  assert.equal(isBudgetFailure({ ok: true, results: [] }), false);
  assert.equal(isBudgetFailure({ ok: false, error: 'not-configured' }), false);
  assert.equal(isBudgetFailure({ ok: false, error: 'http-401' }), false);
  assert.equal(isBudgetFailure({ ok: false, error: 'direct-search-unsupported' }), false);
  assert.equal(isBudgetFailure(null), false);
  assert.equal(isBudgetFailure(undefined), false);
});

test('one backfill per event, however many pipelines time out', async () => {
  const event = { id: 'epl-mun:560553', name: 'Man United vs Ipswich Town', date: '2026-08-30' };
  const lines = [];
  const log = (message) => lines.push(String(message));

  // Both usenet pipelines failing on the same request is the normal case —
  // they usually share one slow host — and must not queue two searches.
  scheduleUsenetBackfill({ event, userConfig: {}, username: 'monkeh', log });
  scheduleUsenetBackfill({ event, userConfig: {}, username: 'monkeh', log });
  assert.equal(USENET_BACKFILL_INFLIGHT.size, 1);
  assert.equal(lines.filter((line) => /ran out of budget/.test(line)).length, 1);

  // A different account gets its own, because provider credentials differ.
  scheduleUsenetBackfill({ event, userConfig: {}, username: 'someone-else', log });
  assert.equal(USENET_BACKFILL_INFLIGHT.size, 2);

  // The slot has to be released, or the event is never backfilled again.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(USENET_BACKFILL_INFLIGHT.size, 0, 'the in-flight marker must clear');
});

test('the backfill can be switched off entirely', () => {
  const previous = process.env.STREAM_USENET_BACKFILL;
  process.env.STREAM_USENET_BACKFILL = 'off';
  try {
    scheduleUsenetBackfill({
      event: { id: 'epl:1', name: 'A vs B', date: '2026-08-30' },
      userConfig: {}, username: 'monkeh', log: () => {},
    });
    assert.equal(USENET_BACKFILL_INFLIGHT.size, 0);
  } finally {
    if (previous === undefined) delete process.env.STREAM_USENET_BACKFILL;
    else process.env.STREAM_USENET_BACKFILL = previous;
  }
});

test('an event with no id is not backfilled', () => {
  scheduleUsenetBackfill({ event: null, userConfig: {}, username: 'monkeh', log: () => {} });
  scheduleUsenetBackfill({ event: {}, userConfig: {}, username: 'monkeh', log: () => {} });
  assert.equal(USENET_BACKFILL_INFLIGHT.size, 0);
});
