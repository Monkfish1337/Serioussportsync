const test = require('node:test');
const assert = require('node:assert/strict');

const adminLogs = require('../lib/admin-logs');

const rows = [
  { id: 1, ts: Date.UTC(2026, 7, 31, 20, 39, 29, 123), level: 'log', category: 'stream', user: 'demo', line: 'torrent SUMMARY: 153 raw -> 2 post-relevance' },
  { id: 2, ts: Date.UTC(2026, 7, 31, 20, 39, 30, 456), level: 'warn', category: 'stream', user: null, line: 'torrent REJECT [wrong-year] <unsafe>' },
];

test('operations console renders controls, diagnostics, and safely escaped rows', () => {
  const html = adminLogs.renderBody({
    rows,
    stats: { total: 2, max: 5000, byLevel: { log: 1, warn: 1, error: 0 }, byCategory: { stream: 2 } },
    query: { tail: 'on', substring: 'All In London' },
    preferences: { detailedRejections: true },
  });
  for (const expected of ['Copy visible', 'Download .log', 'Show every rejected title',
    'log-output', 'Rejection diagnostics enabled', 'torrent SUMMARY']) {
    assert.match(html, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(html, /&lt;unsafe&gt;/);
  assert.doesNotMatch(html, />\s*<unsafe>/);
});

test('log export is chronological, readable, and newline terminated', () => {
  const text = adminLogs.rowsToText(rows);
  assert.equal(text,
    '2026-08-31 20:39:29.123Z LOG   [stream user=demo] torrent SUMMARY: 153 raw -> 2 post-relevance\n'
    + '2026-08-31 20:39:30.456Z WARN  [stream] torrent REJECT [wrong-year] <unsafe>\n');
});

test('query defaults to live mode and bounds the requested line count', () => {
  assert.equal(adminLogs.queryOptions({}).tail, true);
  assert.equal(adminLogs.queryOptions({ tail: 'off' }).tail, false);
  assert.equal(adminLogs.queryOptions({ limit: '999999' }).limit, 5000);
  assert.equal(adminLogs.queryOptions({ limit: '1' }).limit, 50);
});
