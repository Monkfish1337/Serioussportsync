'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');
const transform = require('../lib/transform');
const refresh = require('../scripts/refresh');
const store = require('../lib/store');
const tsdb = require('../lib/sources/thesportsdb');

const wwe = promotions.all.find((p) => p.id === 'wwe');

test('WWE excludes weekly Main Event entries but retains named live events', () => {
  for (const name of ['Main Event #710', 'WWE Main Event #713', 'WWE Main Event']) {
    assert.equal(wwe.includeEvent({ name }), false, name);
  }
  for (const name of ["Saturday Night's Main Event", "Sunday Night's Main Event",
    'Money In The Bank', 'NXT Heatwave']) {
    assert.equal(wwe.includeEvent({ name }), true, name);
  }
});

test('WWE 2026 Money in the Bank uses the rescheduled official date', () => {
  const event = transform.fromTsdb({
    idEvent: '1234', strEvent: 'Money In The Bank', dateEvent: '2026-09-06',
    dateEventLocal: '2026-09-06', strTime: '23:00:00',
    strTimestamp: '2026-09-06T23:00:00+00:00',
  }, wwe);
  assert.equal(event.date, '2026-10-10');
  assert.equal(event.dateLocal, '2026-10-10');
  assert.equal(event.time, null);
  assert.equal(event.timestamp, null);
  assert.equal(wwe.correctDate('Money In The Bank', '2025-06-07'), '2025-06-07');
});

test('WWE tiles use event thumbnails or the WWE brand fallback, never shared fanart', () => {
  const base = { idEvent: '5678', strEvent: 'Crown Jewel', dateEvent: '2026-11-07',
    strFanart: 'https://example.org/shared-old-photo.jpg' };
  const withoutThumb = transform.fromTsdb(base, wwe);
  assert.equal(withoutThumb.poster, wwe.defaults.poster);
  assert.equal(withoutThumb.thumb, wwe.defaults.poster);
  const withThumb = transform.fromTsdb({ ...base, strThumb: 'https://example.org/card.jpg' }, wwe);
  assert.equal(withThumb.poster, 'https://example.org/card.jpg');
});

test('a WWE refresh removes cached weekly episodes and repairs cached dates and art', async () => {
  const load = store.loadFromDisk;
  const save = store.saveToDisk;
  const fetchAll = tsdb.fetchAll;
  let saved;
  try {
    store.loadFromDisk = () => ({ events: [
      { id: 'wwe:100', name: 'WWE Main Event #713', date: '2026-09-19',
        source: { type: 'thesportsdb' } },
      { id: 'wwe:101', name: 'Money In The Bank', date: '2026-09-06',
        dateLocal: '2026-09-06', time: '23:00:00', timestamp: '2026-09-06T23:00:00Z',
        poster: 'https://example.org/shared-photo.jpg', hasSourceImage: false,
        source: { type: 'thesportsdb' } },
    ] });
    store.saveToDisk = (payload) => { saved = payload; };
    tsdb.fetchAll = async () => [];
    await refresh.runRefresh({ promotionId: 'wwe', log() {} });
  } finally {
    store.loadFromDisk = load;
    store.saveToDisk = save;
    tsdb.fetchAll = fetchAll;
  }
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0].id, 'wwe:101');
  assert.equal(saved.events[0].date, '2026-10-10');
  assert.equal(saved.events[0].time, null);
  assert.equal(saved.events[0].poster, wwe.defaults.poster);
});
