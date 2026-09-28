'use strict';

// The Promotions table, and whether it can tell you a promotion is broken.
//
// AEW sat in that list with zero upcoming events and nothing on the page said
// so. It was found because somebody happened to know All Out exists. The table
// showed a CATALOGS count — 2, 4, 6 — a property of the definition that never
// changes and cannot answer "is this working". At 34 promotions, "notice it by
// eye" is not a process.

const test = require('node:test');
const assert = require('node:assert');
const adminPromotions = require('../lib/admin-promotions');

const TODAY = new Date().toISOString().slice(0, 10);
function daysFromNow(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test('counts events per promotion, and splits past from upcoming', () => {
  const stats = adminPromotions.eventStats([
    { promotion: 'ufc', date: daysFromNow(10) },
    { promotion: 'ufc', date: daysFromNow(-3) },
    { promotion: 'ufc', date: daysFromNow(40) },
    { promotion: 'aew', date: daysFromNow(-12) },
    { promotion: 'aew', date: daysFromNow(-40) },
  ]);
  assert.equal(stats.get('ufc').total, 3);
  assert.equal(stats.get('ufc').upcoming, 2);
  assert.equal(stats.get('ufc').newest, daysFromNow(40));
  assert.equal(stats.get('aew').total, 2);
  assert.equal(stats.get('aew').upcoming, 0);
});

test("today's event counts as upcoming", () => {
  // A card tonight is not history. Counting it as past would show "nothing
  // upcoming" on the one day it matters most.
  const stats = adminPromotions.eventStats([{ promotion: 'ufc', date: TODAY }]);
  assert.equal(stats.get('ufc').upcoming, 1);
});

test('events with no promotion or no date do not corrupt the count', () => {
  const stats = adminPromotions.eventStats([
    { date: TODAY },
    { promotion: '', date: TODAY },
    { promotion: 'ufc' },
    null,
  ]);
  assert.equal(stats.has(''), false);
  assert.equal(stats.get('ufc').total, 1);
  assert.equal(stats.get('ufc').upcoming, 0, 'an undated event cannot be upcoming');
});

test('a promotion with nothing stored is called out, not shown as zero', () => {
  // "0" in a table of numbers reads as a value. It needs to read as a fault.
  const cell = adminPromotions.eventCell(undefined);
  assert.match(cell, /No events/);
  assert.match(cell, /refresh has never returned anything/);
});

test('a promotion whose events are all in the past is a distinct state', () => {
  // This is exactly AEW's shape: 32 events, every one behind us. It is not the
  // same fault as "no events" — the feed works, it just is not reaching the
  // future — and the fix is different, so the page must not merge them.
  const cell = adminPromotions.eventCell({ total: 32, upcoming: 0, newest: '2026-08-30' });
  assert.match(cell, /Nothing upcoming/);
  assert.match(cell, /32 stored, all in the past/);
  assert.match(cell, /newest 2026-08-30/);
});

test('a healthy promotion leads with the number that matters', () => {
  const cell = adminPromotions.eventCell({ total: 84, upcoming: 12, newest: '2026-12-12' });
  assert.match(cell, /12<\/b> upcoming/);
  assert.match(cell, /84 stored/);
  assert.ok(!/No events|Nothing upcoming/.test(cell));
});

test('the newest date is the latest, not the last one seen', () => {
  const stats = adminPromotions.eventStats([
    { promotion: 'f1', date: '2026-12-06' },
    { promotion: 'f1', date: '2026-03-01' },
  ]);
  assert.equal(stats.get('f1').newest, '2026-12-06');
});

test('every source is named, not half of them', () => {
  // "Embedded source" appeared on 16 of 34 rows — every promotion whose source
  // is not in the metadata registry — beside a minority naming theirs properly
  // as "TheSportsDB · UFC". The vague form was the majority and the one a user
  // cannot act on.
  const html = adminPromotions.renderBody({ events: [] });
  assert.ok(!/Embedded source/.test(html), 'no row may fall back to a non-name');
  assert.match(html, /ESPN/);
  assert.match(html, /TheSportsDB/);
  assert.match(html, /Sport-Video/);
});

test('the table carries an Events column', () => {
  const html = adminPromotions.renderBody({ events: [] });
  assert.match(html, /<th>Events<\/th>/);
  // With no events at all, every row must say so rather than showing a zero.
  assert.match(html, /No events/);
});

test('materialized My Teams catalogs stay out of the promotion workspace', () => {
  const html = adminPromotions.renderBody({ events: [] });
  assert.match(html, /Team catalogs are managed in Configure/);
  assert.doesNotMatch(html, />nfl-ari · /);
  assert.match(html, />nfl · /);
});

test('rows align to the top', () => {
  // Rows are a primary line over secondary ones, and cells differ in height.
  // Middle alignment floated one-line cells to the centre of a three-line row.
  const html = adminPromotions.renderBody({ events: [] });
  assert.match(html, /<table class="tbl pr-table">/);
  assert.match(html, /\.pr-table td\{vertical-align:top\}/);
});

test('the events actually reach the table', () => {
  // The first version of this column read contentStore.load().events, which is
  // undefined — the events live in the event store, contentStore holds the
  // overlay. Every promotion reported "No events", including ones measured at
  // 84 and 74. The accessor is the whole feature, so it is worth pinning.
  const contentStore = require('../lib/content-store');
  assert.equal(contentStore.load().events, undefined,
    'if this ever gains an events key, re-check which store the table reads');
  const store = require('../lib/store');
  assert.ok(Array.isArray(store.loadFromDisk().events), 'the catalog lives here');

  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'addon.js'), 'utf8');
  const promotionsRoute = source.slice(source.indexOf("adminPromotions.renderBody({"));
  const call = promotionsRoute.slice(0, promotionsRoute.indexOf('});'));
  assert.match(call, /store\.loadFromDisk\(\)\.events/);
  assert.ok(!/contentStore\.load\(\)\.events/.test(call));
});

test('a wide table scrolls instead of pushing the page sideways', () => {
  // Eight columns and a row of buttons always exceed a narrow viewport, and a
  // scroll container only scrolls if something stops it growing.
  const { compatCss } = require('../lib/ui/compat');
  const css = String(typeof compatCss === 'function' ? compatCss() : compatCss);
  assert.match(css, /\.table-responsive \{[^}]*max-width: 100%/);
  assert.match(css, /\.table-responsive > \.table \{[^}]*min-width/);
});

test('the table fits the card instead of relying on the scrollbar', () => {
  // Measured at 1440px, the old table wanted 1386px inside a 1018px card, 690px
  // of it one line of buttons. Since issue #72 a row shows one button and folds
  // the rest under "More", so the columns fit and nothing reads as cut off.
  const html = adminPromotions.renderBody({ events: [] });
  const table = html.slice(html.indexOf('<table class="tbl pr-table">'));
  const head = (table.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
  assert.ok(head, 'the promotions table must be findable');
  assert.ok(!/<th>Poster<\/th>/.test(head), 'poster shape is one word; it does not need a column');
  assert.ok(!/<th>Catalogs<\/th>/.test(head), 'a catalog count cannot say whether a promotion works');
  assert.equal((head.match(/<th[ >]/g) || []).length, 5, 'five columns');
  assert.match(html, / catalogs?<\/span>/, 'the count still has to be readable somewhere');
  assert.match(html, /<td class="promo-actions"><div class="pr-actions">[^]*?<details class="pr-more"><summary>More<\/summary>/,
    'row actions beyond the first are folded');
  assert.match(html, /td\.promo-actions\{width:250px;white-space:normal\}/);
});

// ---------------------------------------------------------------------------
// The review inbox, removed in 1.0.

test('nothing writes to a review inbox any more', () => {
  // recordInbox wrote excluded and duplicate-looking candidates to a list
  // capped at 500. Nothing ever read it: updateInbox had zero callers, no page
  // rendered the items, no export included them. It had been accumulating
  // records nobody could see since it was written.
  const contentStore = require('../lib/content-store');
  assert.equal(typeof contentStore.recordInbox, 'undefined');
  assert.equal(typeof contentStore.updateInbox, 'undefined');
  assert.ok(!Object.prototype.hasOwnProperty.call(contentStore.load(), 'inbox'),
    'and the key is gone from the state shape');
});

test('the duplicate scan went with it', () => {
  // Its only consumer was the inbox, and it walked every stored event for
  // every candidate of every refresh — an O(n) scan per record, writing
  // something nobody could read.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scripts', 'refresh.js'), 'utf8');
  assert.ok(!/possibleDuplicate/.test(source));
  assert.ok(!/contentStore\.recordInbox/.test(source));
});

test('an existing file with an inbox still loads', () => {
  // Upgrading from a version that wrote one must not throw; the key is simply
  // not carried forward.
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const file = path.join(os.tmpdir(), 'sss-inbox-drop-' + process.pid + '.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, manualEvents: [], eventOverrides: {}, disabledEventIds: [],
    inbox: [{ key: 'abc', status: 'pending', candidate: { name: 'Old' } }],
  }));
  const original = require('../config').contentStudioFile;
  try {
    require('../config').contentStudioFile = file;
    delete require.cache[require.resolve('../lib/content-store')];
    const fresh = require('../lib/content-store');
    const state = fresh.load();
    assert.ok(Array.isArray(state.manualEvents));
    assert.ok(!Object.prototype.hasOwnProperty.call(state, 'inbox'));
  } finally {
    require('../config').contentStudioFile = original;
    delete require.cache[require.resolve('../lib/content-store')];
    try { fs.unlinkSync(file); } catch (_) { /* best effort */ }
  }
});
