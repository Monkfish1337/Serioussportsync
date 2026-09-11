'use strict';

// "Check it works", the feature a new user judges the whole product by.
//
// On a fully working install it chose "ONE Friday Fights 169 & The Inner Circle
// 29" — a seven-day-old card from about the least-covered promotion in the
// catalog — found nothing, and reported that. The old copy then spent a
// paragraph explaining that the red result might not mean what it says, which
// is a design admitting its own answer is unreliable.
//
// The cause was the selection: newest settled fixture wins, and recency is
// uncorrelated with whether a release exists.

const test = require('node:test');
const assert = require('node:assert');
const configurePage = require('../lib/configure-page');
const collectionSettings = require('../lib/nuvio-collection-settings');

function installStep() {
  return configurePage.render({
    user: { id: 'u1', apiToken: 't1', config: {} },
    isAdmin: false, isFirstRun: false, step: 'install',
    installUrl: 'http://sss.local/u/u1/t1/manifest.json',
    promotions: [], selected: new Set(), selectAll: true, folderOf: {},
    collections: collectionSettings.defaults(), choosers: [], teamPromotions: [],
  });
}

test('a failure names every fixture tried, not just one', () => {
  // One miss on one fixture was never evidence of anything. Several misses
  // across several promotions is, and the result has to show its working.
  const html = installStep();
  assert.match(html, /fixtures checked/);
  assert.match(html, /a\.promotion \+ ' — ' \+ a\.name/);
});

test('the result says which torrent sources were asked', () => {
  // Every torrent source is folded into the TorBox row, so "TorBox: nothing
  // found" never said whether Bitmagnet — the primary source now — was even
  // consulted. A switched-off source and an empty index read identically.
  const html = installStep();
  assert.match(html, /Torrent sources asked/);
  assert.match(html, /none — nothing was searched/);
});

test('the old "this might not be a configuration problem" hedge is gone', () => {
  // It was true of a single low-profile fixture and is not true of three
  // misses across three promotions. Keeping it would excuse a real fault.
  const html = installStep();
  assert.ok(!/not always a\s+.?configuration problem/.test(html));
  assert.match(html, /points at the configuration rather/);
});

test('a success says how many fixtures it had to try', () => {
  const html = installStep();
  assert.match(html, /stopped at the first that returned something/);
});
