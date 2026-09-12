'use strict';

// First-run defects — the paths only a brand-new install takes.
//
// This file was written for "Check it works", which was removed in 0.95.1: it
// had to guess which fixture has a release, recency was the only signal it had,
// and recency is uncorrelated with availability — so on working installs it
// picked things like a Friday practice session, found nothing, and told the
// user their setup was broken. Its four tests went with it.
//
// What remains is everything else the first-run walkthrough turned up, which is
// unrelated to that feature and still worth pinning.

const test = require('node:test');
const assert = require('node:assert');
const configurePage = require('../lib/configure-page');
const collectionSettings = require('../lib/nuvio-collection-settings');

function installStep() {
  return configurePage.render({
    user: { id: 'u1', apiToken: 't1', config: {} },
    isAdmin: false, isFirstRun: false, step: 'install',
    installUrl: 'http://sss.local/u/u1/t1/manifest.json',
    promotions: [], selected: new Set(), selectAll: true, folderOf: {},
    collections: collectionSettings.defaults(), choosers: [], teamPromotions: [],
  });
}

test('the setup page does not tell the first user they will not be an admin', () => {
  // It said the account "will be auto-promoted to admin if it matches the
  // ADMIN_USER env var (currently (unset))". Every operator who has not set
  // that variable — the default — was told, on the first screen of the
  // product, that their account would not be an administrator. It always is:
  // POST /setup passes role: 'admin', and createUser takes
  // `role === 'admin' || matchesAdminEnv`.
  // Comments are stripped first: the note explaining this fix quotes the old
  // wording, and a test that cannot tell a comment from a rendered string
  // would fail on its own explanation.
  const stripComments = (text) => text.replace(/^\s*\/\/.*$/gm, '');
  const source = stripComments(require('fs').readFileSync(
    require('path').join(__dirname, '..', 'addon.js'), 'utf8'));
  const setup = source.slice(source.indexOf("app.get('/setup'"));
  const body = setup.slice(0, setup.indexOf("app.post('/setup'"));
  assert.ok(!/auto-promoted/.test(body), 'the false claim must be gone');
  assert.ok(!/\(unset\)/.test(body), 'and the alarming "(unset)" with it');
  assert.match(body, /This first account is the administrator/);

  // The behaviour the copy now describes.
  assert.match(setup.slice(setup.indexOf("app.post('/setup'")), /role: 'admin'/);
});

test('the team picker names a page that exists', () => {
  // "Add a football-data.org API key in Admin → Sources" — there is no Admin
  // nav item and no Sources page; the sidebar says Server. Every new operator
  // hits this message, because nobody has a football-data key on day one.
  const picker = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'team-picker.js'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');   // the fix note quotes the old text
  assert.ok(!/Admin → Sources/.test(picker));
  assert.match(picker, /on the Server page/);

  const shell = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'ui', 'shell.js'), 'utf8');
  assert.match(shell, /label: 'Server'/, 'and that is still what the nav calls it');
});

test('a new install says its catalogs are still filling', () => {
  // Measured: a clean instance was still on the first of 29 promotions several
  // minutes after boot, because the refresh is sequential and the TheSportsDB
  // adapter waits between requests. The Install step handed over a manifest
  // that produces empty rows and said nothing, and "Check it works" then
  // reported it had no fixture to try — a working install looking broken.
  const configurePage = require('../lib/configure-page');
  const base = {
    user: { id: 'u1', apiToken: 't1', config: {} },
    isAdmin: true, isFirstRun: true, step: 'install',
    installUrl: 'http://sss.local/m.json',
    promotions: [], selected: new Set(), selectAll: true, folderOf: {},
    collections: require('../lib/nuvio-collection-settings').defaults(),
    choosers: [], teamPromotions: [],
  };
  const empty = configurePage.render(Object.assign({}, base, { eventCount: 0 }));
  assert.match(empty, /Your catalogs are still filling/);
  assert.match(empty, /install the manifest now if you like/);

  const populated = configurePage.render(Object.assign({}, base, { eventCount: 1200 }));
  assert.ok(!/Your catalogs are still filling/.test(populated),
    'and it must disappear once there is something to serve');
});

test('the Configure route supplies the count the notice needs', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'addon.js'), 'utf8');
  assert.match(source, /eventCount: \(store\.loadFromDisk\(\)\.events \|\| \[\]\)\.length/);
});
