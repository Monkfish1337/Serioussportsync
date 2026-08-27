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

function vint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function rar5Part(name, content, splitBefore, splitAfter, totalSize) {
  const nameBytes = Buffer.from(name);
  let flags = 0x02;
  if (splitBefore) flags |= 0x08;
  if (splitAfter) flags |= 0x10;
  const fields = Buffer.concat([
    vint(0), vint(totalSize), vint(0), vint(0), vint(0), vint(nameBytes.length), nameBytes,
  ]);
  const body = Buffer.concat([vint(2), vint(flags), vint(content.length), fields]);
  return Buffer.concat([
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]),
    Buffer.alloc(4), vint(body.length), body, content,
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
    { nzbUrl: 'https://indexer/nzb' }, {
      downloadNzb: async () => xml,
      connect: async () => ({
        body: async () => encodedPart(Buffer.from('not a rar'), 0, 9, 'release.part01.rar'),
        close() {}, destroy() {},
      }),
    }),
  /use the NZB DAV row/);
});

test('resolves and serves a stored video split across RAR5 volumes', async () => {
  const first = rar5Part('main.mkv', Buffer.from('ABCD'), false, true, 8);
  const second = rar5Part('main.mkv', Buffer.from('EFGH'), true, false, 8);
  const xml = Buffer.from('<nzb>'
    + '<file subject="&quot;release.part01.rar&quot; yEnc"><segments>'
    + '<segment bytes="100" number="1">rar-one@id</segment></segments></file>'
    + '<file subject="&quot;release.part02.rar&quot; yEnc"><segments>'
    + '<segment bytes="100" number="1">rar-two@id</segment></segments></file>'
    + '</nzb>');
  const articles = {
    'rar-one@id': encodedPart(first, 0, first.length, 'release.part01.rar'),
    'rar-two@id': encodedPart(second, 0, second.length, 'release.part02.rar'),
  };
  const options = {
    downloadNzb: async () => xml,
    connect: async () => ({
      body: async (id) => articles[id], close() {}, destroy() {},
    }),
  };
  const config = { enabled: true, host: 'news.example', port: 563, tls: true, maxConnections: 4 };
  const descriptor = await playback.resolveCandidate(config, { nzbUrl: 'https://indexer/nzb' }, options);
  assert.equal(descriptor.kind, 'rar');
  assert.equal(descriptor.filename, 'main.mkv');
  assert.equal(descriptor.size, 8);
  assert.equal((await playback.readDescriptorRange(descriptor, 2, 5, config, options)).toString(), 'CDEFG');
  await assert.rejects(playback.readDescriptorRange(descriptor, -1, 2, config, options),
    /byte range is invalid/);
  const server = http.createServer((req, res) => playback.serve(
    req, res, descriptor, config, options,
  ).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
  const port = await listen(server);
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/rar', {
      headers: { Range: 'bytes=1-6' },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 1-6/8');
    assert.equal(response.headers.get('content-type'), 'video/x-matroska');
    assert.equal(await response.text(), 'BCDEFG');
  } finally { await close(server); }
});
