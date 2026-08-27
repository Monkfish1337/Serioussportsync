'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-nuvio-layout-'));
const originalFile = config.nuvioCollectionsFile;
config.nuvioCollectionsFile = path.join(testDir, 'nuvio-collections.json');

const settings = require('../lib/nuvio-collection-settings');
const collections = require('../lib/nuvio-collections');
const promotions = require('../lib/promotions');
const chrome = require('../lib/tabler-chrome');
const admin = require('../lib/admin-nuvio-collections');

test.after(() => {
  config.nuvioCollectionsFile = originalFile;
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('keeps the existing four-folder Nuvio layout as the upgrade default', () => {
  const state = settings.load();
  assert.deepEqual(state.folders.map((folder) => folder.title), ['Combat Sports', 'Wrestling', 'Football', 'Motorsport']);
  assert.equal(state.collection.id, collections.COLLECTION_ID);
});

test('adds a new promotion folder with selected artwork and exports it', () => {
  const fake = {
    id: 'mlb-smoke', name: 'Major League Baseball', idPrefix: 'mlb-smoke', enabled: true,
    catalogs: [{ id: 'mlb-smoke-upcoming', name: 'MLB Upcoming' }],
    defaults: { fanart: 'https://images.example/mlb.jpg' },
  };
  promotions.enabled.push(fake);
  promotions.all.push(fake);
  try {
    settings.upsertFolder(null, {
      title: 'Major League Baseball', promotions: ['mlb-smoke'], artwork: 'promotion', tileShape: 'landscape', hideTitle: false,
    }, new Set(promotions.enabled.map((promotion) => promotion.id)));
    const payload = collections.buildNuvioCollections({ origin: 'https://sss.example', user: { config: {} } });
    const folder = payload[0].folders.find((item) => item.title === 'Major League Baseball');
    assert.ok(folder);
    assert.equal(folder.coverImageUrl, 'https://images.example/mlb.jpg');
    assert.deepEqual(folder.sources.map((source) => source.catalogId), ['mlb-smoke-upcoming']);
  } finally {
    promotions.enabled.splice(promotions.enabled.indexOf(fake), 1);
    promotions.all.splice(promotions.all.indexOf(fake), 1);
  }
});

test('validates collection artwork and exposes the admin workflow', () => {
  assert.throws(() => settings.cleanImage('javascript:alert(1)', true), /Image must be/);
  assert.ok(chrome.ADMIN_SECTIONS.some((item) => item.id === 'nuvio-collections'));
  const html = admin.renderBody({});
  assert.match(html, /Nuvio Collections/);
  assert.match(html, /Add collection folder/);
  assert.match(html, /Use first promotion artwork/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script[1])); // eslint-disable-line no-new-func
});
