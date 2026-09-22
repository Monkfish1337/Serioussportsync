'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { status } = require('../lib/diy-usenet-status');

test('native indexer and native NNTP form a complete Built-in Usenet pipeline', () => {
  const result = status({
    diyUsenetEnabled: true,
    diyNativeSearchEnabled: true,
    diySearchKind: 'prowlarr',
    diySearchUrl: 'http://prowlarr:9696',
    diySearchApiKey: 'secret',
    nativeNntpEnabled: true,
    nntpHost: 'news.example.com',
    nntpPort: 563,
  });
  assert.equal(result.discovery, true);
  assert.equal(result.playback, true);
  assert.equal(result.ready, true);
});

test('discovery without playback is not reported ready', () => {
  const result = status({
    diyUsenetEnabled: true,
    diyNativeSearchEnabled: true,
    diySearchKind: 'prowlarr',
    diySearchUrl: 'http://prowlarr:9696',
    diySearchApiKey: 'secret',
  });
  assert.equal(result.discovery, true);
  assert.equal(result.playback, false);
  assert.equal(result.ready, false);
});

test('playback without discovery is not reported ready', () => {
  const result = status({
    diyUsenetEnabled: true,
    nativeNntpEnabled: true,
    nntpHost: 'news.example.com',
  });
  assert.equal(result.discovery, false);
  assert.equal(result.playback, true);
  assert.equal(result.ready, false);
});

test('configured backends remain visible while the master switch is off', () => {
  const result = status({
    diyUsenetEnabled: false,
    diyNativeSearchEnabled: true,
    diySearchUrl: 'http://prowlarr:9696',
    diySearchApiKey: 'secret',
    nativeNntpEnabled: true,
    nntpHost: 'news.example.com',
  });
  assert.equal(result.discovery, true);
  assert.equal(result.playback, true);
  assert.equal(result.enabled, false);
  assert.equal(result.ready, false);
});
