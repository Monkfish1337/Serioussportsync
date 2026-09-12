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
const uiShell = require('../lib/ui/shell');
const admin = require('../lib/admin-nuvio-collections');
const configurePage = require('../lib/configure-page');

test.after(() => {
  config.nuvioCollectionsFile = originalFile;
  fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('ships the default Nuvio layout', () => {
  // Four folders until collections version 2, which added Big 3 (NFL, NBA and
  // MLB had no folder at all) and Unmatched (the seven discovered-* catalogs,
  // which read as seven more full leagues while they sat loose).
  const state = settings.load();
  assert.deepEqual(state.folders.map((folder) => folder.title),
    ['Combat Sports', 'Wrestling', 'Football', 'Motorsport', 'Big 3', 'Unmatched']);
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
  assert.ok(uiShell.destinations(true).some((item) => item.id === 'nuvio-collections'),
    'Collections must be reachable from the rail');
  const html = admin.renderBody({});
  assert.match(html, /Nuvio Collections/);
  assert.match(html, /Add collection folder/);
  assert.match(html, /Use first promotion artwork/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script[1])); // eslint-disable-line no-new-func
});

test('accepts the wizard artwork field when saving a folder', () => {
  const input = admin.folderInput({
    title: 'Wizard folder', promotions: ['ufc'], artwork: '/assets/logo-banner.png', tileShape: 'landscape',
  });
  assert.equal(input.artwork, '/assets/logo-banner.png');
});

test('the collections wizard posts the fields expected by the folder endpoint', () => {
  const html = configurePage.render({
    isAdmin: true,
    collections: { folders: [{
      id: 'folder-1', title: 'Folder', promotions: [], artwork: '/assets/logo-banner.png', tileShape: 'landscape',
    }] },
  });
  // 0.95.0 — these are read from real controls on the step rather than from
  // data-attributes echoing what the server already had, because the step is
  // now the editor rather than a viewer with one button.
  assert.match(html, /body\.append\('artworkChoice', get\('artworkChoice'\)\.value\)/);
  assert.match(html, /body\.append\('customArtwork'/);
  assert.match(html, /body\.append\('title', get\('title'\)\.value\)/);
  // Sent only when ticked, which is what the endpoint reads.
  assert.match(html, /body\.append\('hideTitle', '1'\)/);
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

// ---------------------------------------------------------------------------
// Big 3 and Unmatched, added in collections version 2.

test('the American big three have a folder', () => {
  const settings = require('../lib/nuvio-collection-settings');
  const folder = settings.defaults().folders.find((f) => f.title === 'Big 3');
  assert.ok(folder, 'NFL, NBA and MLB sat loose among the ungrouped catalogs');
  assert.deepEqual(folder.promotions, ['nfl', 'nba', 'mlb']);
  assert.equal(folder.artwork, '/assets/collection-big-3.png');
});

test('the discovered catalogs are gathered as Unmatched', () => {
  // They exist for events pulled out of release listings that matched no
  // promotion. Loose on the home screen they read as seven more leagues with
  // full schedules, which is the opposite of what they are.
  const settings = require('../lib/nuvio-collection-settings');
  const folder = settings.defaults().folders.find((f) => f.title === 'Unmatched');
  assert.ok(folder);
  assert.equal(folder.promotions.length, 7);
  for (const id of folder.promotions) assert.match(id, /^discovered-/);
  assert.equal(folder.artwork, '/assets/collection-unmatched.png');
});

test('both images are bundled at the size the other tiles use', () => {
  // A folder pointing at a missing asset renders an empty tile, and the tiles
  // sit in one row, so an odd size shows immediately.
  const fs = require('fs');
  const path = require('path');
  const pub = path.join(__dirname, '..', 'public');
  for (const name of ['collection-big-3.png', 'collection-unmatched.png']) {
    const file = path.join(pub, name);
    assert.ok(fs.existsSync(file), name + ' must be bundled');
    const head = fs.readFileSync(file).subarray(0, 24);
    assert.equal(head.readUInt32BE(16), 1672, name + ' width');
    assert.equal(head.readUInt32BE(20), 941, name + ' height');
  }
});

test('a new default folder reaches an install that already saved', () => {
  // A saved file replaces the defaults outright — that is what makes the
  // editor work — so without this a new default folder would appear for nobody,
  // since everyone has saved at least once.
  const settings = require('../lib/nuvio-collection-settings');
  const before = settings.defaults();
  const v1 = {
    version: 1,
    collection: before.collection,
    folders: before.folders.slice(0, 4).map((f) => Object.assign({}, f)),
  };
  v1.folders[0].title = 'My Combat Sports';
  const after = settings.normalize(v1);
  assert.equal(after.version, 2);
  assert.ok(after.folders.some((f) => f.title === 'Big 3'));
  assert.ok(after.folders.some((f) => f.title === 'Unmatched'));
  assert.ok(after.folders.some((f) => f.title === 'My Combat Sports'),
    'an edited folder must survive untouched');
});

test('a folder the operator deleted stays deleted', () => {
  // The migration is gated on the stored version, so once it has run the
  // folder is the operator's to remove. Re-adding it on every load would make
  // deleting it impossible.
  const settings = require('../lib/nuvio-collection-settings');
  const current = settings.defaults();
  const withoutBig3 = {
    version: 2,
    collection: current.collection,
    folders: current.folders.filter((f) => f.title !== 'Big 3'),
  };
  const after = settings.normalize(withoutBig3);
  assert.ok(!after.folders.some((f) => f.title === 'Big 3'));
});

test('the bundled images are offered in both artwork pickers', () => {
  // A folder whose artwork is not in the list renders as "Custom image URL",
  // and an operator cannot pick the new images for a folder of their own.
  const fs = require('fs');
  const path = require('path');
  for (const file of ['admin-nuvio-collections.js', 'configure-page.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8');
    const list = source.slice(source.indexOf('ARTWORK_CHOICES'));
    const block = list.slice(0, list.indexOf('];'));
    assert.ok(block.includes('/assets/collection-big-3.png'), file + ' needs Big 3');
    assert.ok(block.includes('/assets/collection-unmatched.png'), file + ' needs Unmatched');
  }
});
