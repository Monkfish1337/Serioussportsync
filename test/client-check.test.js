'use strict';

// Client check: walks an account's addon over HTTP the way Nuvio does. Boots
// the real app (as test/http-routes.test.js does) so the manifest, catalog,
// meta and stream routes are the ones a client hits.
//
// The old "Check it works" chose the most recent fixture and called a working
// install broken when that fixture had no release yet. The check must choose
// an event SSS holds a release for, and only fail an event like that.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-client-check-'));
process.env.SESSION_SECRET = 'client-check-test-secret-00000000000000000000000000000';
process.env.DATA_FILE = path.join(dir, 'events.json');
process.env.USERS_FILE = path.join(dir, 'users.json');
process.env.SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.SPORT_VIDEO_FILE = path.join(dir, 'sport-video.json');
process.env.CONTENT_STUDIO_FILE = path.join(dir, 'content-studio.json');
process.env.METADATA_SOURCES_FILE = path.join(dir, 'metadata-sources.json');
process.env.CUSTOM_PROMOTIONS_FILE = path.join(dir, 'custom-promotions.json');
process.env.NUVIO_COLLECTIONS_FILE = path.join(dir, 'nuvio-collections.json');
process.env.POSITIVE_CACHE_FILE = path.join(dir, 'positive-cache.json');
process.env.AVAILABILITY_DB_FILE = path.join(dir, 'availability.sqlite');

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const events = [
  { id: 'ufc:9001', promotion: 'ufc', name: 'UFC Fight Night 900', date: day(-1), kind: 'fight-night' },
  { id: 'ufc:9000', promotion: 'ufc', name: 'UFC 400', date: day(-3), kind: 'ppv' },
];
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), events }));

const { createApp } = require('../addon');
const users = require('../lib/users');
const promotions = require('../lib/promotions');
const clientCheck = require('../lib/client-check');

let server;
let origin;
test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

test('the check walks manifest, catalogs, details and streams, and picks the event with a known release', async () => {
  const created = await users.createUser({ username: 'checker', password: 'correct-horse-battery-staple', role: 'admin' });
  // A playback service, so the manifest offers streams. No release exists
  // for the key to find, so nothing is sent to TorBox.
  users.updateUserConfig(created.id, { torboxApiKey: 'client-check-test-key' });
  // Torrent streams need a search source; a closed local port fails at once
  // and without network traffic, which also exercises a failing pipeline.
  require('../lib/settings').setProwlarr({ url: 'http://127.0.0.1:9', apiKey: 'client-check-test' });
  const user = users.findById(created.id);
  const known = new Set(['ufc:9000']);
  const steps = [];
  const report = await clientCheck.run({
    base: origin + '/u/' + user.id + '/' + user.apiToken + '/',
    installUrl: origin + '/u/' + user.id + '/' + user.apiToken + '/manifest.json',
    pageProtocol: 'http:', username: 'checker',
    promotions: promotions.all, events, known, only: ['ufc'],
    onProgress: (text) => steps.push(text),
  });
  assert.equal(report.manifest.verdict, 'pass');
  assert.ok(report.manifest.catalogs > 0);
  assert.ok(report.catalogs.length === report.manifest.catalogs, 'every catalog in the manifest was fetched');
  const ufcRecent = report.catalogs.find((c) => c.id === 'ufc-recent');
  assert.ok(ufcRecent && ufcRecent.items >= 1, 'the UFC recent catalog serves the stored events');
  assert.equal(report.events.length, 1);
  const ufc = report.events[0];
  assert.equal(ufc.eventId, 'ufc:9000', 'the event with a known release, not the most recent one');
  assert.equal(ufc.expected, true);
  assert.equal(ufc.meta.verdict, 'pass', 'event details load');
  // No playback provider is configured here, so a known-release event with no
  // rows is exactly the failure the check exists to report.
  assert.equal(ufc.rows, 0);
  assert.equal(ufc.verdict, 'fail');
  assert.match(ufc.problems.join(' '), /SSS holds a release/);
  assert.ok(ufc.requestId, 'links to the request in Logs');
  assert.ok(ufc.pipelines && typeof ufc.pipelines === 'object', 'per-pipeline outcome is reported');
  assert.ok(steps.some((s) => /Events 1\/1/.test(s)));
});

test('an event with no known release is exploratory, never a failure', () => {
  const picks = clientCheck.selectEvents(events, new Set(['ufc']), new Set(), Date.now());
  assert.deepEqual(picks.map((p) => [p.event.id, p.expected]), [['ufc:9001', false]]);
  const judged = clientCheck.judgeStreams({ streams: [] }, 800, false, 'https:');
  assert.equal(judged.verdict, 'info');
  assert.match(judged.warnings.join(' '), /no release is known/);
});

test('stream judging flags broken rows, timeouts, slowness and http links on an https page', () => {
  const body = {
    streams: [{ name: 'TorBox', title: 'x', url: 'http://sss.example.com/u/1/t/resolve/torbox/e/h' }, { title: 'no link' }],
    diagnostics: { requestId: 'abc', pipelines: { easynews: { status: 'timeout', durationMs: 9000, rows: 0 } } },
  };
  const judged = clientCheck.judgeStreams(body, 16000, true, 'https:');
  assert.equal(judged.verdict, 'fail');
  assert.match(judged.problems.join(' '), /no playable link/);
  assert.match(judged.warnings.join(' '), /easynews timed out/);
  assert.match(judged.warnings.join(' '), /slow/);
  assert.match(judged.warnings.join(' '), /PUBLIC_URL/);
  const lan = clientCheck.judgeStreams({ streams: [{ name: 'NNTP', url: 'http://192.168.1.16:7000/x' }] }, 500, true, 'https:');
  assert.equal(lan.verdict, 'pass', 'LAN playback links are http by design');
});

test('a metadata-only account is valid: streams are not offered, and that is information', () => {
  const manifest = { id: 'x', version: '1', name: 'n', resources: [{ name: 'catalog' }, { name: 'meta' }], types: ['movie'], catalogs: [] };
  const judged = clientCheck.judgeManifest(manifest, 'https://sss.example.com/manifest.json', 'https:');
  assert.equal(judged.streamOffered, false);
  assert.equal(judged.verdict, 'warn');
  assert.deepEqual(judged.problems, []);
});

test('an empty catalog is a warning and a malformed item a failure', () => {
  assert.equal(clientCheck.judgeCatalog({ metas: [] }).verdict, 'warn');
  assert.equal(clientCheck.judgeCatalog({ metas: [{ id: 'a' }] }).verdict, 'fail');
  assert.equal(clientCheck.judgeCatalog({ metas: [{ id: 'a', name: 'A', poster: 'p' }] }).verdict, 'pass');
  assert.equal(clientCheck.judgeManifest({ id: 'x', version: '1', name: 'n', resources: ['catalog', 'meta', 'stream'], types: ['movie'], catalogs: [] },
    'http://sss.example.com/manifest.json', 'https:').verdict, 'warn');
});

test('the admin page renders a report with the log link and sorts failures first', () => {
  const page = require('../lib/admin-client-check');
  const html = page.renderReport({
    account: 'checker', scope: 'all promotions', startedAt: '2026-09-25T12:00:00Z',
    summary: { pass: 1, fail: 1 }, manifest: { verdict: 'pass', version: '1.1.1', catalogs: 2, ms: 10, problems: [], warnings: [] },
    catalogs: [], events: [
      { verdict: 'pass', promotionName: 'NFL', eventId: 'nfl:1', eventName: 'A at B', date: '2026-09-24', expected: true, rows: 3, ms: 900, problems: [], warnings: [], requestId: 'r1', pipelines: {} },
      { verdict: 'fail', promotionName: 'MLB', eventId: 'mlb:1', eventName: 'C at D', date: '2026-09-24', expected: true, rows: 0, ms: 900, problems: ['no rows, although SSS holds a release for this event'], warnings: [], requestId: 'r2', pipelines: {} },
    ],
  });
  assert.ok(html.indexOf('MLB') < html.indexOf('NFL'), 'failures first');
  assert.match(html, /\/admin\/logs\?substring=r2/);
  assert.match(html, /known release/);
});
