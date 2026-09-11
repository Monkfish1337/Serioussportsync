'use strict';

// The Collections step of Configure, and the Nuvio push panel on it.
//
// Every assertion here is a bug that shipped, so each one names what went
// wrong rather than restating the code.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.NUVIO_COLLECTIONS_FILE = path.join(os.tmpdir(), 'sss-collections-' + process.pid + '.json');
test.after(() => { try { fs.unlinkSync(process.env.NUVIO_COLLECTIONS_FILE); } catch (_) {} });

const configurePage = require('../lib/configure-page');
const nuvioAccount = require('../lib/nuvio-account');
const collectionSettings = require('../lib/nuvio-collection-settings');
const adminCollections = require('../lib/admin-nuvio-collections');

const PROMOTIONS = [
  { id: 'ufc', name: 'UFC', catalogs: [{ id: 'ufc-events' }] },
  { id: 'one', name: 'ONE Championship', catalogs: [{ id: 'one-events' }] },
  { id: 'boxing', name: 'Boxing', catalogs: [{ id: 'boxing-events' }] },
  { id: 'wwe', name: 'WWE', catalogs: [{ id: 'wwe-events' }] },
  // Deliberately in no default folder, so the "not grouped" notice has
  // something to report.
  { id: 'nfl', name: 'NFL', catalogs: [{ id: 'nfl-events' }] },
];

// The step's own markup, without the page shell or the client script — both of
// which legitimately contain a <form> and the selector strings this file
// asserts about.
function stepMarkup(html) {
  const start = html.indexOf('<section class="wrap step-panel" data-step="3"');
  const end = html.indexOf('<section class="wrap step-panel" data-step="4"');
  return html.slice(start, end === -1 ? undefined : end);
}

function renderStep(isAdmin) {
  return configurePage.render({
    user: { id: 'u1', apiToken: 't1', config: {} },
    isAdmin: isAdmin !== false,
    isFirstRun: false,
    step: 'collections',
    installUrl: 'http://sss.local/u/u1/t1/manifest.json',
    promotions: PROMOTIONS,
    selected: new Set(),
    selectAll: true,
    folderOf: {},
    collections: collectionSettings.defaults(),
    choosers: [],
    teamPromotions: [],
  });
}

test('the push mode is a control the user can actually operate', () => {
  // It was three radios inside `.sw` labels with no `<i>` element. That class
  // styles the `<i>` and hides the input outright:
  //   .sw input { position: absolute; opacity: 0; width: 0; height: 0 }
  // so Merge / Add only / Replace all were invisible AND unclickable, and
  // every push silently used whichever was `checked` in the HTML. Merge was
  // the only mode that could ever run.
  const panel = nuvioAccount.panel();
  assert.ok(!/type="radio"/.test(panel), 'the mode radios were unreachable; do not reintroduce them');
  assert.match(panel, /<select class="t" id="nuvio-mode">/);
  for (const mode of nuvioAccount.MODES) {
    assert.ok(panel.includes('value="' + mode.id + '"'), 'mode ' + mode.id + ' must be selectable');
  }
  // And the client must read that select rather than the old radio group.
  const client = nuvioAccount.clientScript('/account/nuvio-collections.json');
  assert.match(client, /el\('nuvio-mode'\)\.value/);
  assert.ok(!/nuvio-mode"\]:checked/.test(client));
});

test('Enter submits the Nuvio sign-in', () => {
  // The email and password inputs sit inside the Configure form, so Enter
  // either did nothing or submitted the whole five-step form and navigated
  // away from a half-finished sign-in.
  const client = nuvioAccount.clientScript('/account/nuvio-collections.json');
  assert.match(client, /keydown/);
  assert.match(client, /preventDefault/);
  assert.match(client, /nuvio-signin-btn'\)\.click\(\)/);
});

test('every mode detail reaches the browser, so the select can explain itself', () => {
  const client = nuvioAccount.clientScript('/account/nuvio-collections.json');
  for (const mode of nuvioAccount.MODES) {
    assert.ok(client.includes(mode.detail), 'detail for ' + mode.id + ' must be sent to the page');
  }
});

test('an admin can edit a folder from the step, not just its members', () => {
  // The step used to be a read-only list with one Save button. Renaming a
  // folder, changing its artwork or shape, creating one or deleting one all
  // meant leaving for /admin/nuvio-collections, which is the page this step is
  // supposed to be about.
  const html = renderStep(true);
  assert.match(html, /data-f="title"/);
  assert.match(html, /data-f="artworkChoice"/);
  assert.match(html, /data-f="tileShape"/);
  assert.match(html, /data-f="hideTitle"/);
  assert.match(html, /data-remove-folder=/);
  assert.match(html, /data-save-folder=""/, 'a New folder panel must exist');
  assert.match(html, /data-c="title"/, 'the collection title must be editable here');
  assert.match(html, /data-c="pinToTop"/);
});

test('folder controls are never named, or Configure would post them', () => {
  // These sit inside the Configure form. A `name` attribute means the value is
  // submitted to /account/save along with the account settings.
  const collections = stepMarkup(renderStep(true));
  assert.ok(!/class="folder-member"[^>]*name=/.test(collections));
  assert.ok(!/data-f="[a-zA-Z]+"[^>]*\sname=/.test(collections));
});

test('there is no nested form in the step', () => {
  // A form inside a form is not valid HTML: the browser closes the outer one
  // at the first </form>, which is how Save was detached from Configure once
  // already.
  assert.equal((stepMarkup(renderStep(true)).match(/<form/g) || []).length, 0);
});

test('a non-admin gets the push panel but no editor', () => {
  const markup = stepMarkup(renderStep(false));
  assert.match(markup, /Push to Nuvio/);
  assert.ok(!/data-save-folder/.test(markup), 'folders are shared, so only an admin edits them');
});

test('the member list is bounded so it cannot run out of its column', () => {
  // Unbounded, a 29-promotion list grew past its grid cell and rendered down
  // across the folders beside it.
  assert.match(stepMarkup(renderStep(true)), /max-height:260px;overflow:auto/);
});

test('the client sends hideTitle, and the store keeps it', () => {
  // The step never sent this field, and folderInput reads a missing checkbox
  // as false — so every save from Configure silently switched "hide the title
  // over the artwork" back off.
  const client = configurePage._test
    ? configurePage._test.clientScript()
    : String(configurePage.render).length && renderStep(true);
  assert.ok(String(client).includes("body.append('hideTitle', '1')"));

  const state = collectionSettings.save(collectionSettings.defaults());
  const folder = state.folders[0];
  const valid = new Set(PROMOTIONS.map((p) => p.id));
  const saved = collectionSettings.upsertFolder(folder.id, adminCollections.folderInput({
    title: folder.title,
    artworkChoice: folder.artwork,
    tileShape: folder.tileShape,
    promotions: ['ufc', 'one'],
    hideTitle: '1',
  }), valid);
  assert.equal(saved.folders[0].hideTitle, true);
});

test('a folder holding a promotion that no longer exists says so', () => {
  // The live instance showed a folder chip reading "1" above the words
  // "Empty — not exported": the count included an id whose promotion had gone,
  // and the name list did not. Two numbers for the same folder, neither
  // explained.
  const collections = collectionSettings.defaults();
  collections.folders = [{
    id: 'f1', title: 'Football', promotions: ['ufc', 'gone-promotion'],
    artwork: '/assets/logo-banner.png', tileShape: 'landscape', hideTitle: false,
  }];
  const html = configurePage.render({
    user: { id: 'u1', apiToken: 't1', config: {} },
    isAdmin: true, isFirstRun: false, step: 'collections',
    installUrl: 'http://sss.local/m.json',
    promotions: PROMOTIONS, selected: new Set(), selectAll: true,
    folderOf: {}, collections, choosers: [], teamPromotions: [],
  });
  assert.match(html, /1 no longer available/);
});

test('catalogs in no folder are named, not just counted', () => {
  const markup = stepMarkup(renderStep(true));
  assert.match(markup, /1 catalog in no folder/);
  assert.match(markup, /NFL/);
});

// The standalone admin Collections page, which the Configure step links to and
// which still renders every folder as a card.
test('the folder artwork box is sized by one rule, not two that fight', () => {
  // `ratio` sizes a box from its aspect ratio using a padding-top pseudo
  // element; `h-100` forced height:100% on the same element. Inside `row g-0`
  // the column is a stretched flex item, so the two rules disagreed about the
  // height and the artwork stretched or collapsed depending on how much text
  // the card carried beside it.
  const adminCollectionsPage = require('../lib/admin-nuvio-collections');
  const html = adminCollectionsPage.renderBody({});
  assert.ok(!/ratio ratio-16x9 h-100/.test(html), 'ratio and h-100 must not both size the box');
  assert.match(html, /ratio ratio-16x9/);
});

test('a long promotion list does not wrap inside the disclosure summary', () => {
  // A <summary> indents every line after the first under the marker, so a long
  // comma list rendered as a ragged block. The count stays in the summary; the
  // names moved to a line of their own beneath it.
  const adminCollectionsPage = require('../lib/admin-nuvio-collections');
  const html = adminCollectionsPage.renderBody({});
  assert.match(html, /Included promotions \(\d+\)<\/summary>/);
});
