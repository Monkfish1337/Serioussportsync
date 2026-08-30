'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

const originalFile = config.metadataSourcesFile;
const testFile = path.join(os.tmpdir(), 'sss-metadata-sources-' + process.pid + '.json');
config.metadataSourcesFile = testFile;
const sources = require('../lib/metadata-sources');
const promotions = require('../lib/promotions');
const chrome = require('../lib/tabler-chrome');
const adminMetadata = require('../lib/admin-metadata');
const metadataPreview = require('../lib/metadata-preview');
const mlb = require('../lib/sources/mlb');

test.after(() => {
  config.metadataSourcesFile = originalFile;
  try { fs.unlinkSync(testFile); } catch (_) {}
});

test('seeds all current built-in metadata source assignments', () => {
  assert.equal(sources.list().length, 9);
  assert.deepEqual(sources.resolve('one', {}).source, { type: 'onefc' });
  assert.deepEqual(sources.resolve('f1', {}).source, { type: 'thesportsdb', leagueId: '4370' });
});

test('creates a reusable source and assigns it to a promotion', () => {
  const created = sources.add({
    id: 'tsdb-nfl', name: 'TheSportsDB · NFL', type: 'thesportsdb', leagueId: '4391',
  });
  assert.equal(created.source.leagueId, '4391');
  sources.assign('f1', created.id);
  assert.equal(sources.assignmentFor('f1'), 'tsdb-nfl');
  assert.deepEqual(sources.resolve('f1', {}).source, { type: 'thesportsdb', leagueId: '4391' });
  promotions.reload();
  assert.deepEqual(promotions.all.find((p) => p.id === 'f1').source, { type: 'thesportsdb', leagueId: '4391' });
  sources.assign('f1', '');
  promotions.reload();
  assert.equal(sources.assignmentFor('f1'), 'tsdb-f1');
});

test('retired expert tools are absent from the admin sidebar', () => {
  const labels = chrome.ADMIN_SECTIONS.map((item) => item.label);
  assert.ok(labels.includes('Promotions'));
  assert.ok(labels.includes('Database'));
  assert.ok(!labels.includes('Health'));
  for (const retired of ['Power Tool', 'Search', 'Match Editor', 'Content Studio']) {
    assert.ok(!labels.includes(retired));
  }
});

test('account identity and POST-only logout live in the sidebar, not the topbar', () => {
  const user = { username: 'tester', role: 'admin' };
  const sidebar = chrome.buildSidebar('account', user, true);
  const topbar = chrome.buildTopbar(user, true);
  assert.match(sidebar, /href="\/account"/);
  assert.match(sidebar, /aria-label="Profile"/);
  assert.match(sidebar, /method="POST" action="\/logout"/);
  assert.match(sidebar, />Log out</);
  assert.doesNotMatch(topbar, /tester|\/account|\/logout/);

  const userSidebar = chrome.buildSidebar('account', { username: 'viewer', role: 'user' }, false);
  assert.match(userSidebar, />Account</);
  assert.doesNotMatch(userSidebar, />Admin</);
});

test('retired expert UI modules have been deleted while data layers remain', () => {
  for (const file of ['power-tool.js', 'admin-general-search.js', 'admin-match-editor.js', 'admin-content-studio.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'lib', file)), false, file + ' remains deleted');
  }
  for (const file of ['content-store.js', 'match-overrides.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'lib', file)), true, file + ' remains available');
  }
});

test('rejects incomplete or duplicate source definitions', () => {
  assert.throws(() => sources.add({ id: 'bad-source', name: 'Bad', type: 'tmdb', tvIds: 'abc' }), /numeric/);
  assert.throws(() => sources.add({ id: 'tsdb-nfl', name: 'Duplicate', type: 'onefc' }), /already exists/);
});

test('creates a no-key MLB source and exposes Metadata navigation', () => {
  const created = sources.add({ id: 'mlb-official', name: 'Official MLB schedule', type: 'mlb' });
  assert.deepEqual(created.source, { type: 'mlb' });
  assert.ok(chrome.ADMIN_SECTIONS.some((item) => item.id === 'metadata'));
  const html = adminMetadata.renderBody({});
  assert.match(html, /MLB official schedule/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script[1])); // eslint-disable-line no-new-func
});

test('normalizes an official MLB fixture into a generic event record', () => {
  const raw = mlb.toRaw({
    gamePk: 825039,
    officialDate: '2026-08-26',
    gameDate: '2026-08-26T20:10:00Z',
    teams: { away: { team: { name: 'Chicago Cubs' } }, home: { team: { name: 'Arizona Diamondbacks' } } },
    venue: { name: 'Chase Field' },
    status: { detailedState: 'Scheduled' },
  });
  assert.equal(raw.name, 'Chicago Cubs vs Arizona Diamondbacks');
  assert.equal(raw.source.type, 'mlb');
  assert.equal(raw.source.gamePk, '825039');
});

test('previews normalized source events without saving or assigning them', async () => {
  const before = fs.readFileSync(testFile, 'utf8');
  const result = await metadataPreview.preview({
    id: 'preview-mlb', name: 'MLB Preview', source: { type: 'mlb' },
  }, {
    now: new Date('2026-08-27T12:00:00Z'),
    adapters: {
      mlb: { fetchAll: async ({ dateFrom, dateTo }) => {
        assert.equal(dateFrom, '2026-08-20');
        assert.equal(dateTo, '2026-09-17');
        return [mlb.toRaw({
          gamePk: 825039, officialDate: '2026-08-26', gameDate: '2026-08-26T20:10:00Z',
          teams: { away: { team: { name: 'Chicago Cubs' } }, home: { team: { name: 'Arizona Diamondbacks' } } },
          venue: { name: 'Chase Field' }, status: { detailedState: 'Final' },
        })];
      } },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.normalized, 1);
  assert.deepEqual(result.events[0], {
    name: 'Chicago Cubs vs Arizona Diamondbacks', date: '2026-08-26', time: '20:10:00',
    venue: 'Chase Field', sourceId: '825039', hasArtwork: false,
  });
  assert.equal(fs.readFileSync(testFile, 'utf8'), before);
});

test('metadata page exposes draft and saved-source preview controls', () => {
  const html = adminMetadata.renderBody({});
  assert.match(html, /metadata-sources\/preview/);
  assert.match(html, /Test &amp; preview/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script[1])); // eslint-disable-line no-new-func
});

test('metadata preview errors redact provider credentials', () => {
  const safe = adminMetadata.safeError(new Error(
    'request to https://www.thesportsdb.com/api/v1/json/premium-secret/lookupleague.php?id=1&apikey=also-secret failed'
  ));
  assert.doesNotMatch(safe, /premium-secret|also-secret/);
  assert.match(safe, /\[redacted\]/);
});
