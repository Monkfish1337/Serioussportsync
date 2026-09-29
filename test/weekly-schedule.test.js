'use strict';

// Placeholder episodes for WWE's weekly shows (Discussions #59): TheSportsDB
// lists an NXT episode only after it airs, so today's episode had no event
// and nothing its releases could match.

const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');
const weekly = require('../lib/weekly-schedule');
const refresh = require('../scripts/refresh');
const store = require('../lib/store');
const tsdb = require('../lib/sources/thesportsdb');

const nxt = promotions.all.find((p) => p.id === 'wwe-nxt');
const TUE = Date.parse('2026-09-29T15:00:00Z'); // a Tuesday, NXT's air day
const listed = (id, name, date) => ({ id: 'wwe-nxt:' + id, promotion: 'wwe-nxt', name, date, source: { type: 'thesportsdb' } });

test('WWE weekly shows know their air day; AEW keeps its own schedule source', () => {
  const byId = (id) => promotions.all.find((p) => p.id === id);
  assert.equal(byId('wwe-raw').weeklyAirDay, 1);
  assert.equal(byId('wwe-nxt').weeklyAirDay, 2);
  assert.equal(byId('wwe-smackdown').weeklyAirDay, 5);
  assert.equal(byId('aew-dynamite').weeklyAirDay, undefined);
});

test("today's unlisted NXT episode gets a placeholder with the next number", () => {
  const out = weekly.placeholders([listed('856', 'WWE NXT #856', '2026-09-22')], nxt, TUE);
  assert.deepEqual(out.map((r) => [r.sourceId, r.name, r.date]), [
    ['sched-2026-09-29', 'WWE NXT #857', '2026-09-29'],
    ['sched-2026-10-06', 'WWE NXT #858', '2026-10-06'],
  ]);
  assert.equal(out[0].source.type, weekly.TYPE);
});

test('listed episodes, within a day either way, need no placeholder', () => {
  const events = [listed('856', 'WWE NXT #856', '2026-09-22'), listed('857', 'WWE NXT #857', '2026-09-30'), listed('858', 'WWE NXT #858', '2026-10-06')];
  assert.deepEqual(weekly.placeholders(events, nxt, TUE), []);
  assert.deepEqual(weekly.placeholders(events, promotions.all.find((p) => p.id === 'aew-dynamite'), TUE), [], 'no air day, nothing added');
});

test('without a numbered episode the placeholder is just the show name', () => {
  const [first] = weekly.placeholders([], nxt, TUE);
  assert.equal(first.name, 'WWE NXT');
});

test('placeholders go once the real episode is listed, or after 14 days', () => {
  const byId = new Map([
    ['wwe-nxt:sched-2026-09-29', { id: 'wwe-nxt:sched-2026-09-29', promotion: 'wwe-nxt', date: '2026-09-29', source: { type: weekly.TYPE } }],
    ['wwe-nxt:sched-2026-09-08', { id: 'wwe-nxt:sched-2026-09-08', promotion: 'wwe-nxt', date: '2026-09-08', source: { type: weekly.TYPE } }],
    ['wwe-nxt:sched-2026-10-06', { id: 'wwe-nxt:sched-2026-10-06', promotion: 'wwe-nxt', date: '2026-10-06', source: { type: weekly.TYPE } }],
    ['wwe-nxt:857', listed('857', 'WWE NXT #857', '2026-09-30')],
  ]);
  assert.equal(weekly.dropPlaceholders(byId, nxt, TUE), 2);
  assert.deepEqual(Array.from(byId.keys()).sort(), ['wwe-nxt:857', 'wwe-nxt:sched-2026-10-06']);
});

test('a refresh adds the placeholder, keeps it, and swaps it for the real episode', async () => {
  // The refresh reads the real clock, so the dates are built around it.
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const easternToday = Date.parse(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()) + 'T00:00:00Z');
  let air = easternToday - 2 * 86400000;
  while (new Date(air).getUTCDay() !== 2) air += 86400000;
  const previous = day(air - 7 * 86400000);
  const load = store.loadFromDisk;
  const save = store.saveToDisk;
  const fetchAll = tsdb.fetchAll;
  let saved = { events: [listed('856', 'WWE NXT #856', previous)] };
  const run = async (tsdbEvents) => {
    store.loadFromDisk = () => JSON.parse(JSON.stringify(saved));
    store.saveToDisk = (payload) => { saved = payload; };
    tsdb.fetchAll = async () => tsdbEvents;
    await refresh.runRefresh({ promotionId: 'wwe-nxt', log() {} });
  };
  try {
    await run([]);
    const placeholder = saved.events.find((e) => e.id === 'wwe-nxt:sched-' + day(air));
    assert.ok(placeholder, 'the unlisted episode is added');
    assert.equal(placeholder.name, 'WWE NXT #857');

    await run([]);
    assert.ok(saved.events.some((e) => e.id === 'wwe-nxt:sched-' + day(air)), 'kept by the next refresh, not pruned as a stale source');

    await run([{ idEvent: '2699999', strEvent: 'NXT #857', dateEvent: day(air), dateEventLocal: day(air) }]);
    assert.ok(!saved.events.some((e) => e.id === 'wwe-nxt:sched-' + day(air)), 'replaced once TheSportsDB lists it');
    assert.equal(saved.events.find((e) => e.id === 'wwe-nxt:2699999').name, 'WWE NXT #857');
  } finally {
    store.loadFromDisk = load;
    store.saveToDisk = save;
    tsdb.fetchAll = fetchAll;
  }
});
