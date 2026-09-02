'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

const originalFile = config.metadataSourcesFile;
const originalCustomFile = config.customPromotionsFile;
const testFile = path.join(os.tmpdir(), 'sss-metadata-sources-' + process.pid + '.json');
const testCustomFile = path.join(os.tmpdir(), 'sss-wizard-promotions-' + process.pid + '.json');
config.metadataSourcesFile = testFile;
config.customPromotionsFile = testCustomFile;
const sources = require('../lib/metadata-sources');
const promotions = require('../lib/promotions');
const chrome = require('../lib/tabler-chrome');
const adminMetadata = require('../lib/admin-metadata');
const metadataPreview = require('../lib/metadata-preview');
const mlb = require('../lib/sources/mlb');
const jsonFeed = require('../lib/sources/json-feed');
const adminPromotions = require('../lib/admin-promotions');
const { setFreshStreamHeaders } = require('../addon');

test.after(() => {
  config.metadataSourcesFile = originalFile;
  config.customPromotionsFile = originalCustomFile;
  try { fs.unlinkSync(testFile); } catch (_) {}
  try { fs.unlinkSync(testCustomFile); } catch (_) {}
});

test('seeds all current built-in metadata source assignments', () => {
  assert.equal(sources.list().length, 10);
  assert.deepEqual(sources.resolve('one', {}).source, { type: 'onefc' });
  assert.deepEqual(sources.resolve('f1', {}).source, { type: 'thesportsdb', leagueId: '4370' });
  assert.deepEqual(sources.resolve('ucl', {}).source, { type: 'api-football', leagueId: '2' });
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

test('preserves a pre-existing custom ucl promotion over the new shipped default', () => {
  const customPromotions = require('../lib/custom-promotions');
  customPromotions.add({
    id: 'ucl', name: 'My Champions League', idPrefix: 'ucl',
    source: 'football-data', competitionId: 'CL', posterShape: 'landscape',
    searchTitleTemplates: ['{name}'], relevanceKeywords: ['ucl'],
  }, new Set(promotions.all.filter((item) => item.id !== 'ucl').map((item) => item.id)));
  try {
    promotions.reload();
    const preserved = promotions.all.find((item) => item.id === 'ucl');
    assert.equal(preserved.isCustom, true);
    assert.deepEqual(preserved.source, { type: 'football-data', competitionId: 'CL' });
  } finally {
    customPromotions.remove('ucl');
    promotions.reload();
  }
  const shipped = promotions.all.find((item) => item.id === 'ucl');
  assert.equal(shipped.isCustom, false);
  assert.deepEqual(shipped.source, { type: 'api-football', leagueId: '2' });
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

test('wizard accepts provider IDs and recognises supported official websites', () => {
  const provider = adminPromotions.wizardSourceDefinition({
    sourceMode: 'provider', id: 'wizard-nfl', name: 'NFL',
    sourceType: 'thesportsdb', leagueId: '4391',
  });
  assert.equal(provider.ok, true);
  assert.deepEqual(provider.definition.source, { type: 'thesportsdb', leagueId: '4391' });
  assert.equal(provider.definition.id, 'wizard-nfl-schedule');

  assert.deepEqual(adminPromotions.websiteSource('https://watch.onefc.com/upcoming-events'), {
    ok: true, type: 'onefc', detected: 'ONE Championship official schedule',
  });
  assert.deepEqual(adminPromotions.websiteSource('https://www.mlb.com/schedule'), {
    ok: true, type: 'mlb', detected: 'MLB official schedule',
  });
  assert.match(adminPromotions.websiteSource('https://example.com/events').error, /does not yet have a schedule adapter/);
});

test('wizard creates and assigns a reusable source in the same save', () => {
  const saved = adminPromotions.saveFromForm({
    sourceMode: 'provider', id: 'wizard-league', name: 'Wizard League',
    sourceType: 'thesportsdb', leagueId: '9876', posterShape: 'landscape',
    searchTitleTemplates: '{name}\n{name} {year}',
  });
  assert.equal(saved.sourceRef, 'wizard-league-schedule');
  assert.deepEqual(sources.find(saved.sourceRef).source, { type: 'thesportsdb', leagueId: '9876' });
  assert.equal(sources.assignmentFor('wizard-league'), saved.sourceRef);
  assert.ok(promotions.all.some((promotion) => promotion.id === 'wizard-league'));
});

test('wizard rolls back a newly created source when promotion validation fails', () => {
  assert.throws(() => adminPromotions.saveFromForm({
    sourceMode: 'provider', id: 'x', name: 'Broken', sourceType: 'onefc',
    searchTitleTemplates: '{name}', posterShape: 'landscape',
  }), /id must/);
  assert.equal(sources.find('x-schedule'), null);
});

test('creates a no-key MLB source and exposes Metadata navigation', () => {
  const created = sources.add({ id: 'mlb-official', name: 'Official MLB schedule', type: 'mlb' });
  assert.deepEqual(created.source, { type: 'mlb' });
  assert.ok(chrome.ADMIN_SECTIONS.some((item) => item.id === 'metadata'));
  const html = adminMetadata.renderBody({});
  assert.match(html, /MLB official schedule/);
  assert.match(html, /Provider creator/);
  assert.match(html, /Custom JSON\/API schedule/);
  assert.match(html, /API-Football competition/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script[1])); // eslint-disable-line no-new-func
});

test('creates and previews an API-Football competition source', async () => {
  const created = sources.add({
    id: 'api-football-epl', name: 'API-Football · Premier League',
    type: 'api-football', apiFootballLeagueId: '39',
  });
  assert.deepEqual(created.source, { type: 'api-football', leagueId: '39' });
  const result = await metadataPreview.preview(created, {
    now: new Date('2026-09-02T12:00:00Z'),
    credentials: { apiFootballApiKey: 'test-key' },
    adapters: { apiFootball: {
      lookupLeague: async () => ({ league: { id: 39, name: 'Premier League' } }),
      seasonsForRange: () => ['2026'],
      fetchAll: async (input) => {
        assert.equal(input.leagueId, '39');
        assert.deepEqual(input.seasons, ['2026']);
        return [{
          fixture: { id: 123, date: '2026-09-05T15:00:00+00:00', venue: { name: 'Stadium', city: 'London' } },
          league: { id: 39, name: 'Premier League', country: 'England', season: 2026, round: 'Regular Season - 4', logo: 'https://img/league.png' },
          teams: { home: { id: 1, name: 'Arsenal', logo: 'https://img/arsenal.png' }, away: { id: 2, name: 'Liverpool', logo: 'https://img/liverpool.png' } },
        }];
      },
    } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.events[0].name, 'Arsenal vs Liverpool');
  assert.equal(result.events[0].date, '2026-09-05');
});

test('creates and maps a user-defined JSON API provider without executing code', async () => {
  const created = sources.add({
    id: 'custom-fights', name: 'Custom fight schedule', type: 'json-feed',
    url: 'https://events.example/api/schedule', arrayPath: 'payload.events',
    idField: 'event.id', nameField: 'event.title', dateField: 'starts.at',
    venueField: 'location.name', posterField: 'images.poster',
  });
  assert.equal(created.source.type, 'json-feed');
  const mapped = jsonFeed.mapEvents({ payload: { events: [{
    event: { id: 167, title: 'ONE Friday Fights 167' },
    starts: { at: '2026-08-28T12:30:00Z' }, location: { name: 'Lumpinee Stadium' },
    images: { poster: 'https://img.example/167.jpg' },
  }] } }, created.source);
  assert.deepEqual(mapped[0], {
    sourceId: '167', name: 'ONE Friday Fights 167', date: '2026-08-28', time: '12:30:00',
    venue: 'Lumpinee Stadium', description: null, poster: 'https://img.example/167.jpg',
    source: { type: 'json-feed', sourceId: '167' },
  });

  const preview = await metadataPreview.preview(created, {
    adapters: { jsonFeed: { fetchAll: async () => mapped } },
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.events[0].name, 'ONE Friday Fights 167');
});

test('custom provider validation blocks cloud metadata URLs and executable paths', () => {
  assert.throws(() => sources.add({
    id: 'cloud-feed', name: 'Cloud feed', type: 'json-feed',
    url: 'http://169.254.169.254/latest', nameField: 'name', dateField: 'date',
  }), /cloud metadata/);
  assert.throws(() => sources.add({
    id: 'code-feed', name: 'Code feed', type: 'json-feed',
    url: 'https://events.example/api', nameField: 'constructor.constructor()', dateField: 'date',
  }), /dotted field path/);
});

test('stream refresh headers always rotate to prevent a bodyless 304', () => {
  const first = {}, second = {};
  setFreshStreamHeaders({ setHeader: (key, value) => { first[key] = value; } });
  setFreshStreamHeaders({ setHeader: (key, value) => { second[key] = value; } });
  assert.match(first.ETag, /^"sss-stream-/);
  assert.notEqual(first.ETag, second.ETag);
  assert.equal(first.Pragma, 'no-cache');
  assert.equal(first.Expires, '0');
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

test('metadata page exposes provider creation plus draft and saved-source preview controls', () => {
  const html = adminMetadata.renderBody({});
  assert.match(html, /metadata-sources\/preview/);
  assert.match(html, /Test provider &amp; show events/);
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
