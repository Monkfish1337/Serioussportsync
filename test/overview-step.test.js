'use strict';

// The Overview: the first page of Configure, explaining how SeriousSportSync
// works and the Refresh press that runs a live search.

const test = require('node:test');
const assert = require('node:assert/strict');
const configurePage = require('../lib/configure-page');
const collectionSettings = require('../lib/nuvio-collection-settings');

function render(extra) {
  return configurePage.render(Object.assign({
    user: { id: 'u1', apiToken: 't1', config: {} },
    isAdmin: false, isFirstRun: true, step: 'overview',
    installUrl: 'http://sss.local/u/u1/t1/manifest.json',
    promotions: [], selected: new Set(), selectAll: true, folderOf: {},
    collections: collectionSettings.defaults(), choosers: [], teamPromotions: [],
  }, extra || {}));
}
const panel = (html, n) => {
  const start = html.indexOf('<section class="wrap step-panel" data-step="' + n + '"');
  return html.slice(start, html.indexOf('</section>', start));
};

test('the Overview is the first step and explains the Refresh live search', () => {
  assert.equal(configurePage.STEPS[0].id, 'overview');
  assert.equal(configurePage.STEPS[1].id, 'services');
  const html = render({ liveRefreshSeconds: 30 });
  const overview = panel(html, 0);
  assert.match(overview, /How SeriousSportSync works/);
  assert.match(overview, /Press Refresh/);
  assert.match(overview, /within 30 seconds/);
  assert.match(overview, /including Prowlarr for leagues it normally prepares in the background/);
  assert.doesNotMatch(overview, /<input|<select|<textarea/, 'it has no settings, so it posts nothing');
  assert.doesNotMatch(overview, /\bhidden\b/, 'shown when it is the chosen step');
});

test('the Refresh note follows the configured window and disappears when it is off', () => {
  assert.match(panel(render({ liveRefreshSeconds: 45 }), 0), /within 45 seconds/);
  assert.doesNotMatch(panel(render({ liveRefreshSeconds: 0 }), 0), /Press Refresh/);
});
