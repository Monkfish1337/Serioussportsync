'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { status } = require('../lib/diy-usenet-status');

test('native indexer and native NNTP form a complete DIY pipeline', () => {
  const result = status({
    diyNativeSearchEnabled: true,
    diySearchKind: 'prowlarr',
    diySearchUrl: 'http://prowlarr:9696',
    diySearchApiKey: 'secret',
    diyUuSearchEnabled: false,
    nativeNntpEnabled: true,
    nntpHost: 'news.example.com',
    nntpPort: 563,
  });
  assert.equal(result.nativeSearch, true);
  assert.equal(result.nntp, true);
  assert.equal(result.nzbdav, false);
  assert.equal(result.ready, true);
});

test('Usenet Ultimate discovery and NZB DAV form a complete DIY pipeline', () => {
  const result = status({
    diyUuSearchEnabled: true,
    uuManifestUrl: 'https://uu.example/private/manifest.json',
    diyUsenetEnabled: true,
    nzbdavUrl: 'http://nzbdav:3000',
    nzbdavApiKey: 'secret',
    nzbdavWebdavUrl: 'http://nzbdav:3000',
  });
  assert.equal(result.uuSearch, true);
  assert.equal(result.nzbdav, true);
  assert.equal(result.ready, true);
});

test('discovery without playback is not reported ready', () => {
  const result = status({
    diyUuSearchEnabled: true,
    uuManifestUrl: 'https://uu.example/private/manifest.json',
  });
  assert.equal(result.discovery, true);
  assert.equal(result.playback, false);
  assert.equal(result.ready, false);
});

test('playback without discovery is not reported ready', () => {
  const result = status({
    diyUuSearchEnabled: false,
    nativeNntpEnabled: true,
    nntpHost: 'news.example.com',
  });
  assert.equal(result.discovery, false);
  assert.equal(result.playback, true);
  assert.equal(result.ready, false);
});
