'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const warmer = require('../lib/availability-warmer');

function event(id, date) {
  return { id: 'ufc:' + id, name: 'UFC ' + id, date };
}

test('selects only the rolling seven-day aired-event window', () => {
  const selected = warmer.eligibleEvents([
    event('today', '2026-08-27'),
    event('six-days', '2026-08-21'),
    event('seven-days', '2026-08-20'),
    event('future', '2026-08-28'),
    event('invalid', 'soon'),
  ], { now: new Date('2026-08-27T18:00:00Z'), windowDays: 7 });
  assert.deepEqual(selected.map((item) => item.id), ['ufc:today', 'ufc:six-days']);
});

test('rotates bounded batches through the complete recent window', async () => {
  warmer._test.resetForTests();
  const events = [
    event('one', '2026-08-27'), event('two', '2026-08-26'),
    event('three', '2026-08-25'), event('four', '2026-08-24'),
  ];
  const visited = [];
  const options = {
    force: true,
    events,
    now: new Date('2026-08-27T18:00:00Z'),
    maxEvents: 2,
    profiles: [{ username: 'test', config: {} }],
    prefetch: async ({ event: item }) => { visited.push(item.id); return { ok: true, errors: [] }; },
    log: () => {},
  };
  await warmer.run(options);
  await warmer.run(options);
  assert.deepEqual(visited, ['ufc:one', 'ufc:two', 'ufc:three', 'ufc:four']);
  assert.equal(warmer.status().eligibleEvents, 4);
  assert.equal(warmer.status().attemptedEvents, 2);
});

test('coalesces overlapping warm-up requests', async () => {
  warmer._test.resetForTests();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const options = {
    force: true,
    events: [event('one', '2026-08-27')],
    now: new Date('2026-08-27T18:00:00Z'),
    profiles: [{ username: 'test', config: {} }],
    prefetch: async () => { calls++; await gate; return { ok: true, errors: [] }; },
    log: () => {},
  };
  const first = warmer.run(options);
  const second = warmer.run(options);
  assert.strictEqual(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  const active = warmer.status();
  assert.equal(active.running, true);
  assert.equal(active.currentEvent, 'UFC one');
  assert.equal(active.currentProfile, 'test');
  assert.equal(active.totalProfiles, 1);
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal(warmer.status().currentEvent, null);
  assert.ok(warmer.status().lastDurationMs >= 0);
});
