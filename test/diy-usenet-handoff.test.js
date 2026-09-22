'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-diy-handoff-'));
process.env.SESSION_SECRET = 'diy-handoff-test-secret-000000000000000000';
process.env.PLAYBACK_CANDIDATES_FILE = path.join(dir, 'candidates.json');
process.env.AVAILABILITY_DB_FILE = path.join(dir, 'availability.sqlite');

const streams = require('../lib/streams');
const nzbdavPlayback = require('../lib/sources/nzbdav-playback');

test.after(() => {
  require('../lib/availability-index').closeDefault();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('a discovered candidate becomes an opaque row and resolves through NZB DAV', async () => {
  const event = { id: 'wwe-raw:2026-09-21', name: 'WWE Raw #1739' };
  const config = {
    diyUsenetEnabled: true,
    nzbdavUrl: 'http://nzbdav:3000',
    nzbdavApiKey: 'api-secret',
    nzbdavWebdavUrl: 'http://nzbdav:3000',
  };
  const candidate = {
    title: 'WWE.Raw.2026.09.21.1080p.WEB.h264',
    nzbUrl: 'https://indexer.example/getnzb/123?apikey=hidden',
    size: 5_000_000_000,
    indexer: 'Fixture indexer',
  };
  const rows = await streams._test.pipelineNzbdav({
    event,
    config: nzbdavPlayback.providerConfig(config),
    getUsenetCandidates: async () => [candidate],
    getConfirmedCandidates: () => [],
    urlCtx: {
      origin: 'https://sss.example', userId: 'admin-1', apiToken: 'private-token',
    },
    log: () => {},
  });

  assert.equal(rows.length, 1);
  assert.match(rows[0].name, /DIY Usenet/);
  assert.doesNotMatch(rows[0].url, /apikey|hidden|getnzb/,
    'the stream row must expose only an opaque candidate id');
  const candidateId = new URL(rows[0].url).pathname.split('/').pop();
  assert.ok(candidateId && candidateId.length > 20);

  const originalResolve = nzbdavPlayback.resolveCandidate;
  let handedOff;
  nzbdavPlayback.resolveCandidate = async (_providerConfig, payload) => {
    handedOff = payload;
    return {
      url: 'http://nzbdav:3000/content/sports/raw.mkv',
      size: 5_000_000_000,
      jobId: 'job-123',
      headers: { Authorization: 'Basic hidden' },
    };
  };
  try {
    const resolved = await streams.resolvePlay({
      providerCode: 'nzbdav', eventId: event.id, infoHash: candidateId,
      creds: config, username: 'admin', userId: 'admin-1',
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.upstream.url, 'http://nzbdav:3000/content/sports/raw.mkv');
    assert.deepEqual(handedOff, {
      nzbUrl: candidate.nzbUrl,
      title: candidate.title,
      category: 'sports',
    });
  } finally {
    nzbdavPlayback.resolveCandidate = originalResolve;
  }
});
