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
  assert.match(cell, /12<\/strong> upcoming/);
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

test('the table opts out of middle alignment, and the rule it opts into exists', () => {
  // A table cell inherits vertical-align: middle from the table, so dropping
  // Tabler's .table-vcenter changes nothing on its own — the replacement has to
  // be defined. Rows here are a primary line over a secondary one, and middle
  // alignment floated the one-line cells (the kind badge, the poster shape, the
  // catalog count) to the centre of a three-line row while the multi-line cells
  // started at the top. The Events column made it worse by adding a third line.
  const html = adminPromotions.renderBody({ events: [] });
  const table = (html.match(/<table[^>]*>/) || [''])[0];
  assert.match(table, /align-top/);
  assert.ok(!/table-vcenter/.test(table));

  const { compatCss } = require('../lib/ui/compat');
  const css = typeof compatCss === 'function' ? compatCss() : compatCss;
  assert.match(String(css), /\.table\.align-top td[^}]*vertical-align: top/,
    'the class the markup asks for must actually be styled');
});
