'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nzbdav = require('../lib/sources/nzbdav');
const { PlaybackProviderError } = require('../lib/playback-provider');

function response(payload, status) {
  const code = status || 200;
  return {
    ok: code >= 200 && code < 300,
    status: code,
    text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

test('submits a validated NZB with the SAB addfile contract', async () => {
  let captured;
  const result = await nzbdav.submitNzb(
    { url: 'http://nzbdav:3000/', apiKey: 'secret-key' },
    '<?xml version="1.0"?><nzb></nzb>',
    {
      title: 'UFC 300: Main/Card',
      category: 'sports',
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return response({ status: true, nzo_ids: ['SABnzbd_nzo_123'] });
      },
    }
  );

  const parsed = new URL(captured.url);
  assert.equal(parsed.pathname, '/api');
  assert.equal(parsed.searchParams.get('mode'), 'addfile');
  assert.equal(parsed.searchParams.get('apikey'), 'secret-key');
  assert.equal(parsed.searchParams.get('nzbname'), 'UFC 300- Main-Card');
  assert.equal(captured.options.method, 'POST');
  assert.match(captured.options.headers['Content-Type'], /^multipart\/form-data; boundary=sss-/);
  assert.match(captured.options.body.toString('utf8'), /name="nzbFile"/);
  assert.equal(result.jobId, 'SABnzbd_nzo_123');
});
test('rejects a non-NZB payload before any network request', async () => {
  let called = false;
  await assert.rejects(nzbdav.submitNzb(
    { url: 'http://nzbdav:3000', apiKey: 'key' },
    '<html>login</html>',
    { fetchImpl: async () => { called = true; } }
  ), (error) => {
    assert.equal(error instanceof PlaybackProviderError, true);
    assert.equal(error.code, 'invalid-nzb');
    return true;
  });
  assert.equal(called, false);
});
test('classifies authentication failures without exposing the API key', async () => {
  await assert.rejects(nzbdav.getQueue(
    { url: 'https://dav.example', apiKey: 'do-not-leak' },
    { fetchImpl: async () => response({ status: false }, 401) }
  ), (error) => {
    assert.equal(error.code, 'auth-failed');
    assert.doesNotMatch(error.message, /do-not-leak/);
    return true;
  });
});

test('supports version-based connection tests', async () => {
  const result = await nzbdav.testConnection(
    { url: 'http://nzbdav:3000', apiKey: 'key' },
    { fetchImpl: async () => response({ status: true, version: '0.7.0' }) }
  );
  assert.deepEqual(result, { ok: true, version: '0.7.0' });
});

test('aborts a stalled request at its deadline', async () => {
  const started = Date.now();
  await assert.rejects(nzbdav.getQueue(
    { url: 'http://nzbdav:3000', apiKey: 'key' },
    {
      timeoutMs: 250,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    }
  ), (error) => {
    assert.equal(error.code, 'timeout');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.ok(Date.now() - started < 1500);
});

test('polls queue and history until an NZB job completes', async () => {
  let historyCalls = 0;
  const result = await nzbdav.waitForJob(
    { url: 'http://nzbdav:3000', apiKey: 'key' },
    'job-123',
    {
      pollIntervalMs: 1,
      jobTimeoutMs: 1000,
      sleep: async () => {},
      fetchImpl: async (url) => {
        const mode = new URL(url).searchParams.get('mode');
        if (mode === 'queue') {
          return response({ queue: { slots: [{ nzo_id: 'job-123', status: 'Downloading' }] } });
        }
        historyCalls += 1;
        return response({ history: { slots: historyCalls < 2 ? [] : [
          { nzo_id: 'job-123', status: 'Completed', storage: '/content/sports/event' },
        ] } });
      },
    }
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.slot.storage, '/content/sports/event');
  assert.equal(historyCalls, 2);
});

test('returns a typed failure from NZB job history', async () => {
  await assert.rejects(nzbdav.waitForJob(
    { url: 'http://nzbdav:3000', apiKey: 'key' },
    'job-bad',
    {
      jobTimeoutMs: 1000,
      fetchImpl: async (url) => {
        const mode = new URL(url).searchParams.get('mode');
        return response(mode === 'history'
          ? { history: { slots: [{ nzo_id: 'job-bad', status: 'Failed', fail_message: 'unpack failed' }] } }
          : { queue: { slots: [] } });
      },
    }
  ), (error) => {
    assert.equal(error.code, 'job-failed');
    assert.match(error.message, /unpack failed/);
    return true;
  });
});
