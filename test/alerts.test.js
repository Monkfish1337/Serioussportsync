'use strict';

// Alerts (issue #75): Diagnosis findings sent to a webhook once each, cleared
// ones reported, and an optional daily summary. Found on the live server: a
// broken indexer was noticed days later, by hand.

const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-alerts-'));
process.env.SESSION_SECRET ||= 'alerts-test-secret-000000000000000000000000000000000';
process.env.SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.AVAILABILITY_DB_FILE = path.join(dir, 'availability.sqlite');

const test = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../lib/alerts');
const diagnosis = require('../lib/diagnosis');

const NOW = Date.parse('2026-09-29T10:30:00Z');
const H = 3600000;
const today = new Date(NOW).toISOString().slice(0, 10);
const webhook = { webhookUrl: 'https://discord.test/api/webhooks/1/secret-token', format: 'discord', immediate: true, minSeverity: 'warning', dailySummary: false, dailyHour: 9 };

// Every source Diagnosis reads, quiet except for what a test sets.
function quiet(overrides) {
  return Object.assign({
    config: () => ({ publicUrl: 'https://sss.test', refreshIntervalHours: 6 }),
    settings: () => ({ getTmdb: () => ({ apiKey: 'k' }), getFootballData: () => ({ apiKey: 'k' }), getApiFootball: () => ({ apiKey: 'k' }),
      getSportVideo: () => ({ enabled: false }), getProwlarr: () => ({ url: 'http://prowlarr', apiKey: 'k' }), getBitmagnet: () => ({}) }),
    promotions: () => [], events: () => [], overrides: () => [], sanitizeWeekly: () => [], reviewRows: () => [],
    refreshStatus: () => ({ finishedAt: new Date(NOW - H).toISOString(), lastFullRefreshAt: new Date(NOW - H).toISOString(), promotions: [] }),
    queueStatus: () => ({ indexers: [{ name: '720pier', successes: 169, failures: 0, next_at: 0 }], eventStates: [], matchedEvents: [] }),
    clientReports: () => [], sportVideoStatus: () => ({}), sportVideoReleases: () => [], accountHealth: () => [],
    users: () => [{ username: 'admin', role: 'admin', config: { torboxApiKey: 'tb' } }], usenetStatus: () => ({ enabled: false }),
    logs: () => [], availabilityIndex: () => ({ eventReleaseTitles: () => [], storedForEvent: () => [] }),
    coverage: () => null, queueHashes: () => [], torboxStates: () => new Map(),
    journal: () => ({ opens: [], plays: [], downloads: {} }), startAt: () => NOW - 30 * 24 * H, muted: () => ({}),
  }, overrides);
}
const failing720 = () => ({ opens: [], plays: [], downloads: { '720pier': { [today]: { ok: 0, failed: 9, lastFailAt: NOW - H, lastStatus: 'HTTP 500' } } } });

function harness(sources, settings, file) {
  const posts = [];
  return {
    posts,
    run: (now) => alerts.runOnce({ now: () => now || NOW, settings: () => settings || webhook, timeZone: () => 'UTC', origin: 'https://sss.test',
      file: file || path.join(dir, 'state-' + Math.random().toString(36).slice(2) + '.json'), log: () => {},
      collect: () => diagnosis.collect({ now: now || NOW, sources: sources() }),
      fetch: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 204 }; } }),
  };
}

test('a simulated 720pier failure sends one alert, once', async () => {
  const file = path.join(dir, 'state-720.json');
  let journal = failing720;
  const h = harness(() => quiet({ journal: () => journal() }), webhook, file);
  await h.run();
  assert.equal(h.posts.length, 1, 'one message');
  assert.equal(h.posts[0].url, webhook.webhookUrl);
  assert.match(h.posts[0].body.content, /SSS: 1 new problem/);
  assert.match(h.posts[0].body.content, /Critical: 720pier: torrent downloads are failing/);
  assert.match(h.posts[0].body.content, /https:\/\/sss\.test\/admin\/diagnosis/);

  await h.run(NOW + 30 * 60000);
  assert.equal(h.posts.length, 1, 'not repeated while it is still open');

  journal = () => ({ opens: [], plays: [], downloads: { '720pier': { [today]: { ok: 6, failed: 1 } } } });
  await h.run(NOW + 60 * 60000);
  assert.equal(h.posts.length, 2);
  assert.match(h.posts[1].body.content, /SSS: 1 resolved/);
  assert.match(h.posts[1].body.content, /Resolved: 720pier: torrent downloads are failing/);
});

test('nothing is sent without a webhook, or when nothing is wrong', async () => {
  const none = harness(() => quiet({ journal: failing720 }), Object.assign({}, webhook, { webhookUrl: '' }));
  assert.deepEqual(await none.run(), { skipped: 'no-webhook' });
  assert.equal(none.posts.length, 0);
  const calm = harness(() => quiet());
  await calm.run();
  assert.equal(calm.posts.length, 0);
});

test('critical-only skips warnings', async () => {
  const h = harness(() => quiet({ journal: failing720, queueStatus: () => ({ indexers: [
    { name: '720pier', successes: 10, failures: 0 }, { name: 'RuTracker.org', successes: 169, failures: 0 }], eventStates: [], matchedEvents: [] }) }),
  Object.assign({}, webhook, { minSeverity: 'critical' }));
  await h.run();
  assert.equal(h.posts.length, 0, '720pier is not the most productive indexer here, so this is a warning');
});

test('the daily summary goes once a day, after the chosen hour', async () => {
  const file = path.join(dir, 'state-daily.json');
  const settings = Object.assign({}, webhook, { immediate: false, dailySummary: true, dailyHour: 11 });
  const h = harness(() => quiet({ journal: failing720 }), settings, file);
  await h.run(Date.parse('2026-09-29T10:30:00Z'));
  assert.equal(h.posts.length, 0, 'before the hour');
  await h.run(Date.parse('2026-09-29T11:05:00Z'));
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].body.content, /SSS daily summary · 2026-09-29/);
  assert.match(h.posts[0].body.content, /1 critical · 0 warning/);
  await h.run(Date.parse('2026-09-29T17:00:00Z'));
  assert.equal(h.posts.length, 1, 'once a day');
  await h.run(Date.parse('2026-09-30T11:00:00Z'));
  assert.equal(h.posts.length, 2, 'and again the next day');
});

test('payloads match each webhook, and a failed send never leaks the URL', async () => {
  const message = { title: 'T', lines: ['Critical: x'], items: [{ id: 'x' }] };
  assert.deepEqual(alerts.payload('slack', message, ''), { text: '*T*\nCritical: x' });
  assert.deepEqual(alerts.payload('json', message, 'https://sss.test'), { title: 'T', items: [{ id: 'x' }], link: 'https://sss.test/admin/diagnosis' });
  assert.ok(alerts.payload('discord', { title: 'T', lines: ['y'.repeat(3000)], items: [] }, '').content.length <= 1990);
  const out = await alerts.test({ settings: () => webhook, fetch: async (url) => { throw new Error('connect ECONNREFUSED ' + url); } });
  assert.equal(out.ok, false);
  assert.doesNotMatch(out.error, /secret-token/);
});

test('settings keep the webhook encrypted on disk', () => {
  const settings = require('../lib/settings');
  settings.setAlerts({ webhookUrl: webhook.webhookUrl, format: 'slack', immediate: true, dailySummary: true, dailyHour: '7' });
  assert.equal(settings.getAlerts().webhookUrl, webhook.webhookUrl);
  assert.equal(settings.getAlerts().dailyHour, 7);
  const raw = fs.readFileSync(process.env.SETTINGS_FILE, 'utf8');
  assert.doesNotMatch(raw, /secret-token/);
  assert.throws(() => settings.setAlerts({ webhookUrl: 'ftp://nope' }), /http/);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
