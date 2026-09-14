'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {formatTimestamp} = require('../lib/display-time');
test('England display follows GMT, BST and both daylight-saving transitions', () => {
  assert.equal(formatTimestamp('2026-09-14T09:00:00Z','Europe/London'),'2026-09-14 10:00:00.000');
  assert.equal(formatTimestamp('2026-01-14T09:00:00Z','Europe/London'),'2026-01-14 09:00:00.000');
  assert.equal(formatTimestamp('2026-03-29T01:00:00Z','Europe/London'),'2026-03-29 02:00:00.000');
  assert.equal(formatTimestamp('2026-10-25T01:00:00Z','Europe/London'),'2026-10-25 01:00:00.000');
  assert.equal(formatTimestamp('2026-09-14T09:00:00Z','UTC'),'2026-09-14 09:00:00.000');
});
