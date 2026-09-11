'use strict';

// Switching every catalog off.
//
// Reported as: turn them all off one by one, save, and they all come back on.
// An empty `catalogs` array has always meant "all" — the right default for a
// new account and for a user who ticks everything — and it was also exactly
// what unticking everything produced. "None" was the one selection the UI
// could not express.

const test = require('node:test');
const assert = require('node:assert');
const { effectiveCatalogSelection } = require('../lib/catalog-selection');
const configurePage = require('../lib/configure-page');
const collectionSettings = require('../lib/nuvio-collection-settings');

test('an empty catalogs list still means "all", for every account that has one', () => {
  // Existing installs have [] on disk meaning "all". Reinterpreting it would
  // empty every catalog on upgrade, which is why "none" got its own flag
  // rather than a new meaning for [].
  assert.equal(effectiveCatalogSelection({}), null);
  assert.equal(effectiveCatalogSelection({ catalogs: [] }), null);
  assert.equal(effectiveCatalogSelection({ catalogs: [], catalogsNone: false }), null);
});

test('an explicit "none" is honoured', () => {
  const selection = effectiveCatalogSelection({ catalogs: [], catalogsNone: true });
  assert.ok(selection instanceof Set);
  assert.equal(selection.size, 0);
});

test('"none" wins even if a stale catalogs list is still on disk', () => {
  // updateUserConfig patches keys rather than replacing the object, so a
  // previous selection can outlive the choice to switch everything off.
  const selection = effectiveCatalogSelection({ catalogs: ['ufc-upcoming'], catalogsNone: true });
  assert.equal(selection.size, 0);
});

test('the catalogs step offers Enable all and Disable all', () => {
  // Twenty-nine promotions is a lot of clicking to reach "just the two I
  // watch", and the same again to undo it.
  const html = renderCatalogs();
  assert.match(html, /id="catalogs-all"/);
  assert.match(html, /id="catalogs-none"/);
  assert.match(html, /setAllCatalogs/);
});

test('the form marks that it carried the catalog step', () => {
  // Without the marker, "zero catalogs posted" is ambiguous: it could be a
  // user switching everything off, or a form that had no catalog fields in it
  // at all. The save handler must be able to tell those apart before it writes
  // catalogsNone.
  assert.match(renderCatalogs(), /name="catalogSelection" value="1"/);
});

test('switching everything off says what will happen', () => {
  assert.match(renderCatalogs(), /No rows — your catalogs will be empty/);
});

function renderCatalogs() {
  return configurePage.render({
    user: { id: 'u1', apiToken: 't1', config: {} },
    isAdmin: false,
    isFirstRun: false,
    step: 'catalogs',
    installUrl: 'http://sss.local/u/u1/t1/manifest.json',
    promotions: [
      { id: 'ufc', name: 'UFC', catalogs: [{ id: 'ufc-upcoming' }, { id: 'ufc-recent' }] },
      { id: 'wwe', name: 'WWE', catalogs: [{ id: 'wwe-upcoming' }] },
    ],
    selected: new Set(),
    selectAll: false,
    folderOf: {},
    collections: collectionSettings.defaults(),
    choosers: [],
    teamPromotions: [],
  });
}

test('with nothing selected, no row renders as on', () => {
  const html = renderCatalogs();
  assert.ok(!/class="promo-on"[^>]*checked/.test(html),
    'an account with everything switched off must come back with everything off');
});

test('the manifest serves no catalogs when everything is off', () => {
  // The point of the flag: it has to reach the thing the client actually
  // reads, not just the page that draws the switches.
  const { buildManifest } = require('../lib/manifest');
  const all = buildManifest({ user: { config: {} } });
  assert.ok(all.catalogs.length > 0, 'the default account still gets every row');
  const none = buildManifest({ user: { config: { catalogs: [], catalogsNone: true } } });
  assert.equal(none.catalogs.length, 0);
});
