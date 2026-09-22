'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-usenet-engine-'));
process.env.SETTINGS_FILE = path.join(dir, 'settings.json');

const settings = require('../lib/settings');
const page = require('../lib/account-usenet-page');
const telemetry = require('../lib/sources/nntp-telemetry');

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

