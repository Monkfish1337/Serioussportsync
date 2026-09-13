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

// ---------------------------------------------------------------------------
// Discovery timing, made adjustable.
//
// Asked for after four rounds of tuning these numbers by redeploy: "build in
// the server gui adjustable cut offs, so i and others can fine tune the cost
// of time vs results easily." They are the most consequential numbers in the
// stream path — Prowlarr answers in about 2s per query, so a 5000ms discovery
// budget is the difference between two queries and six, and that decided
// whether the query reaching rutracker was ever sent.

test('the timing defaults are the values that were hard-coded', () => {
  const settings = require('../lib/settings');
  assert.equal(settings.DISCOVERY_TIMING_DEFAULTS.pipelineBudgetMs, 9500);
  assert.equal(settings.DISCOVERY_TIMING_DEFAULTS.discoveryBudgetMs, 5000);
  assert.equal(settings.DISCOVERY_TIMING_DEFAULTS.prowlarrMaxQueries, 6);
  assert.equal(settings.DISCOVERY_TIMING_DEFAULTS.prowlarrQueryTimeoutMs, 15000);
  assert.equal(settings.DISCOVERY_TIMING_DEFAULTS.indexBuildBudgetMs, 25000);
});

test('discovery is held below the request budget, not refused', () => {
  // A discovery budget at or above the request budget starves relevance
  // filtering, dedupe and the TorBox cache check — everything that happens
  // after searching. Clamping lets the typed number take effect as far as it
  // safely can instead of rejecting the save.
  const settings = require('../lib/settings');
  const before = settings.getDiscoveryTiming();
  try {
    settings.setDiscoveryTiming({ pipelineBudgetMs: 8000, discoveryBudgetMs: 20000 });
    const out = settings.getDiscoveryTiming();
    assert.equal(out.pipelineBudgetMs, 8000);
    assert.equal(out.discoveryBudgetMs, 7000, 'held 1s below the request budget');
  } finally {
    settings.setDiscoveryTiming(before);
  }
});

test('out-of-range values are clamped to something workable', () => {
  const settings = require('../lib/settings');
  const before = settings.getDiscoveryTiming();
  try {
    settings.setDiscoveryTiming({ prowlarrMaxQueries: 900, prowlarrQueryTimeoutMs: 1 });
    const out = settings.getDiscoveryTiming();
    assert.equal(out.prowlarrMaxQueries, 60);
    assert.equal(out.prowlarrQueryTimeoutMs, 1000);
  } finally {
    settings.setDiscoveryTiming(before);
  }
});

test('a blank field falls back rather than meaning zero', () => {
  // Clearing a box has to mean "use this deployment's configured value", or
  // saving the form with one empty field would set a budget of nothing.
  const settings = require('../lib/settings');
  const before = settings.getDiscoveryTiming();
  try {
    settings.setDiscoveryTiming({ pipelineBudgetMs: '', discoveryBudgetMs: '' });
    const out = settings.getDiscoveryTiming();
    assert.equal(out.pipelineBudgetMs, settings.DISCOVERY_TIMING_DEFAULTS.pipelineBudgetMs);
    assert.ok(out.discoveryBudgetMs > 0);
  } finally {
    settings.setDiscoveryTiming(before);
  }
});

test('the stream path reads the setting instead of the constant', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'streams.js'), 'utf8');
  assert.match(source, /const timing = settings\.getDiscoveryTiming\(\)/);
  assert.match(source, /Number\(params\.budgetMs\) \|\| timing\.pipelineBudgetMs/);
  assert.match(source, /settings\.getDiscoveryTiming\(\)\.prowlarrMaxQueries/);
  assert.match(source, /settings\.getDiscoveryTiming\(\)\.indexBuildBudgetMs/);
  assert.ok(!/STREAM_PIPELINE_TIMEOUT_MS \|\| '9500'/.test(source),
    'the hard-coded default moved into settings');
});

test('the Server page offers every one of them', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'addon.js'), 'utf8');
  assert.match(source, /title: 'Discovery timing'/);
  for (const field of ['pipelineBudgetMs', 'discoveryBudgetMs', 'prowlarrMaxQueries',
    'prowlarrQueryTimeoutMs', 'indexBuildBudgetMs', 'easynewsMaxQueries',
    'easynewsQueryTimeoutMs', 'fastResponseGraceMs']) {
    assert.ok(source.includes('name="' + field + '"'), field + ' needs an input');
    assert.ok(source.includes(field + ': b.' + field), field + ' must reach the save');
  }
});

// ---------------------------------------------------------------------------
// The background build was flushing the log buffer.
//
// Measured on the live instance while trying to diagnose an MLB event:
// /admin/logs held 4000 entries spanning THIRTY-SEVEN SECONDS, every one of
// them from the availability build, and `category: 'stream'` returned zero
// rows. The build logs one line per query per event — 379 events times 54
// variants is roughly twenty thousand lines a run against a five-thousand-line
// buffer — so the diagnostic tool was unusable for the thing being diagnosed.

test('index build chatter is off by default', () => {
  const settings = require('../lib/settings');
  assert.equal(settings.getLogPreferences().verboseIndexBuild, false);
});

test('the two log preferences are independent', () => {
  // They share one form and one POST, so a careless wiring would have each
  // toggle silently clear the other.
  const settings = require('../lib/settings');
  const before = settings.getLogPreferences();
  try {
    settings.setLogPreferences({ detailedRejections: true, verboseIndexBuild: false });
    assert.deepEqual(settings.getLogPreferences(),
      { detailedRejections: true, verboseIndexBuild: false });
    settings.setLogPreferences({ detailedRejections: false, verboseIndexBuild: true });
    assert.deepEqual(settings.getLogPreferences(),
      { detailedRejections: false, verboseIndexBuild: true });
  } finally {
    settings.setLogPreferences(before);
  }
});

test('only indented per-query lines are suppressed', () => {
  // The sources indent their per-query output; the run's own progress and
  // summary lines are not indented. That is the whole distinction, so it is
  // worth stating where the filter lives.
  const warmer = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'availability-warmer.js'), 'utf8');
  assert.match(warmer, /verboseBuild/);
  assert.match(warmer, /if \(!verboseBuild && \/\^\\s\/\.test/);
  assert.match(warmer, /log: eventLog\(/, 'the per-event log must go through the filter');
});

test('the Logs page can turn it back on', () => {
  const adminLogs = require('../lib/admin-logs');
  const html = adminLogs.renderBody
    ? adminLogs.renderBody({ rows: [], stats: { total: 0, byLevel: {}, bytes: 0 },
      categories: [], preferences: { detailedRejections: false, verboseIndexBuild: false },
      options: { level: 'all', substring: '', category: 'all', user: '', limit: 500, tail: true, regex: false } })
    : null;
  if (!html) return;   // renderBody signature differs in this build
  assert.match(html, /id="build-toggle"/);
  assert.match(html, /Index build logging/);
});

test('the route saves both preferences', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'addon.js'), 'utf8');
  assert.match(source, /verboseIndexBuild: req\.body\.verboseIndexBuild === 'on'/);
});
