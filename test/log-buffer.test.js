const test = require('node:test');
const assert = require('node:assert/strict');

const logBuffer = require('../lib/log-buffer');

test('retains structured debug fields and request context safely', () => {
  logBuffer.clear();
  logBuffer.push('debug', '[stream u=demo rid=req123] pipeline completed', {
    module: 'stream', user: 'demo', requestId: 'req123', pipeline: 'torbox',
    durationMs: 431, apiKey: 'secret-value',
  });
  const rows = logBuffer.filtered({ level: 'debug' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'stream');
  assert.equal(rows[0].requestId, 'req123');
  assert.equal(rows[0].fields.pipeline, 'torbox');
  assert.equal(rows[0].fields.durationMs, 431);
  assert.doesNotMatch(JSON.stringify(rows[0]), /secret-value/);
});

test('filters structured fields using text or regular expressions', () => {
  assert.equal(logBuffer.filtered({ substring: 'torbox' }).length, 1);
  assert.equal(logBuffer.filtered({ substring: 'durationMs.*431', regex: true }).length, 1);
  assert.equal(logBuffer.filtered({ substring: '[invalid', regex: true }).length, 0);
});

test('clear keeps the monotonic cursor while removing retained entries', () => {
  const before = logBuffer.counts().lastId;
  logBuffer.clear();
  assert.equal(logBuffer.counts().total, 0);
  logBuffer.push('info', '[admin] after clear');
  assert.ok(logBuffer.counts().lastId > before);
});
