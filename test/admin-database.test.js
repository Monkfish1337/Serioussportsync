'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-database-admin-'));
process.env.SETTINGS_FILE = path.join(dir, 'settings.json');

const settings = require('../lib/settings');
const adminDatabase = require('../lib/admin-database');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('persists validated warmer settings and restores environment defaults', () => {
  const saved = settings.setAvailabilityWarm({
    enabled: false, serveConfirmed: true, windowDays: 14, intervalHours: 1.5,
    maxEventsPerRun: 40, startDelaySeconds: 30,
  });
  assert.deepEqual(saved, {
    enabled: false, serveConfirmed: true, windowDays: 14, intervalHours: 1.5,
    maxEventsPerRun: 40, startDelaySeconds: 30,
  });
  assert.deepEqual(settings.getAvailabilityWarm(), saved);
  assert.throws(() => settings.setAvailabilityWarm({
    enabled: true, windowDays: 0, intervalHours: 6,
    maxEventsPerRun: 25, startDelaySeconds: 60,
  }), /Window days/);
  const reset = settings.resetAvailabilityWarm();
  assert.equal(reset.enabled, true);
  assert.equal(reset.windowDays, 7);
});

test('renders database visibility, live warming and safe maintenance controls', () => {
  const html = adminDatabase.renderBody({
    stats: {
      releases: 12, eventMatches: 8, freshSearches: 4, freshObservations: 3,
      searchHits: 7, searchMisses: 3, hitRate: 0.7, schemaVersion: 1,
      file: '/app/data/availability.sqlite', byProvider: { torbox: 2, uu: 1 },
    },
    fileSize: 2048,
    warm: {
      running: true, currentEvent: 'UFC 300', currentProfile: 'admin',
      completedProfiles: 2, totalProfiles: 4, attemptedEvents: 1,
      eligibleEvents: 5, errors: 0,
      providerStatus: {
        uu: { attempts: 2, successes: 0, failures: 2, skipped: 3,
          totalDurationMs: 30000, lastDurationMs: 15000, lastError: 'network timeout', suppressed: true },
      },
    },
    scheduler: {
      nextRunAt: '2026-08-30T22:00:00Z',
      settings: { enabled: true, serveConfirmed: true, windowDays: 7, intervalHours: 6, maxEventsPerRun: 25, startDelaySeconds: 60 },
    },
    searches: [{ eventId: 'ufc:300', eventTitle: 'UFC 300: Pereira vs Hill', provider: 'torrent', resultCount: 6, searchedAt: Date.now(), expiresAt: Date.now() + 10000 }],
  });
  for (const expected of [
    'Background warming', 'UFC 300', 'Recent searches', 'ufc:300', 'Pereira vs Hill',
    'Warmer provider diagnostics', 'Suppressed', 'network timeout',
    'Serve fresh confirmed results',
    'name="windowDays"', 'name="intervalHours"', 'name="maxEventsPerRun"',
    '/admin/database/prune', '/admin/database/wipe', '/admin/database/status.json',
  ]) assert.match(html, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const script = html.match(/<script>([\s\S]+)<\/script>/);
  assert.ok(script, 'database live-refresh script is present');
  assert.doesNotThrow(() => new Function(script[1]));
  assert.doesNotMatch(html, /denylist|Legacy positive history|admin\/health/i);
});
