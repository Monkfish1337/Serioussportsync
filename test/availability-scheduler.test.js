'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../lib/settings');
const warmer = require('../lib/availability-warmer');
const scheduler = require('../lib/availability-scheduler');

test('reconfigures the live warm schedule and exposes the next run', async () => {
  const originalSettings = settings.getAvailabilityWarm;
  const originalRun = warmer.run;
  let enabled = true;
  settings.getAvailabilityWarm = () => ({
    enabled, windowDays: 7, intervalHours: 1, maxEventsPerRun: 25, startDelaySeconds: 5,
  });
  warmer.run = async ({ reason }) => ({ ok: true, reason });
  try {
    scheduler.start({ available: true, log: () => {} });
    assert.equal(scheduler.status().scheduled, true);
    assert.ok(scheduler.status().nextRunAt);
    const manual = await scheduler.runNow('manual', { force: true });
    assert.deepEqual(manual, { ok: true, reason: 'manual' });
    assert.equal(scheduler.status().scheduled, true);
    enabled = false;
    scheduler.reconfigure();
    assert.equal(scheduler.status().scheduled, false);
    assert.equal(scheduler.status().nextRunAt, null);
  } finally {
    scheduler.stop();
    settings.getAvailabilityWarm = originalSettings;
    warmer.run = originalRun;
  }
});
