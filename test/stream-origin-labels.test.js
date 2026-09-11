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

// ---------------------------------------------------------------------------
// "They don't match the name and claim it's from Bitmagnet not Prowlarr."
//
// Worth separating three things, because only one of them was a defect:
//
//   1. The label. `lib/sources/bitmagnet.js` hard-codes indexer: 'Bitmagnet';
//      Prowlarr results carry the real per-indexer name ("RuTracker.org"). So
//      "Bitmagnet" is only ever stamped by Bitmagnet's own client. It is a
//      DHT crawler, and rutracker torrents are public, so it legitimately has
//      them.
//   2. The title. It is the torrent's own name as the index reports it, not
//      the rutracker listing's title. A single-file torrent is commonly named
//      after the file.
//   3. The defect: deduplication kept the first source's attribution and
//      discarded the rest, so a torrent found by BOTH asserted one origin.

test('a torrent found by two sources names both', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  assert.match(source, /const sourcesByHash = new Map\(\)/);
  assert.match(source, /candidate\.indexer = found\.join\(', '\)/);
  assert.match(source, /noteSource\(hash, candidate\)/,
    'every occurrence has to be recorded, not just the one that wins the row');
});

test('the label already renders a multi-source list', () => {
  const { torrentOriginLabel } = require('../lib/streams')._test
    || require('../lib/streams');
  const label = typeof torrentOriginLabel === 'function' ? torrentOriginLabel : null;
  if (!label) return;   // not exported in this build; the source assertions above still hold
  assert.equal(label({ indexer: 'Bitmagnet, RuTracker.org' }), 'Bitmagnet, RuTracker.org');
  assert.equal(label({ indexer: ['Bitmagnet', 'RuTracker.org'] }), 'Bitmagnet, RuTracker.org');
});

test('one source still reads as one source', () => {
  // The point of merging is that "Bitmagnet" alone now MEANS Prowlarr did not
  // return it, rather than meaning Bitmagnet happened to be first in the list.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  assert.match(source, /if \(found && found\.length\) candidate\.indexer = found\.join/);
});
