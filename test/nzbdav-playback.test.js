'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const playback = require('../lib/sources/nzbdav-playback');

const config = {
  enabled: true,
  api: { url: 'http://nzbdav:3000', apiKey: 'api-secret' },
  webdav: { url: 'http://nzbdav:3000', username: 'dav', password: 'pass' },
  category: 'sports',
};

test('downloads, submits, waits, and discovers only after resolution', async () => {
  const calls = [];
  const result = await playback.resolveCandidate(config, {
    nzbUrl: 'https://indexer.example/get/1?apikey=hidden',
    title: 'UFC 300: Main Card',
  }, {
    downloadNzb: async () => { calls.push('download'); return Buffer.from('<nzb></nzb>'); },
    submitNzb: async (_cfg, _nzb, opts) => {
      calls.push('submit:' + opts.title); return { jobId: 'job-1' };
    },
    waitForJob: async () => {
      calls.push('wait'); return { slot: { status: 'Completed', name: 'UFC 300- Main Card' } };
    },
    discoverVideo: async (_cfg, root) => {
      calls.push('discover:' + root);
      return { url: 'http://nzbdav:3000/content/sports/UFC%20300-%20Main%20Card/main.mkv', size: 99 };
    },
  });
  assert.deepEqual(calls, [
    'download', 'submit:UFC 300- Main Card', 'wait',
    'discover:/content/sports/UFC%20300-%20Main%20Card/',
  ]);
  assert.equal(result.jobId, 'job-1');
  assert.match(result.headers.Authorization, /^Basic /);
});
test('reuses a previously resolved playback target without resubmitting', async () => {
  const result = await playback.resolveCandidate(config, {
    playback: { url: 'http://nzbdav:3000/content/sports/event/main.mkv', size: 42, jobId: 'existing' },
  }, { downloadNzb: async () => { throw new Error('must not run'); } });
  assert.equal(result.jobId, 'existing');
  assert.equal(result.size, 42);
});
test('enforces the NZB response size before buffering', async () => {
  await assert.rejects(playback.downloadNzb('https://indexer.example/get/1', {
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: () => String(17 * 1024 * 1024) },
      body: Readable.from(['<nzb></nzb>']),
    }),
  }), (error) => {
    assert.equal(error.code, 'invalid-nzb');
    return true;
  });
});
