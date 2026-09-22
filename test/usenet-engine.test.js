'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-usenet-engine-'));
process.env.SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.SESSION_SECRET = 'usenet-engine-test-secret-00000000000000000000';
process.env.AVAILABILITY_DB_FILE = path.join(dir, 'availability.sqlite');

const settings = require('../lib/settings');
const page = require('../lib/account-usenet-page');
const telemetry = require('../lib/sources/nntp-telemetry');
const nativePipeline = require('../lib/streams')._test.pipelineNativeNntp;

test.after(() => {
  require('../lib/availability-index').closeDefault();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('native Usenet engine settings are bounded and persisted', () => {
  assert.deepEqual(settings.getUsenetEngine(), {
    profile: 'balanced', startupSegments: 1, prefetchSegments: 24,
    articleRetries: 2, articleTimeoutMs: 15000, maxConcurrentStreams: 4,
  });
  settings.setUsenetEngine({
    profile: 'low-latency', startupSegments: 2, prefetchSegments: 18,
    articleRetries: 1, articleTimeoutMs: 9000, maxConcurrentStreams: 3,
  });
  assert.deepEqual(settings.getUsenetEngine(), {
    profile: 'low-latency', startupSegments: 2, prefetchSegments: 18,
    articleRetries: 1, articleTimeoutMs: 9000, maxConcurrentStreams: 3,
  });
  assert.throws(() => settings.setUsenetEngine({ profile: 'unsafe' }), /valid Usenet performance profile/);
});

test('Usenet operations page exposes tuning, migration settings and playback diagnostics', () => {
  telemetry.reset();
  const id = telemetry.begin({ filename: '<release>.mkv', eventId: 'event', startedAt: Date.now() - 25 });
  telemetry.firstByte(id); telemetry.addBytes(id, 1048576); telemetry.finish(id, 'completed');
  const html = page.renderBody({
    cfg: {}, engine: settings.getUsenetEngine(), runtime: telemetry.snapshot(),
    pools: [{ host: 'news.example', busy: 1, idle: 2, waiting: 0, limit: 3 }],
    escapeHtml: (value) => String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    secretField: (label, name) => '<input type="password" aria-label="' + label + '" name="' + name + '">',
  });
  assert.match(html, /Playback performance/);
  assert.match(html, /Startup segments/);
  assert.match(html, /Recent native playback/);
  assert.match(html, /Built-in Usenet/);
  assert.match(html, /&lt;release&gt;\.mkv/);
  assert.doesNotMatch(html, /<release>\.mkv/);
});

test('DIY LAN playback address is validated, saved and shown on the Usenet page', () => {
  assert.equal(settings.getDiyPlaybackOrigin(), '');
  assert.throws(() => settings.setDiyPlaybackOrigin('http://lan.example:7000/resolve'), /only a scheme/);
  assert.throws(() => settings.setDiyPlaybackOrigin('http://user:pass@lan.example:7000'), /credentials/);
  settings.setDiyPlaybackOrigin('http://192.168.1.16:7000/');
  assert.equal(settings.getDiyPlaybackOrigin(), 'http://192.168.1.16:7000');
  const html = page.renderBody({
    cfg: {}, engine: {}, runtime: {active: [], recent: [], totals: {}}, pools: [],
    diyPlaybackOrigin: settings.getDiyPlaybackOrigin(),
    escapeHtml: String, secretField: () => '',
  });
  assert.match(html, /name="diyPlaybackOrigin" value="http:\/\/192\.168\.1\.16:7000"/);
  settings.setDiyPlaybackOrigin('');
});

test('native NNTP rows use the LAN origin while other pipelines retain the manifest origin', async () => {
  const urlCtx = {
    origin: 'https://sports.example', nntpOrigin: 'http://192.168.1.16:7000',
    userId: 'admin', apiToken: 'test-token',
  };
  const rows = await nativePipeline({
    event: {id: 'wwe-raw:123'}, config: {enabled: true, host: 'news.example', port: 563},
    getUsenetCandidates: async () => [{title: 'WWE Raw 2026-09-21', nzbUrl: 'https://indexer.example/get/1'}],
    urlCtx, log: () => {},
  });
  assert.equal(rows.length, 1);
  assert.match(rows[0].name, /Native NNTP \(LAN\)/);
  assert.match(rows[0].url, /^http:\/\/192\.168\.1\.16:7000\/u\//);
  assert.equal(urlCtx.origin, 'https://sports.example');
});

