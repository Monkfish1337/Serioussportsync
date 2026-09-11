'use strict';

// Three small things on the Server page and the Event Editor, each of which
// made the interface disagree with itself.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const file = path.join(os.tmpdir(), 'sss-server-page-' + process.pid + '.json');
process.env.SETTINGS_FILE = file;
process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'server-page-test-session-secret-0123456789abcdef';
test.after(() => { try { fs.unlinkSync(file); } catch (_) {} });

const settings = require('../lib/settings');
const eventEditor = require('../lib/event-editor');

test('the TMDB key can be saved from the interface', () => {
  // Match of the Day was the one shipped promotion with no field anywhere: it
  // needs a TMDB key, the Server page offered football-data.org and
  // API-Football only, and an install without the environment variable showed
  // no events with the cure undiscoverable.
  settings.setTmdb({ apiKey: 'tmdb-test-key' });
  assert.equal(settings.getTmdb().apiKey, 'tmdb-test-key');
});

test('an admin-saved TMDB key overrides the environment, like the others', () => {
  // The two existing keys work this way. A field that saved a value the
  // refresh never read would be worse than no field.
  const refreshSource = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'refresh.js'), 'utf8');
  const tmdbBlock = refreshSource.slice(refreshSource.indexOf("=== 'tmdb'"));
  const assignment = tmdbBlock.slice(0, tmdbBlock.indexOf('\n\n'));
  assert.match(assignment, /getTmdb\(\)\.apiKey/);
  assert.ok(
    assignment.indexOf('getTmdb().apiKey') < assignment.indexOf('TMDB_API_KEY'),
    'the saved key must be consulted before the environment variable');
});

test('the Event Editor does not print the same two words twice', () => {
  // Every untouched row read:
  //   Source date
  //   Source date
  //   2027-03-07
  // The chip says whether the event has been touched; the field says what the
  // source gave. They are different facts and had identical labels.
  const html = eventEditor.renderBody({
    events: [{ id: 'ufc:1', name: 'UFC 300', date: '2026-04-13', promotion: 'ufc' }],
    overrides: {},
    promotions: [{ id: 'ufc', name: 'UFC' }],
    query: {},
  });
  assert.match(html, /Unchanged/);
  assert.equal((html.match(/Source date/g) || []).length, 1,
    'the words may appear once, as the label of the date they describe');
});

test('an overridden event says so on the chip', () => {
  const html = eventEditor.renderBody({
    events: [{ id: 'ufc:1', name: 'UFC 300', date: '2026-04-13', promotion: 'ufc' }],
    overrides: { 'ufc:1': { date: '2026-04-14' } },
    promotions: [{ id: 'ufc', name: 'UFC' }],
    query: {},
  });
  assert.match(html, /Overridden/);
});
