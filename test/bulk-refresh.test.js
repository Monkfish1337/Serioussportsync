'use strict';

// Which promotions a bulk-refresh request actually refreshes.
//
// The rules matter more than they look: a wrong "select all" costs a full pull
// of every source, several of which are rate-limited and one of which is a paid
// key. So an empty or unrecognised selection has to refresh NOTHING rather than
// falling back to everything.

const test = require('node:test');
const assert = require('node:assert/strict');
const adminPromotions = require('../lib/admin-promotions');

const ALL = [
  { id: 'epl', name: 'Premier League', enabled: true },
  { id: 'ucl', name: 'Champions League', enabled: true },
  { id: 'wwe', name: 'WWE', enabled: false },
];

test('an empty selection selects nothing, not everything', () => {
  for (const field of ['', '   ', ',,,', null, undefined]) {
    const { selected } = adminPromotions.selectForRefresh(field, ALL);
    assert.deepEqual(selected, [], JSON.stringify(field) + ' should select nothing');
  }
});

test('a promotion ticked twice is refreshed once', () => {
  const { selected } = adminPromotions.selectForRefresh('epl,ucl,epl', ALL);
  assert.deepEqual(selected.map((p) => p.id), ['epl', 'ucl']);
});

// Silently dropping these would leave the user reading a success message for a
// refresh that never ran.
test('unknown and disabled promotions are reported, not dropped', () => {
  const { selected, skipped } = adminPromotions.selectForRefresh('epl,wwe,nonsense', ALL);
  assert.deepEqual(selected.map((p) => p.id), ['epl']);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.some((line) => /WWE.*disabled/.test(line)), skipped.join(' | '));
  assert.ok(skipped.some((line) => /nonsense.*not found/.test(line)), skipped.join(' | '));
});

test('whitespace around ids is tolerated', () => {
  const { selected } = adminPromotions.selectForRefresh(' epl , ucl ', ALL);
  assert.deepEqual(selected.map((p) => p.id), ['epl', 'ucl']);
});
