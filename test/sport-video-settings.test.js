'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-sport-video-settings-'));
process.env.SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'sport-video-settings-test-secret-000000000000000000000000000000';
const settings = require('../lib/settings');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('Sport-Video is opt-in with conservative automatic scan defaults', () => {
  const value = settings.getSportVideo();
  assert.equal(value.enabled, false);
  assert.equal(value.autoScan, true);
  assert.equal(value.intervalHours, 6);
  assert.equal(value.maxDetailsPerScan, 50);
  assert.equal(value.archivePages, 12);
  assert.deepEqual(value.autoWarmPromotions, []);
  assert.equal(value.autoWarmPerScan, 5);
  assert.equal(value.autoWarmWindowDays, 14);
  assert.deepEqual(value.teamFilters, {});
  assert.ok(value.categories.includes('baseball'));
  assert.ok(value.categories.includes('football'));
});

test('validates and persists bounded Sport-Video scan controls', () => {
  const value = settings.setSportVideo({
    enabled: true, autoScan: false, intervalHours: 12, startDelaySeconds: 120,
    maxDetailsPerScan: 25, archivePages: 20,
    categories: ['baseball', 'football', 'unknown', 'baseball'],
  });
  assert.deepEqual(value, {
    enabled: true, autoScan: false, intervalHours: 12, startDelaySeconds: 120,
    maxDetailsPerScan: 25, archivePages: 20, autoWarmPromotions: [], autoWarmPerScan: 5,
    autoWarmWindowDays: 14, teamFilters: {}, categories: ['baseball', 'football'],
  });
  // Team filters are stored per promotion, de-duplicated, and an empty
  // selection is dropped so "not filtered" has one representation.
  assert.deepEqual(settings.setSportVideo({
    enabled: true, autoScan: false, intervalHours: 12, startDelaySeconds: 120,
    maxDetailsPerScan: 25, archivePages: 20, categories: ['baseball'],
    teamFilters: {
      mlb: ['New York Yankees', 'New York Yankees', '  '],
      ucl: [],
      boxing: '',
    },
  }).teamFilters, { mlb: ['New York Yankees'] });
  // Auto-warm is opt-in per promotion and de-duplicates its selection.
  assert.deepEqual(settings.setSportVideo({
    enabled: true, autoScan: false, intervalHours: 12, startDelaySeconds: 120,
    maxDetailsPerScan: 25, archivePages: 20, autoWarmPerScan: 3,
    autoWarmPromotions: ['ucl', 'ufc', 'ucl', ''], categories: ['football'],
  }).autoWarmPromotions, ['ucl', 'ufc']);
  assert.equal(settings.setSportVideo({
    enabled: true, autoScan: false, intervalHours: 12, startDelaySeconds: 120,
    maxDetailsPerScan: 25, archivePages: 0, categories: ['baseball'],
  }).archivePages, 0);
  assert.throws(() => settings.setSportVideo({
    enabled: true, autoScan: true, intervalHours: 6, startDelaySeconds: 90,
    maxDetailsPerScan: 50, archivePages: 900, categories: ['baseball'],
  }), /Archive pages/);
  assert.throws(() => settings.setSportVideo({
    enabled: true, autoScan: true, intervalHours: 0, startDelaySeconds: 90,
    maxDetailsPerScan: 50, categories: ['baseball'],
  }), /Scan interval/);
  assert.throws(() => settings.setSportVideo({
    enabled: true, autoScan: true, intervalHours: 6, startDelaySeconds: 90,
    maxDetailsPerScan: 50, categories: [],
  }), /Select at least one/);
});
