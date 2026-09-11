'use strict';

// Enable/disable toggles for the three discovery sources.
//
// The toggle exists so a source can be taken out of the pipeline without
// destroying its URL and credentials — comparing sources means switching them
// on and off repeatedly. Two things therefore have to hold: an absent flag
// means enabled (settings saved before the toggle existed keep working), and
// a save that does not mention the flag leaves it alone.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const file = path.join(os.tmpdir(), 'sss-toggle-' + process.pid + '.json');
process.env.SETTINGS_FILE = file;
// Settings are encrypted at rest, so even reading them needs a secret.
process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'toggle-test-session-secret-0123456789abcdef';
const settings = require('../lib/settings');

test.after(() => { try { fs.unlinkSync(file); } catch (_) {} });

function writeRaw(state) {
  fs.writeFileSync(file, JSON.stringify(state), 'utf8');
}

test('a config saved before toggles existed is treated as enabled', () => {
  // No `enabled` key anywhere — this is what every existing install has.
  writeRaw({
    companion: { url: 'http://scraper:8080', authToken: 't' },
    prowlarr: { url: 'http://prowlarr:9696', apiKey: 'k' },
    bitmagnet: { url: 'http://bitmagnet:3333' },
  });
  assert.equal(settings.getCompanion().enabled, true);
  assert.equal(settings.getProwlarr().enabled, true);
  assert.equal(settings.getBitmagnet().enabled, true);
});

test('an explicit false is honoured', () => {
  writeRaw({
    companion: { url: 'http://scraper:8080', enabled: false },
    prowlarr: { url: 'http://prowlarr:9696', apiKey: 'k', enabled: false },
    bitmagnet: { url: 'http://bitmagnet:3333', enabled: false },
  });
  assert.equal(settings.getCompanion().enabled, false);
  assert.equal(settings.getProwlarr().enabled, false);
  assert.equal(settings.getBitmagnet().enabled, false);
  // Disabling must not discard the credentials — that is the whole point.
  assert.equal(settings.getCompanion().url, 'http://scraper:8080');
  assert.equal(settings.getProwlarr().apiKey, 'k');
  assert.equal(settings.getBitmagnet().url, 'http://bitmagnet:3333');
});

test('form checkbox values round-trip', () => {
  writeRaw({});
  settings.setBitmagnet({ url: 'http://bitmagnet:3333', enabled: '1' });
  assert.equal(settings.getBitmagnet().enabled, true);
  settings.setBitmagnet({ url: 'http://bitmagnet:3333', enabled: '0' });
  assert.equal(settings.getBitmagnet().enabled, false);
  settings.setBitmagnet({ url: 'http://bitmagnet:3333', enabled: 'on' });
  assert.equal(settings.getBitmagnet().enabled, true);
});

test('a save that omits the flag preserves it', () => {
  // The admin form marks its submissions with `sourceToggles`; without that
  // marker the handler passes undefined, and the stored value must survive.
  // Otherwise a stale cached form would silently disable every source.
  writeRaw({ bitmagnet: { url: 'http://bitmagnet:3333', enabled: false } });
  settings.setBitmagnet({ url: 'http://bitmagnet:3333', limit: 500 });
  assert.equal(settings.getBitmagnet().enabled, false, 'omitted flag must not re-enable');
  assert.equal(settings.getBitmagnet().limit, 500);

  writeRaw({ prowlarr: { url: 'http://prowlarr:9696', apiKey: 'k', enabled: false } });
  settings.setProwlarr({ url: 'http://prowlarr:9696', apiKey: 'k' });
  assert.equal(settings.getProwlarr().enabled, false);

  writeRaw({ companion: { url: 'http://scraper:8080', enabled: false } });
  settings.setCompanion({ url: 'http://scraper:8080', authToken: '' });
  assert.equal(settings.getCompanion().enabled, false);
});

test('a fresh save with no prior state defaults to enabled', () => {
  writeRaw({});
  settings.setBitmagnet({ url: 'http://bitmagnet:3333' });
  assert.equal(settings.getBitmagnet().enabled, true);
});

test('disabling a source changes the discovery cache fingerprint', () => {
  // Without this, disabling a source would keep serving searches cached while
  // it was enabled, and the comparison the toggle exists for is meaningless.
  const streams = require('../lib/streams')._test;
  const fingerprints = new Set();
  const index = {
    scopeFingerprint: (provider, values) => JSON.stringify([provider, values]),
  };
  const original = {
    companion: settings.getCompanion, prowlarr: settings.getProwlarr,
    bitmagnet: settings.getBitmagnet, sportVideo: settings.getSportVideo,
  };
  settings.getSportVideo = () => ({ enabled: false });
  settings.getCompanion = () => ({ url: '', authToken: '', enabled: true });
  settings.getProwlarr = () => ({ url: '', apiKey: '', enabled: true });
  try {
    settings.getBitmagnet = () => ({ url: 'http://bitmagnet:3333', limit: 300, videoOnly: false, enabled: true });
    fingerprints.add(streams.torrentDiscoveryScope(index));
    settings.getBitmagnet = () => ({ url: 'http://bitmagnet:3333', limit: 300, videoOnly: false, enabled: false });
    fingerprints.add(streams.torrentDiscoveryScope(index));
    assert.equal(fingerprints.size, 2, 'enabled and disabled must not share a cache scope');
  } finally {
    settings.getCompanion = original.companion;
    settings.getProwlarr = original.prowlarr;
    settings.getBitmagnet = original.bitmagnet;
    settings.getSportVideo = original.sportVideo;
  }
});

// 0.95.0 — Sport-Video's switch was the one missing from the Server page.
//
// It always existed, but only on the Sport-Video page's own form, so the
// discovery-sources card listed three toggles and silently omitted the fourth.
// Reported as "the Sport-Video pipeline has no disable toggle", which is what
// it looked like from the only screen where the other three live.

test('Sport-Video can be switched without resubmitting its whole form', () => {
  // setSportVideo refuses a save with no categories — correctly, since a scan
  // with nothing to scan is a mis-filled form. That is exactly why the switch
  // could not be mirrored onto the Server page until it had a setter of its
  // own, and why this one must not touch any other field.
  writeRaw({
    sportVideo: {
      enabled: false, autoScan: true, intervalHours: 12,
      categories: ['football', 'rugby'], maxDetailsPerScan: 25,
    },
  });
  const on = settings.setSportVideoEnabled(true);
  assert.equal(on.enabled, true);
  assert.equal(on.intervalHours, 12, 'the scan settings must survive a toggle');
  assert.deepEqual(on.categories, ['football', 'rugby']);
  assert.equal(on.maxDetailsPerScan, 25);

  assert.equal(settings.setSportVideoEnabled(false).enabled, false);
  assert.deepEqual(settings.getSportVideo().categories, ['football', 'rugby'],
    'disabling must not discard what was configured');
});

test('Sport-Video is off until switched on, unlike the other three', () => {
  // The asymmetry is deliberate and worth pinning: companion, Prowlarr and
  // Bitmagnet are enabled unless a flag says otherwise, because they predate
  // the toggles. Sport-Video reaches a third-party site on a schedule, so it
  // stays opt-in.
  writeRaw({});
  assert.equal(settings.getSportVideo().enabled, false);
  assert.equal(settings.getCompanion().enabled, true);
});

test('a partial Sport-Video save keeps what this form does not carry', () => {
  // The Server card owns the pipeline settings — does it run, how often, which
  // sports. Team filters and auto-warm are drawn from the promotion list and
  // stay on the Sport-Video page, so a save from the Server card must patch
  // rather than replace. setSportVideo replaces, which is why updateSportVideo
  // exists.
  writeRaw({
    sportVideo: {
      enabled: true, autoScan: true, intervalHours: 6,
      categories: ['football'], autoWarmPromotions: ['epl', 'ucl'],
      autoWarmPerScan: 3,
    },
  });
  const saved = settings.updateSportVideo({
    enabled: true, autoScan: false, intervalHours: 24, categories: ['football', 'rugby'],
  });
  assert.equal(saved.autoScan, false);
  assert.equal(saved.intervalHours, 24);
  assert.deepEqual(saved.categories, ['football', 'rugby']);
  assert.deepEqual(saved.autoWarmPromotions, ['epl', 'ucl'],
    'a field this form never showed must not be blanked by saving it');
  assert.equal(saved.autoWarmPerScan, 3);
});

test('the switch works even when no category is posted', () => {
  // The Sport-Video block is collapsed by default, so a save from a Server page
  // where nobody opened it carries the switch and nothing else. Refusing that
  // save would make "turn this off" depend on a field in a closed block.
  writeRaw({ sportVideo: { enabled: true, categories: ['football'] } });
  assert.equal(settings.setSportVideoEnabled(false).enabled, false);
  assert.deepEqual(settings.getSportVideo().categories, ['football']);
});
