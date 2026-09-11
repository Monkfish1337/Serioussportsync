'use strict';

// Which discovery source produced a torrent row.
//
// Nuvio already identified Usenet Ultimate, the DIY pipeline, Easynews and
// Sport-Video rows. Torrents were the exception: Bitmagnet, Prowlarr and the
// companion all arrived labelled "TorBox" and were indistinguishable, so
// "is Bitmagnet finding this, or Prowlarr?" could only be answered by reading
// server logs — which is precisely the question worth answering in the client.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'streams.js'), 'utf8');

// The labeller is a pure function of the candidate; lift it out rather than
// booting the whole stream pipeline to exercise four string cases.
const body = source.slice(source.indexOf('function torrentOriginLabel'));
// eslint-disable-next-line no-new-func
const torrentOriginLabel = new Function('return ' + body.slice(0, body.indexOf('\n}\n') + 2))();

test('each torrent source names itself', () => {
  assert.equal(torrentOriginLabel({ indexer: 'Bitmagnet' }), 'Bitmagnet');
  assert.equal(torrentOriginLabel({ indexer: 'RuTracker.org' }), 'RuTracker.org');
});

test('Sport-Video keeps its existing identity', () => {
  // It had a label before this and users know it; the indexer field must not
  // override it.
  assert.equal(torrentOriginLabel({ source: 'sport-video', indexer: 'whatever' }), 'Sport-Video');
});

test('a companion fanning out to several trackers is joined, not dropped', () => {
  assert.equal(torrentOriginLabel({ indexer: ['RuTracker', 'Zilean'] }), 'RuTracker, Zilean');
});

test('a long list is truncated so it cannot fill the row', () => {
  const many = ['AlphaTracker', 'BetaTracker', 'GammaTracker', 'DeltaTracker', 'EpsilonTracker'];
  const label = torrentOriginLabel({ indexer: many });
  assert.ok(label.length <= 40, 'got ' + label.length + ' chars');
  assert.match(label, /…$/);
});

test('a candidate with no indexer produces no label, not "undefined"', () => {
  assert.equal(torrentOriginLabel({}), '');
  assert.equal(torrentOriginLabel(null), '');
  assert.equal(torrentOriginLabel({ indexer: null }), '');
});

test('both TorBox rows carry the origin', () => {
  // The playable row and the warm row are built separately and it would be
  // easy to label only one.
  assert.match(source, /origin \? origin \+ ' · TorBox' : 'TorBox'/);
  assert.match(source, /→ Warm to TorBox/);
  assert.match(source, /'via ' \+ origin/);
});
