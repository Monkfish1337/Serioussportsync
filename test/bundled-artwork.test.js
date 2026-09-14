'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { versionedArtwork } = require('../lib/bundled-artwork');
const { publicImageUrl } = require('../lib/nuvio-collections');
const { resolvedPreview } = require('../lib/admin-nuvio-collections');

test('saved collection artwork uses the same content-versioned URL in previews and exports', () => {
  for (const name of ['big-3', 'unmatched']) {
    const artwork = '/assets/collection-' + name + '.png';
    const url = versionedArtwork(artwork);
    assert.match(url, /\.png\?v=[a-f0-9]{12}$/);
    assert.equal(resolvedPreview({ artwork }), url);
    assert.equal(publicImageUrl(artwork, 'https://sss.example'), 'https://sss.example' + url);
  }
  assert.equal(versionedArtwork('https://custom.example/art.png'), 'https://custom.example/art.png');
});
