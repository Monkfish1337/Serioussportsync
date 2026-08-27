'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nzb = require('../lib/sources/nntp-nzb');
const yenc = require('../lib/sources/nntp-yenc');

test('parses bounded NZB files and selects the largest direct video', () => {
  const parsed = nzb.parseNzb(Buffer.from('<?xml version="1.0"?><nzb>'
    + '<file subject="&quot;sample.mkv&quot; yEnc"><segments><segment bytes="10" number="1">sample@id</segment></segments></file>'
    + '<file subject="post &quot;Fight Night.mkv&quot; yEnc"><segments>'
    + '<segment bytes="900" number="2">part2@id</segment><segment bytes="1000" number="1">part1@id</segment>'
    + '</segments></file></nzb>'));
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[1].filename, 'Fight Night.mkv');
  assert.deepEqual(parsed.files[1].segments.map((part) => part.messageId), ['part1@id', 'part2@id']);
  assert.equal(nzb.selectDirectVideo(parsed).filename, 'Fight Night.mkv');
  assert.match(parsed.hash, /^[a-f0-9]{40}$/);
});

test('decodes multipart yEnc bytes and reports absolute file offsets', () => {
  const source = Buffer.from([0, 1, 2, 13, 10, 61, 255]);
  const encoded = [];
  for (const byte of source) {
    const value = (byte + 42) & 255;
    if ([0, 10, 13, 61].includes(value)) encoded.push(61, (value + 64) & 255);
    else encoded.push(value);
  }
  const article = Buffer.concat([
    Buffer.from('=ybegin part=1 total=2 line=128 size=14 name=video.mkv\r\n=ypart begin=1 end=7\r\n'),
    Buffer.from(encoded), Buffer.from('\r\n=yend size=7 part=1\r\n'),
  ]);
  const decoded = yenc.decodeArticle(article);
  assert.deepEqual(decoded.data, source);
  assert.equal(decoded.begin, 0);
  assert.equal(decoded.endExclusive, 7);
  assert.equal(decoded.totalSize, 14);
  assert.equal(decoded.filename, 'video.mkv');
});
