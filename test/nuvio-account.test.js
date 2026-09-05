'use strict';

// Pushing collections into a Nuvio account.
//
// Both of Nuvio's push RPCs are a FULL REPLACE of the list they are given.
// Sending only the SeriousSportSync collection deletes every other collection
// on the profile; sending only this addon deletes every other addon. So the
// merges below are the whole safety story, and they are what these tests are
// about — everything else is a fetch call.

const test = require('node:test');
const assert = require('node:assert/strict');
const nuvio = require('../lib/nuvio-account');

const SSS = { id: 'sss-collection', title: 'SeriousSportSync', folders: [{ id: 'f1' }] };
const SSS_UPDATED = { id: 'sss-collection', title: 'SeriousSportSync', folders: [{ id: 'f1' }, { id: 'f2' }] };
const THEIRS_A = { id: 'hand-made-1', title: 'My anime' };
const THEIRS_B = { id: 'hand-made-2', title: 'Documentaries' };

test('merge updates our collection and never touches theirs', () => {
  const result = nuvio.mergeCollections([THEIRS_A, SSS, THEIRS_B], [SSS_UPDATED], 'merge');
  assert.equal(result.next.length, 3, 'nothing may be dropped');
  assert.deepEqual(result.next.map((c) => c.id), ['hand-made-1', 'sss-collection', 'hand-made-2'],
    'order is the profile owner\'s, not ours');
  assert.equal(result.next[1].folders.length, 2, 'ours is the updated copy');
  assert.deepEqual(result.next[0], THEIRS_A);
  assert.equal(result.updated, 1);
  assert.equal(result.added, 0);
});

test('merge appends when the profile has never seen us', () => {
  const result = nuvio.mergeCollections([THEIRS_A], [SSS], 'merge');
  assert.deepEqual(result.next.map((c) => c.id), ['hand-made-1', 'sss-collection']);
  assert.equal(result.added, 1);
  assert.equal(result.updated, 0);
});

test('add only adds — an existing collection keeps edits made in Nuvio', () => {
  const editedInNuvio = { id: 'sss-collection', title: 'Renamed by hand', folders: [] };
  const result = nuvio.mergeCollections([editedInNuvio], [SSS_UPDATED], 'add');
  assert.equal(result.next.length, 1);
  assert.deepEqual(result.next[0], editedInNuvio, 'add must not overwrite');
  assert.equal(result.updated, 0);
  assert.equal(result.added, 0);
});

test('replace really does drop everything else', () => {
  // This is the destructive one, which is why the UI puts a typed confirmation
  // in front of it. The function itself must not soften the behaviour — a
  // "replace" that quietly kept things would be worse than either.
  const result = nuvio.mergeCollections([THEIRS_A, THEIRS_B], [SSS], 'replace');
  assert.deepEqual(result.next, [SSS]);
  assert.equal(result.added, 1);
});

test('an empty or missing profile list is not a reason to lose data', () => {
  assert.deepEqual(nuvio.mergeCollections(null, [SSS], 'merge').next, [SSS]);
  assert.deepEqual(nuvio.mergeCollections(undefined, [SSS], 'merge').next, [SSS]);
  assert.deepEqual(nuvio.mergeCollections([THEIRS_A], null, 'merge').next, [THEIRS_A],
    'a failed export must leave the profile alone, not blank it');
  assert.deepEqual(nuvio.mergeCollections([THEIRS_A], [], 'merge').next, [THEIRS_A]);
});

// ---------------------------------------------------------------- addons

const MANIFEST = 'https://sss.example.com/u/abc/def/manifest.json';

test('installing the addon preserves every addon already on the profile', () => {
  const existing = [
    { url: 'https://other.example/manifest.json', name: 'Other', enabled: true, sort_order: 0 },
    { url: 'https://third.example/manifest.json', name: 'Third', enabled: false, sort_order: 1 },
  ];
  const result = nuvio.mergeAddons(existing, MANIFEST, 'SeriousSportSync');
  assert.equal(result.alreadyInstalled, false);
  assert.equal(result.next.length, 3);
  assert.equal(result.next[0].url, 'https://other.example/manifest.json');
  assert.equal(result.next[1].enabled, false, 'a disabled addon stays disabled');
  assert.equal(result.next[2].url, MANIFEST);
  assert.equal(result.next[2].sort_order, 2, 'ours goes last rather than reordering theirs');
});

test('installing twice does not duplicate, and re-enables a switched-off copy', () => {
  const existing = [{ url: MANIFEST, name: 'SeriousSportSync', enabled: false, sort_order: 3 }];
  const result = nuvio.mergeAddons(existing, MANIFEST, 'SeriousSportSync');
  assert.equal(result.alreadyInstalled, true);
  assert.equal(result.next.length, 1);
  assert.equal(result.next[0].enabled, true);
  assert.equal(result.next[0].sort_order, 3, 'the profile owner\'s ordering is left alone');
});

test('addon rows with no url are dropped rather than pushed back malformed', () => {
  const result = nuvio.mergeAddons([{ name: 'broken' }, null], MANIFEST, 'SeriousSportSync');
  assert.equal(result.next.length, 1);
  assert.equal(result.next[0].url, MANIFEST);
});

// ---------------------------------------------------- credentials stay put

test('nothing in the shipped code sends a credential to this server', () => {
  const script = nuvio.clientScript('/account/nuvio-collections.json') + nuvio.mergeScript();

  // The password is read from the field and handed to Nuvio's token endpoint,
  // and to nothing else. If a future edit posted it to an SSS route, the only
  // way that shows up is here.
  assert.match(script, /auth\/v1\/token\?grant_type=password/);
  assert.match(script, /nuvio-password/);
  const sends = script.match(/fetch\([^)]*/g) || [];
  for (const call of sends) {
    assert.ok(/api|exportUrl/.test(call),
      'every request must go to Nuvio or to the export URL: ' + call);
  }

  // The token must not be persisted. Web storage is readable by anything that
  // ever runs script on this origin, and a token in a backup is a credential
  // in a backup.
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie/,
    'the access token must live in a variable and nowhere else');

  // The password field is cleared once it has been exchanged.
  assert.match(script, /nuvio-password'\)\.value = ''/);
});

test('replace is gated behind a typed confirmation, not a click', () => {
  const script = nuvio.clientScript('/x');
  const at = script.indexOf("mode === 'replace'");
  assert.ok(at > -1);
  assert.match(script.slice(at, at + 600), /prompt\(/,
    'an unrecoverable action needs more friction than confirm()');
  assert.match(script.slice(at, at + 600), /REPLACE/);
});

test('the panel adds no form, because it lives inside the Configure form', () => {
  // A form inside a form is closed by the browser at the first </form>, which
  // detaches everything after it. That has cost this project one shipped bug.
  assert.doesNotMatch(nuvio.panel(), /<form/);
  assert.match(nuvio.panel(), /type="password"/);
  assert.match(nuvio.panel(), /autocomplete="current-password"/,
    'password managers should be able to fill this');
});

test('the three push modes are offered and merge is the default', () => {
  assert.deepEqual(nuvio.MODES.map((m) => m.id), ['merge', 'add', 'replace']);
  assert.match(nuvio.panel(), /value="merge"[^>]*checked/);
});
