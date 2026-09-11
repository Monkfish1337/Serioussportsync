'use strict';

// Serving a catalog and showing it on the home screen are different choices.
//
// Reported as: push collections to Nuvio with home rows disabled and the
// folders open empty; enable everything and they work, but every catalog is
// also duplicated as a home row underneath. The cause is that there was only
// one switch. Turning it off removed the catalog from the manifest entirely,
// and a Nuvio collection folder whose source is a catalog the manifest no
// longer declares has nothing to show.

const test = require('node:test');
const assert = require('node:assert');
const { buildManifest } = require('../lib/manifest');
const configurePage = require('../lib/configure-page');
const collectionSettings = require('../lib/nuvio-collection-settings');

test('hiding a home row keeps the catalog served', () => {
  // This is the whole fix: the folder still resolves, the row is gone.
  const all = buildManifest({ user: { config: {} } });
  const first = all.catalogs[0].id;
  const hidden = buildManifest({ user: { config: { homeRowsHidden: [first] } } });

  assert.equal(hidden.catalogs.length, all.catalogs.length,
    'hiding must not remove the catalog from the manifest');
  assert.ok(hidden.catalogs.some((c) => c.id === first));
  assert.equal(hidden.catalogs.find((c) => c.id === first).showInHome, false);
  assert.equal(all.catalogs.find((c) => c.id === first).showInHome, true);
});

test('hiding one row leaves the others alone', () => {
  const all = buildManifest({ user: { config: {} } });
  const hidden = buildManifest({ user: { config: { homeRowsHidden: [all.catalogs[0].id] } } });
  const stillShown = hidden.catalogs.filter((c) => c.showInHome).length;
  assert.equal(stillShown, all.catalogs.length - 1);
});

test('an unknown hidden id is harmless', () => {
  // Catalog ids change between versions; a stale entry must not hide anything.
  const all = buildManifest({ user: { config: {} } });
  const stale = buildManifest({ user: { config: { homeRowsHidden: ['no-such-catalog'] } } });
  assert.equal(stale.catalogs.filter((c) => c.showInHome).length,
    all.catalogs.filter((c) => c.showInHome).length);
});

test('a catalog added after the user last saved still gets a home row', () => {
  // Stored as a hidden list rather than a shown list, precisely so that a new
  // catalog is visible by default instead of silently missing for everyone who
  // saved before it shipped.
  const built = buildManifest({ user: { config: { homeRowsHidden: ['old-catalog-id'] } } });
  assert.ok(built.catalogs.every((c) => c.showInHome === true));
});

test('the step offers both switches, and says what each one does', () => {
  const html = configurePage.render({
    user: { id: 'u1', apiToken: 't1', config: {} },
    isAdmin: false, isFirstRun: false, step: 'catalogs',
    installUrl: 'http://sss.local/m.json',
    promotions: [{ id: 'ufc', name: 'UFC', catalogs: [{ id: 'ufc-upcoming' }] }],
    selected: new Set(), selectAll: true, hiddenHomeRows: new Set(),
    folderOf: {}, collections: collectionSettings.defaults(),
    choosers: [], teamPromotions: [],
  });
  assert.match(html, /class="promo-on"/);
  assert.match(html, /class="promo-home"/);
  assert.match(html, /Served/);
  assert.match(html, /Home row/);
  // The trap is worth naming on the page, not just in a changelog.
  assert.match(html, /folder opens empty/);
});

test('the client posts the hidden rows as their own list', () => {
  const html = configurePage.render({
    user: { id: 'u1', apiToken: 't1', config: {} },
    isAdmin: false, isFirstRun: false, step: 'catalogs',
    installUrl: 'http://sss.local/m.json',
    promotions: [{ id: 'ufc', name: 'UFC', catalogs: [{ id: 'ufc-upcoming' }] }],
    selected: new Set(), selectAll: true, hiddenHomeRows: new Set(['ufc-upcoming']),
    folderOf: {}, collections: collectionSettings.defaults(),
    choosers: [], teamPromotions: [],
  });
  assert.match(html, /name="homeRowsHidden"/);
  // A promotion whose only catalog is hidden renders with its home switch off.
  const row = html.slice(html.indexOf('class="promo-home"') - 200, html.indexOf('class="promo-home"') + 200);
  assert.ok(!/class="promo-home"[^>]*checked/.test(row));
});
