'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-settings-security-'));
const file = path.join(dir, 'settings.json');
process.env.SESSION_SECRET = 'settings-security-test-secret-000000000000000000000000000';
process.env.SETTINGS_FILE = file;

fs.writeFileSync(file, JSON.stringify({
  prowlarr: { url: 'http://prowlarr:9696', apiKey: 'legacy-prowlarr-secret' },
  companion: { url: 'http://scraper:8080', authToken: 'legacy-companion-secret' },
  footballData: { apiKey: 'legacy-football-secret' },
}), 'utf8');

const settings = require('../lib/settings');

test('migrates and encrypts admin source credentials at rest', () => {
  assert.equal(settings.getProwlarr().apiKey, 'legacy-prowlarr-secret');
  assert.equal(settings.getCompanion().authToken, 'legacy-companion-secret');
  assert.equal(settings.getFootballData().apiKey, 'legacy-football-secret');
  const migrated = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(migrated, /legacy-(?:prowlarr|companion|football)-secret/);

  settings.setProwlarr({ url: 'http://prowlarr:9696', apiKey: 'new-prowlarr-secret' });
  settings.setCompanion({ url: 'http://scraper:8080', authToken: 'new-companion-secret' });
  settings.setFootballData({ apiKey: 'new-football-secret' });
  assert.equal(settings.getProwlarr().apiKey, 'new-prowlarr-secret');
  assert.equal(settings.getCompanion().authToken, 'new-companion-secret');
  assert.equal(settings.getFootballData().apiKey, 'new-football-secret');
  const saved = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(saved, /new-(?:prowlarr|companion|football)-secret/);
});
