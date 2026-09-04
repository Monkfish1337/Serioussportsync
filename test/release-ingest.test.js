'use strict';

// Release-first ingestion: a discovered release becomes an event of its own.
//
// A real scan found 620 releases within a day of some fixture that matched
// nothing — rugby, tennis, the South American cups — because no promotion
// claims those competitions and for several of them no free feed exists to
// claim them with. Every title below is verbatim from that export.

const test = require('node:test');
const assert = require('node:assert/strict');
const releaseIngest = require('../lib/sources/release-ingest');
const promotions = require('../lib/promotions');
const refresh = require('../scripts/refresh');
const sportVideo = require('../lib/sources/sport-video');

const RELEASES = [
  { id: 'r1', title: 'Canterbury Bulldogs v Brisbane Broncos 03.09.2026', date: '2026-09-03', category: 'rugby', detailUrl: '/a.html', matches: [] },
  { id: 'r2', title: 'Iga Swiatek vs Nadia Podoroska 03.09.2026', date: '2026-09-03', category: 'other', detailUrl: '/b.html', matches: [] },
  { id: 'r3', title: 'Bradford Bulls v Castleford Tigers 03.09.2026', date: '2026-09-03', category: 'rugby', detailUrl: '/c.html', matches: [] },
  // Claimed by a real promotion — a feed covers this, so it must not be ingested.
  { id: 'r4', title: 'Toulouse vs Lille 03.09.2026', date: '2026-09-03', category: 'football', detailUrl: '/d.html', matches: [{ promotion: 'ligue1', eventId: 'ligue1:1' }] },
  // Claimed only by the event it previously created.
  { id: 'r5', title: 'Fremantle Dockers v Hawthorn Hawks 03.09.2026', date: '2026-09-03', category: 'rugby', detailUrl: '/e.html', matches: [{ promotion: 'discovered-rugby', eventId: 'discovered-rugby:old' }] },
];

const fakeState = { load: () => ({ releases: RELEASES }) };

function ingest(sport) {
  return releaseIngest.fetchAll({ sport, sportVideo: fakeState, log: () => {} });
}

test('one promotion per sport the discovery index labels', () => {
  for (const sport of Object.keys(releaseIngest.SPORTS)) {
    const promotion = promotions.byPrefix[releaseIngest.promotionIdFor(sport)];
    assert.ok(promotion, 'missing discovered promotion for ' + sport);
    assert.equal(promotion.source.type, 'sport-video');
    assert.equal(promotion.source.sport, sport);
  }
});

test('a release no feed claimed becomes an event', () => {
  const raw = ingest('rugby');
  const names = raw.map((record) => record.name).sort();
  assert.deepEqual(names, [
    'Bradford Bulls v Castleford Tigers',
    'Canterbury Bulldogs v Brisbane Broncos',
    'Fremantle Dockers v Hawthorn Hawks',
  ]);
  const event = refresh.normalizeRecord(raw[0], promotions.byPrefix['discovered-rugby']);
  assert.equal(event.promotion, 'discovered-rugby');
  assert.equal(event.date, '2026-09-03');
  assert.equal(event.source.type, 'sport-video');
  assert.ok(event.genres.includes('Rugby'));
});

// The whole point is that a feed wins wherever one exists.
test('a release a real promotion already claimed is left alone', () => {
  assert.deepEqual(ingest('football'), []);
});

// Ingestion creates an event; the next rematch links the release to it. If that
// link counted as "claimed", the event would vanish on the following refresh and
// come back on the one after — flickering in and out of the catalog forever.
test('a release claimed only by its own discovered event is still ingested', () => {
  assert.ok(ingest('rugby').some((record) => record.name === 'Fremantle Dockers v Hawthorn Hawks'));
});

test('the same release always produces the same event id', () => {
  const record = { id: 'r1', title: 'Canterbury Bulldogs v Brisbane Broncos 03.09.2026', date: '2026-09-03', detailUrl: '/a.html' };
  assert.equal(releaseIngest.toRaw(record, 'rugby').sourceId,
    releaseIngest.toRaw(record, 'rugby').sourceId);
  // A different release is a different event.
  assert.notEqual(releaseIngest.toRaw(record, 'rugby').sourceId,
    releaseIngest.toRaw(Object.assign({}, record, { detailUrl: '/z.html' }), 'rugby').sourceId);
});

test('the date and quality tail are stripped from the name', () => {
  assert.equal(releaseIngest.cleanName('Bradford Bulls v Castleford Tigers 03.09.2026'),
    'Bradford Bulls v Castleford Tigers');
  assert.equal(releaseIngest.cleanName('Iga Swiatek vs Nadia Podoroska 03.09.2026 1080p WEB-DL x264'),
    'Iga Swiatek vs Nadia Podoroska');
});

test('an unusable record is skipped rather than becoming a junk event', () => {
  assert.equal(releaseIngest.toRaw({ id: 'x', title: 'X v Y 03.09.2026', date: '2026-09-03' }, 'rugby'), null);
  assert.equal(releaseIngest.toRaw({ id: 'x', title: '', date: '2026-09-03' }, 'rugby'), null);
  assert.equal(releaseIngest.toRaw({ id: 'x', title: 'A real looking fixture', date: 'soon' }, 'rugby'), null);
  assert.throws(() => releaseIngest.fetchAll({ sport: 'quidditch' }), /unsupported sport/);
});

// The generic matcher decides a non-matchup event on promotion keywords, which
// these have none of. Left alone that is the NFL false-positive shape — every
// release on the right date accepted — so relevance is replaced, not wrapped.
test('a discovered event accepts its own release and refuses the rest', () => {
  const rugby = promotions.byPrefix['discovered-rugby'];
  const event = {
    id: 'discovered-rugby:x', promotion: 'discovered-rugby',
    name: 'Bradford Bulls v Castleford Tigers', date: '2026-09-03',
  };
  assert.equal(rugby.isRelevantStreamTitle('Bradford Bulls v Castleford Tigers 03.09.2026', event).ok, true);
  assert.equal(rugby.isRelevantStreamTitle('Bradford Bulls v Castleford Tigers 03.09.2026 1080p WEB', event).ok, true);
  assert.equal(rugby.isRelevantStreamTitle('Canterbury Bulldogs v Brisbane Broncos 03.09.2026', event).ok, false);
  assert.equal(rugby.isRelevantStreamTitle('Bradford Bulls v Castleford Tigers Highlights 03.09.2026', event).ok, false);
  assert.equal(rugby.isRelevantStreamTitle('Bradford Bulls v Castleford Tigers 01.09.2026', event).ok, false);
});

// A single-sided name has no teams to compare, so it is the case most at risk
// of accepting anything that shares its date.
test('an event with no two sides still refuses an unrelated release', () => {
  const other = promotions.byPrefix['discovered-other'];
  const event = {
    id: 'discovered-other:w', promotion: 'discovered-other',
    name: 'Wimbledon Final', date: '2026-09-03',
  };
  assert.equal(other.isRelevantStreamTitle('Wimbledon Final 03.09.2026', event).ok, true);
  assert.equal(other.isRelevantStreamTitle('Iga Swiatek vs Nadia Podoroska 03.09.2026', event).ok, false);
  assert.equal(other.isRelevantStreamTitle('Canterbury Bulldogs v Brisbane Broncos 03.09.2026', event).ok, false);
});

// Preparation and matching are independent, so the console could show more
// prepared than matched and imply a funnel that is not one.
test('prepared releases are counted separately from orphaned ones', () => {
  const status = sportVideo.status();
  assert.equal(typeof status.preparedMatched, 'number');
  assert.equal(typeof status.preparedOrphans, 'number');
  assert.equal(status.preparedMatched + status.preparedOrphans, status.prepared);
});

// Deleting a promotion used to leave its events behind forever: nothing could
// render them and nothing could search for them, which reads to the user as
// "this fixture used to pull links and now pulls none".
test('events are orphaned by deleting a promotion, not by disabling one', () => {
  const known = refresh.knownPromotionPrefixes();
  assert.equal(refresh.isOrphanEventId('manutd:12345', known), true,
    'a deleted promotion leaves orphans');
  assert.equal(refresh.isOrphanEventId('epl:12345', known), false);

  // Disabled promotions are still known. Pruning their events would destroy
  // data the user only meant to hide, and re-fetching it costs API budget.
  const disabled = promotions.all.filter((p) => !p.enabled);
  for (const promotion of disabled.slice(0, 3)) {
    assert.equal(refresh.isOrphanEventId(promotion.idPrefix + ':1', known), false,
      promotion.id + ' is disabled, not deleted');
  }

  // Ids with no promotion prefix are not ours to judge.
  assert.equal(refresh.isOrphanEventId('nocolon', known), false);
  assert.equal(refresh.isOrphanEventId('', known), false);
});
