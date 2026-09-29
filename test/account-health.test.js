'use strict';

// Per-account pipeline health (issue #76). An account's own TorBox key or
// Easynews login could be refused without anyone knowing: Diagnosis sees the
// server, not each account. Done when an account with an invalid TorBox key
// sees it on Configure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-health-'));
process.env.SESSION_SECRET ||= 'account-health-test-secret-0000000000000000000000000';

const test = require('node:test');
const assert = require('node:assert/strict');
const health = require('../lib/account-health');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const fresh = (name) => health._reset(path.join(dir, name + '.json'));

test('a refused TorBox key is recorded, even though the summary line follows', () => {
  fresh('torbox');
  const request = health.observer('alice');
  request('  torbox: checkcached HTTP 401');
  request('torbox: 0 cached / 3 uncached');
  const [problem] = health.problems('alice', Date.now());
  assert.equal(problem.pipeline, 'torbox');
  assert.equal(problem.kind, 'auth');
  assert.equal(health.message(problem), 'TorBox refused your API key');

  health.observer('alice')('torbox: 2 cached / 1 uncached');
  assert.deepEqual(health.problems('alice', Date.now()), [], 'a later working search clears it');
});

test('Easynews logins, TorBox Usenet keys and other failures are told apart', () => {
  fresh('mixed');
  const request = health.observer('bob');
  request('  easynews: auth failed (HTTP 401) — check creds');
  request('  torbox-usenet: mylist HTTP 403');
  request('  torbox: checkcached HTTP 502');
  const byPipeline = Object.fromEntries(health.problems('bob', Date.now()).map((p) => [p.pipeline, p]));
  assert.equal(health.message(byPipeline.easynews), 'Easynews refused your username or password');
  assert.equal(health.message(byPipeline['torbox-usenet']), 'TorBox Usenet refused your API key for Usenet');
  assert.equal(byPipeline.torbox.kind, 'error');
  assert.equal(health.message(byPipeline.torbox), 'TorBox failed (HTTP 502)');
  assert.deepEqual(health.problems('carol', Date.now()), [], 'other accounts are untouched');
  assert.deepEqual(health.observer('')('torbox: checkcached HTTP 401'), undefined, 'no account, nothing recorded');
});

test('a saved key clears the record, and old failures stop showing after a week', () => {
  fresh('reset');
  health.record('dave', 'torbox', 'auth', 'HTTP 401', NOW);
  assert.equal(health.problems('dave', NOW + 60000).length, 1);
  assert.equal(health.problems('dave', NOW + 8 * 86400000).length, 0, 'stale after a week');
  health.reset('dave', 'torbox');
  assert.equal(health.problems('dave', NOW + 60000).length, 0);
});

test('Configure shows the owner that their TorBox key was refused', () => {
  const configurePage = require('../lib/configure-page');
  const collectionSettings = require('../lib/nuvio-collection-settings');
  const render = (problems) => configurePage.render({
    user: { id: 'u1', username: 'alice', apiToken: 't1', config: { torboxApiKey: 'bad-key' } },
    isAdmin: false, isFirstRun: false, step: 'services', installUrl: 'http://sss.local/u/u1/t1/manifest.json',
    promotions: [], selected: new Set(), selectAll: false, folderOf: {},
    collections: collectionSettings.defaults(), choosers: [], teamPromotions: [], health: problems,
  });
  const html = render([{ pipeline: 'torbox', name: 'TorBox', kind: 'auth', detail: 'HTTP 401', at: NOW }]);
  assert.match(html, /data-tone="bad">Key refused</);
  assert.match(html, /TorBox refused your API key/);
  assert.match(html, /Last seen 2026-09-29 12:00 UTC\. Check the key below/);
  const fine = render([]);
  assert.doesNotMatch(fine, /Key refused|refused your API key/);
  assert.match(fine, /Configured/);
});

test('Diagnosis names the account and the service in Playback', () => {
  const diagnosis = require('../lib/diagnosis');
  const found = diagnosis.CHECKS.accountHealth({ accountHealth: () => [{ username: 'alice', problems: [
    { pipeline: 'torbox', name: 'TorBox', kind: 'auth', detail: 'HTTP 401', at: NOW - 3600000 },
    { pipeline: 'easynews', name: 'Easynews', kind: 'error', detail: 'HTTP 502', at: NOW - 3600000 },
  ] }] }, NOW);
  assert.equal(found.length, 1, 'only refused keys and logins; a passing outage is not an account problem');
  assert.equal(found[0].stage, 'playback');
  assert.equal(found[0].title, 'alice: TorBox refused the API key');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
