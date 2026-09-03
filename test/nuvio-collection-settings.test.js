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

// Emptying a folder was refused outright, and any folder emptied as a
// side-effect was silently deleted. Between them, "remove this promotion from
// my Nuvio collection" either failed with an error or made the folder vanish —
// both of which the user reads as the save not working.
test('a promotion can be removed from a folder, including the last one', () => {
  const ids = new Set(promotions.enabled.map((p) => p.id));
  const state = settings.load();
  const folder = state.folders.find((item) => item.promotions.length > 1);
  assert.ok(folder, 'expected a multi-promotion default folder');

  const keep = folder.promotions.slice(0, -1);
  const dropped = folder.promotions[folder.promotions.length - 1];
  const base = {
    title: folder.title, artwork: folder.artwork,
    tileShape: folder.tileShape, hideTitle: folder.hideTitle,
  };
  settings.upsertFolder(folder.id, Object.assign({}, base, { promotions: keep }), ids);
  let saved = settings.load().folders.find((item) => item.id === folder.id);
  assert.deepEqual(saved.promotions, keep, 'removing one promotion should persist');
  assert.ok(!saved.promotions.includes(dropped));

  // Emptying it completely is allowed, and the folder survives so the user can
  // put something back into it.
  settings.upsertFolder(folder.id, Object.assign({}, base, { promotions: [] }), ids);
  saved = settings.load().folders.find((item) => item.id === folder.id);
  assert.ok(saved, 'the folder should still exist after being emptied');
  assert.deepEqual(saved.promotions, []);

  // An empty folder is simply omitted from the Nuvio export.
  const exported = collections.buildNuvioCollections({ user: { config: {} }, origin: 'https://example.test' });
  assert.ok(!exported[0].folders.some((item) => item.id === folder.id),
    'an empty folder should not be exported to Nuvio');

  // A brand-new folder with nothing selected is still a mis-filled form.
  assert.throws(() => settings.upsertFolder(null, Object.assign({}, base, {
    title: 'Empty on creation', promotions: [],
  }), ids), /at least one promotion/);
});
