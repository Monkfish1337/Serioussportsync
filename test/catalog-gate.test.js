'use strict';

// The catalog availability gate.
//
// The fixture feeds are a schedule, not a library: on a real deployment most
// stored events have nothing behind them, which reads as the addon being
// broken rather than the content not existing. The gate restricts a catalog to
// events something has actually been found for — and, because that is a
// visible change to every client, it has to fail open whenever it cannot tell.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-gate-'));
process.env.DATA_FILE = path.join(dir, 'events.json');

const config = require('../config');
const promotions = require('../lib/promotions');
const eventAvailability = require('../lib/event-availability');

// Two days either side of "today" so the upcoming/recent split is unambiguous
// regardless of when the suite runs.
function isoOffset(days) {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

const PAST = isoOffset(-2);
const FUTURE = isoOffset(2);

const EVENTS = [
  { id: 'nfl:has-content', promotion: 'nfl', name: 'Covered past game', date: PAST, kind: 'event' },
  { id: 'nfl:no-content', promotion: 'nfl', name: 'Bare past game', date: PAST, kind: 'event' },
  { id: 'nfl:future-covered', promotion: 'nfl', name: 'Covered future game', date: FUTURE, kind: 'event' },
  { id: 'nfl:future-bare', promotion: 'nfl', name: 'Bare future game', date: FUTURE, kind: 'event' },
  { id: 'nfl:curated', promotion: 'nfl', name: 'Hand-added game', date: PAST, kind: 'event', manual: true },
];

fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({ updatedAt: null, events: EVENTS }));

const store = require('../lib/store');
store.loadFromDisk();
const { handleCatalog } = require('../lib/catalog');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const AVAILABLE = new Set(['nfl:has-content', 'nfl:future-covered']);

function ids(catalogId, opts) {
  return handleCatalog({ type: config.addonType, id: catalogId, extra: {} }, opts)
    .metas.map((meta) => meta.id);
}

test('the gate is inert until it is switched on', () => {
  assert.ok(promotions.byPrefix.nfl, 'expected the shipped NFL promotion');
  const recent = ids('nfl-recent', { gate: { enabled: false }, available: AVAILABLE });
  assert.deepEqual(recent.sort(), ['nfl:curated', 'nfl:has-content', 'nfl:no-content']);
});

test('with the gate on, only events with known content are listed', () => {
  const recent = ids('nfl-recent', { gate: { enabled: true }, available: AVAILABLE });
  // The curated event is exempt: the operator put it there deliberately.
  assert.deepEqual(recent.sort(), ['nfl:curated', 'nfl:has-content']);

  const upcoming = ids('nfl-upcoming', { gate: { enabled: true }, available: AVAILABLE });
  assert.deepEqual(upcoming, ['nfl:future-covered']);
});

test('keeping future fixtures spares the schedule but still cleans up Recent', () => {
  const upcoming = ids('nfl-upcoming', {
    gate: { enabled: true, keepUpcoming: true }, available: AVAILABLE,
  });
  assert.deepEqual(upcoming.sort(), ['nfl:future-bare', 'nfl:future-covered']);

  // A past event with nothing behind it is still dropped.
  const recent = ids('nfl-recent', {
    gate: { enabled: true, keepUpcoming: true }, available: AVAILABLE,
  });
  assert.ok(!recent.includes('nfl:no-content'));
});

// A gate that cannot answer must not answer "no". An unreadable availability
// database would otherwise empty every catalog on the deployment at once.
test('an unavailable snapshot hides nothing', () => {
  const recent = ids('nfl-recent', { gate: { enabled: true }, available: null });
  assert.deepEqual(recent.sort(), ['nfl:curated', 'nfl:has-content', 'nfl:no-content']);
});

test('the merged snapshot draws on both the index and Sport-Video', () => {
  const built = eventAvailability.build({
    availabilityIndex: { getDefault: () => ({ eventIdsWithReleases: () => new Set(['ucl:from-index']) }) },
    sportVideo: { load: () => ({ releases: [
      { matches: [{ eventId: 'ucl:from-scraper' }] },
      { matches: [] },
      {},
    ] }) },
  });
  assert.deepEqual(Array.from(built).sort(), ['ucl:from-index', 'ucl:from-scraper']);
});

test('a broken availability index with nothing else reports no snapshot', () => {
  const built = eventAvailability.build({
    availabilityIndex: { getDefault: () => { throw new Error('database is locked'); } },
    sportVideo: { load: () => ({ releases: [] }) },
  });
  assert.equal(built, null, 'expected no snapshot rather than an empty one');
  assert.match(String(eventAvailability.lastError()), /database is locked/);
});

// Turning the gate on blind is how an operator ends up with empty catalogs and
// no idea why, so the admin page has to be able to show the outcome first.
test('coverage reports what enabling the gate would do, per promotion', () => {
  const report = eventAvailability.coverage({ store, available: AVAILABLE });
  assert.equal(report.total, EVENTS.length);
  assert.equal(report.covered, 2);
  const nfl = report.promotions.find((row) => row.promotion === 'nfl');
  assert.equal(nfl.total, EVENTS.length);
  assert.equal(nfl.covered, 2);
  assert.equal(nfl.upcoming, 1, 'one future event has nothing behind it');
});
