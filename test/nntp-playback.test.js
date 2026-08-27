'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fetch = require('node-fetch');
const playback = require('../lib/sources/nntp-playback');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }

function encodedPart(data, begin, total, name) {
  const encoded = [];
  for (const byte of data) {
    const value = (byte + 42) & 255;
    if ([0, 10, 13, 61].includes(value)) encoded.push(61, (value + 64) & 255);
    else encoded.push(value);
  }
  return Buffer.concat([
    Buffer.from('=ybegin part=1 total=2 line=128 size=' + total + ' name=' + name + '\r\n'
      + '=ypart begin=' + (begin + 1) + ' end=' + (begin + data.length) + '\r\n'),
    Buffer.from(encoded), Buffer.from('\r\n=yend size=' + data.length + '\r\n'),
  ]);
}

test('resolves a direct-video NZB and caches the inspected descriptor', async () => {
  let downloads = 0;
  let connections = 0;
  const xml = Buffer.from('<nzb><file subject="&quot;main.mkv&quot; yEnc"><segments>'
    + '<segment bytes="100" number="1">one@id</segment>'
    + '<segment bytes="100" number="2">two@id</segment>'
    + '</segments></file></nzb>');
  const options = {
    cacheKey: 'resolve-cache-test',
    downloadNzb: async () => { downloads++; return xml; },
    connect: async () => {
      connections++;
      return { body: async () => encodedPart(Buffer.from('ABCD'), 0, 8, 'main.mkv'), close() {} };
    },
  };
  const config = { enabled: true, host: 'news.example', port: 563, tls: true };
  const [first, second] = await Promise.all([
    playback.resolveCandidate(config, { nzbUrl: 'https://indexer/nzb' }, options),
    playback.resolveCandidate(config, { nzbUrl: 'https://indexer/nzb' }, options),
  ]);
  assert.equal(first.filename, 'main.mkv');
  assert.equal(first.size, 8);
  assert.equal(first.chunkSize, 4);
  assert.equal(second.id, first.id);
  assert.equal(downloads, 1);
  assert.equal(connections, 1);
});

test('serves an exact HTTP byte range assembled from yEnc articles', async () => {
  const descriptor = {
    id: 'abc123', filename: 'main.mkv', size: 8, chunkSize: 4,
    segments: [{ messageId: 'one@id' }, { messageId: 'two@id' }],
    firstPart: { data: Buffer.from('ABCD'), begin: 0, endExclusive: 4, totalSize: 8 },
  };
  const server = http.createServer((req, res) => playback.serve(req, res, descriptor,
    { enabled: true, host: 'news.example', port: 563 }, {
      connect: async () => ({
        body: async (id) => {
          assert.equal(id, 'two@id');
          return encodedPart(Buffer.from('EFGH'), 4, 8, 'main.mkv');
        },
        close() {}, destroy() {},
      }),
    }).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
  const port = await listen(server);
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/play', {
      headers: { Range: 'bytes=2-6' },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-6/8');
    assert.equal(response.headers.get('content-length'), '5');
    assert.equal(response.headers.get('content-type'), 'video/x-matroska');
    assert.equal(await response.text(), 'CDEFG');
  } finally { await close(server); }
});

test('rejects archive-only NZBs with an explicit NZB DAV fallback message', async () => {
  const xml = Buffer.from('<nzb><file subject="&quot;release.part01.rar&quot; yEnc"><segments>'
    + '<segment bytes="100" number="1">one@id</segment></segments></file></nzb>');
  await assert.rejects(playback.resolveCandidate(
    { enabled: true, host: 'news.example', port: 563 },
    { nzbUrl: 'https://indexer/nzb' }, { downloadNzb: async () => xml }),
  /use the NZB DAV row/);
});
