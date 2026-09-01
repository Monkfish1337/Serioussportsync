const test = require('node:test');
const assert = require('node:assert/strict');

const adminLogs = require('../lib/admin-logs');

const rows = [
  { id: 1, ts: Date.UTC(2026, 7, 31, 20, 39, 29, 123), level: 'debug', category: 'stream', user: 'demo', requestId: 'abc123', line: '[stream u=demo] torrent filter summary', fields: { discovered: 153, matched: 2, ready: 1 } },
  { id: 2, ts: Date.UTC(2026, 7, 31, 20, 39, 30, 456), level: 'warn', category: 'stream', user: null, line: 'torrent candidate rejected <unsafe>', fields: { reason: 'wrong-year', decision: 'rejected' } },
];

test('operations console renders controls, diagnostics, and safely escaped rows', () => {
  const html = adminLogs.renderBody({
    rows,
    stats: { total: 2, max: 5000, bytes: 1024, lastId: 2, byLevel: { debug: 1, warn: 1, error: 0, fatal: 0 }, byCategory: { stream: 2 } },
    query: { tail: 'on', substring: 'All In London' },
    preferences: { detailedRejections: true },
  });
  for (const expected of ['Copy visible', '.log', '.ndjson', 'Every rejected title',
    'log-output', 'Rejection detail full', 'torrent filter summary', 'discovered',
    'Auto-scroll', 'data-level="debug"']) {
    assert.match(html, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(html, /&lt;unsafe&gt;/);
  assert.doesNotMatch(html, />\s*<unsafe>/);

  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'page should include its browser controller');
  assert.doesNotThrow(() => new Function(script[1]), 'embedded browser controller should parse');
});

test('log export is chronological, readable, and newline terminated', () => {
  const text = adminLogs.rowsToText(rows);
  assert.equal(text,
    '2026-08-31 20:39:29.123Z DEBUG [stream user=demo rid=abc123] [stream u=demo] torrent filter summary discovered=153 matched=2 ready=1\n'
    + '2026-08-31 20:39:30.456Z WARN  [stream] torrent candidate rejected <unsafe> reason=wrong-year decision=rejected\n');
});

test('query defaults to live mode and bounds the requested line count', () => {
  assert.equal(adminLogs.queryOptions({}).tail, true);
  assert.equal(adminLogs.queryOptions({ tail: 'off' }).tail, false);
  assert.equal(adminLogs.queryOptions({ limit: '999999' }).limit, 5000);
  assert.equal(adminLogs.queryOptions({ limit: '1' }).limit, 50);
});
