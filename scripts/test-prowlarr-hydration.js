#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  extractTorrentInfoHash,
  absoluteDownloadUrl,
} = require('../lib/sources/prowlarr');

const info = Buffer.from('d6:lengthi1e4:name4:teste');
const torrent = Buffer.concat([
  Buffer.from('d8:announce14:https://x.test4:info'),
  info,
  Buffer.from('e'),
]);
assert.strictEqual(
  extractTorrentInfoHash(torrent),
  crypto.createHash('sha1').update(info).digest('hex'),
  'computes the v1 info hash from an ordinary torrent response body',
);
assert.strictEqual(
  extractTorrentInfoHash(Buffer.from('not a torrent')),
  '',
  'rejects invalid torrent bodies',
);
assert.strictEqual(
  absoluteDownloadUrl('/api/v1/search/download?id=1', 'http://prowlarr:9696/'),
  'http://prowlarr:9696/api/v1/search/download?id=1',
  'resolves relative Prowlarr download proxy URLs',
);
assert.strictEqual(
  absoluteDownloadUrl('/api/v1/search/download?id=1&apikey=provider-secret', 'http://prowlarr:9696/'),
  'http://prowlarr:9696/api/v1/search/download?id=1&apikey=provider-secret',
  'accepts credential query parameters on server-consumed Prowlarr download URLs',
);

console.log('OK — Prowlarr magnet and torrent-body hydration helpers verified.');
