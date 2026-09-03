'use strict';

// Regressions for the admin "Preview refresh" panel hanging on
// "Fetching and comparing events…" with nothing to render.
//
// Two independent causes, both exercised here: TheSportsDB's client had no
// request timeout and an unbounded 429 back-off, and the preview itself had no
// deadline of its own, so any slow adapter left the panel spinning forever.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const tsdb = require('../lib/sources/thesportsdb');
const adminPromotions = require('../lib/admin-promotions');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try { return await run(base); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('TheSportsDB gives up on a 429 it cannot outwait instead of sleeping', async () => {
  let hits = 0;
  await withServer((req, res) => {
    hits += 1;
    // A Retry-After far beyond any sane budget. The old client would have
    // slept through it four times over — roughly seven minutes of a held
    // admin request — before reporting anything.
    res.writeHead(429, { 'retry-after': '600' });
    res.end('rate limited');
  }, async (base) => {
    const started = Date.now();
    await assert.rejects(() => tsdb.getJson(base + '/anything', { retryBudgetMs: 5000 }),
      /rate-limited/i);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, 'expected an immediate refusal, took ' + elapsed + 'ms');
    assert.equal(hits, 1, 'a budget it cannot afford should not be retried');
  });
});

test('TheSportsDB still retries a 429 it can afford', async () => {
  let hits = 0;
  await withServer((req, res) => {
    hits += 1;
    if (hits === 1) { res.writeHead(429, { 'retry-after': '1' }); return res.end('slow down'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ leagues: [{ idLeague: '1' }] }));
  }, async (base) => {
    const json = await tsdb.getJson(base + '/anything', { retryBudgetMs: 30000 });
    assert.equal(hits, 2);
    assert.equal(json.leagues[0].idLeague, '1');
  });
});

test('a source that never answers becomes a preview error, not a hung request', async () => {
  const never = () => new Promise(() => {});
  const started = Date.now();
  const out = await adminPromotions.previewSourceChange('mlb', '', {
    existingEvents: [],
    fetchPromotion: never,
    timeoutMs: 250,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /did not answer within/);
  assert.ok(Date.now() - started < 3000, 'the deadline should fire promptly');
});

test('a source that fails after the deadline does not crash the process', async () => {
  // The abandoned comparison still settles. Without a handler its late
  // rejection would be an unhandled rejection.
  const lateFailure = () => new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error('too late')), 120).unref();
  });
  const out = await adminPromotions.previewSourceChange('mlb', '', {
    existingEvents: [], fetchPromotion: lateFailure, timeoutMs: 40,
  });
  assert.equal(out.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 250));
});
