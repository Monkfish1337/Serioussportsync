'use strict';

// ESPN scoreboard adapter.
//
// The fixtures below are real responses captured from
// site.api.espn.com, trimmed to the fields the adapter reads. Using real
// payloads matters here because the endpoint is undocumented: a hand-written
// sample would encode assumptions rather than observations.

const test = require('node:test');
const assert = require('node:assert/strict');
const espn = require('../lib/sources/espn');
const promotions = require('../lib/promotions');
const transform = require('../lib/transform');

const NFL_SCOREBOARD = {
  events: [{
    id: '401872657',
    date: '2026-09-11T00:35Z',
    name: 'San Francisco 49ers at Los Angeles Rams',
    shortName: 'SF VS LAR',
    status: { type: { name: 'STATUS_SCHEDULED', shortDetail: '9/10 - 8:35 PM EDT' } },
    competitions: [{
      id: '401872657',
      venue: { fullName: 'Melbourne Cricket Ground', address: { city: 'Melbourne', country: 'Australia' } },
      competitors: [
        { homeAway: 'home', team: { id: '14', displayName: 'Los Angeles Rams', location: 'Los Angeles', name: 'Rams', abbreviation: 'LAR', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/lar.png' } },
        { homeAway: 'away', team: { id: '25', displayName: 'San Francisco 49ers', location: 'San Francisco', name: '49ers', abbreviation: 'SF', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/sf.png' } },
      ],
    }],
  }],
};

const NBA_SCOREBOARD = {
  events: [{
    id: '401909861',
    date: '2026-10-25T21:00Z',
    name: 'Los Angeles Lakers at Utah Jazz',
    shortName: 'LAL @ UTAH',
    status: { type: { name: 'STATUS_SCHEDULED' } },
    competitions: [{
      id: '401909861',
      venue: { fullName: 'Delta Center', address: { city: 'Salt Lake City' } },
      competitors: [
        { homeAway: 'home', team: { id: '26', displayName: 'Utah Jazz', location: 'Utah', name: 'Jazz', abbreviation: 'UTAH', logo: 'https://a.espncdn.com/i/teamlogos/nba/500/scoreboard/utah.png' } },
        { homeAway: 'away', team: { id: '13', displayName: 'Los Angeles Lakers', location: 'Los Angeles', name: 'Lakers', abbreviation: 'LAL', logo: 'https://a.espncdn.com/i/teamlogos/nba/500/scoreboard/lal.png' } },
      ],
    }],
  }],
};

test('normalises a scoreboard fixture to the shared raw record shape', () => {
  const [raw] = espn.parseScoreboard(NFL_SCOREBOARD, 'nfl');
  assert.equal(raw.sourceId, '401872657');
  // "Away at Home" — the convention MLB already produces and the promotion
  // matchers already split on.
  assert.equal(raw.name, 'San Francisco 49ers at Los Angeles Rams');
  assert.equal(raw.date, '2026-09-11');
  assert.equal(raw.time, '00:35:00');
  assert.equal(raw.venue, 'Melbourne Cricket Ground');
  assert.equal(raw.city, 'Melbourne');
  // The venue's own country wins over the league default: this fixture is
  // played in Australia.
  assert.equal(raw.country, 'Australia');
  assert.match(raw.poster, /^https:\/\/a\.espncdn\.com\//);
  assert.equal(raw.source.type, 'espn');
  assert.equal(raw.source.league, 'nfl');
});

test('carries every naming form a matcher might need', () => {
  const [raw] = espn.parseScoreboard(NBA_SCOREBOARD, 'nba');
  assert.deepEqual(raw.teamNames.home, ['Utah Jazz', 'Utah', 'Jazz', 'UTAH']);
  assert.deepEqual(raw.teamNames.away, ['Los Angeles Lakers', 'Los Angeles', 'Lakers', 'LAL']);
});

test('drops a fixture it cannot describe rather than throwing', () => {
  // An undocumented endpoint can change shape without warning. A broken record
  // must degrade the catalog, never fail the whole refresh.
  assert.deepEqual(espn.parseScoreboard({ events: [{ id: '1' }] }, 'nfl'), []);
  assert.deepEqual(espn.parseScoreboard({ events: [{ id: '2', competitions: [{ competitors: [] }] }] }, 'nfl'), []);
  assert.deepEqual(espn.parseScoreboard({ events: [{
    id: '3', date: 'not-a-date',
    competitions: [{ competitors: [
      { homeAway: 'home', team: { displayName: 'A' } },
      { homeAway: 'away', team: { displayName: 'B' } },
    ] }],
  }] }, 'nfl'), []);
  assert.deepEqual(espn.parseScoreboard(null, 'nfl'), []);
  assert.deepEqual(espn.parseScoreboard({}, 'nfl'), []);
});

test('refuses a league it has no path for', async () => {
  await assert.rejects(() => espn.fetchAll({ league: 'quidditch', dateFrom: '2026-01-01', dateTo: '2026-01-02' }),
    /unsupported league/);
  await assert.rejects(() => espn.fetchAll({ league: 'nfl', dateFrom: 'yesterday', dateTo: '2026-01-02' }),
    /YYYY-MM-DD/);
});

test('becomes an NFL event the promotion can search for', () => {
  const [raw] = espn.parseScoreboard(NFL_SCOREBOARD, 'nfl');
  const promotion = promotions.byPrefix.nfl;
  const event = transform.fromWiki(raw, promotion);
  assert.equal(event.id, 'nfl:401872657');
  assert.equal(event.promotion, 'nfl');
  assert.equal(event.date, '2026-09-11');
  // Structured names survive the transform, so the Sport-Video team filter and
  // team-aware matching do not have to split the title.
  assert.equal(event.teamNames.home[0], 'Los Angeles Rams');

  const titles = promotion.searchTitles(event);
  assert.ok(titles.length > 0, 'expected generated search titles');
  assert.ok(titles.some((title) => /NFL/.test(title)), 'a query should carry the league');
  assert.ok(titles.some((title) => /11\.09\.2026|2026\.09\.11/.test(title)),
    'a query should carry the fixture date, got: ' + titles.slice(0, 3).join(' | '));
});

test('matches a real release name and rejects the studio shows around it', () => {
  const [raw] = espn.parseScoreboard(NFL_SCOREBOARD, 'nfl');
  const promotion = promotions.byPrefix.nfl;
  const event = transform.fromWiki(raw, promotion);
  const ok = promotion.isRelevantStreamTitle(
    'NFL 2026 09 11 San Francisco 49ers at Los Angeles Rams 1080p', event);
  assert.equal(ok.ok, true, 'expected a plain fixture release to match, got ' + JSON.stringify(ok));
  // RedZone and the condensed cuts carry both team names on the same day.
  for (const noise of [
    'NFL RedZone Week 1 2026 09 11 1080p',
    'NFL 2026 09 11 49ers at Rams Condensed Game 720p',
  ]) {
    assert.equal(promotion.isRelevantStreamTitle(noise, event).ok, false,
      'should not have matched: ' + noise);
  }
});

test('NBA fixtures normalise and match the same way', () => {
  const [raw] = espn.parseScoreboard(NBA_SCOREBOARD, 'nba');
  const promotion = promotions.byPrefix.nba;
  const event = transform.fromWiki(raw, promotion);
  assert.equal(event.id, 'nba:401909861');
  assert.equal(event.name, 'Los Angeles Lakers at Utah Jazz');
  assert.equal(promotion.isRelevantStreamTitle(
    'NBA 2026 10 25 Los Angeles Lakers at Utah Jazz 1080p', event).ok, true);
  assert.equal(promotion.isRelevantStreamTitle(
    'NBA Summer League 2026 10 25 Lakers vs Jazz', event).ok, false);
});

test('a custom promotion can be created against an ESPN league', () => {
  const custom = require('../lib/custom-promotions');
  // The wizard will create promotions this way, so the source has to be
  // accepted and its league reference has to survive normalisation.
  const spec = (extra) => Object.assign({
    id: 'nhl', name: 'NHL', idPrefix: 'nhl', source: 'espn', league: 'nhl',
    searchTitleTemplates: ['{promotion} {date_dotted} {name}'],
    relevanceKeywords: ['nhl'],
  }, extra || {});
  const valid = custom.validateSpec(spec());
  assert.equal(valid.ok, true, 'expected a valid ESPN spec, got ' + JSON.stringify(valid));
  assert.match(custom.validateSpec(spec({ id: 'quid', idPrefix: 'quid', league: 'quidditch' })).error,
    /league must be one of/);
  assert.equal(custom.normaliseSpec(spec({ league: 'NHL' })).league, 'nhl');
});

// A 120-day refresh window (the default eventWindowDaysBack/Ahead) answered as
// one ESPN response exceeded the adapter's byte cap, so the NFL promotion could
// only ever report "ESPN scoreboard exceeded its size limit". The range is now
// split, which bounds each response rather than raising the ceiling and hoping.
test('splits a long window into bounded date chunks', () => {
  const windows = espn.dateWindows('2026-08-04', '2026-12-02');
  assert.ok(windows.length >= 4, 'expected a 121-day range to split, got ' + windows.length);
  assert.equal(windows[0][0], '2026-08-04');
  assert.equal(windows[windows.length - 1][1], '2026-12-02');
  for (const [from, to] of windows) {
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
    assert.ok(days <= espn.CHUNK_DAYS, 'window ' + from + '..' + to + ' spans ' + days + ' days');
  }
  // Contiguous and non-overlapping: no fixture can fall between two windows.
  for (let i = 1; i < windows.length; i += 1) {
    assert.equal(Date.parse(windows[i][0]) - Date.parse(windows[i - 1][1]), 86400000,
      'gap or overlap between ' + windows[i - 1][1] + ' and ' + windows[i][0]);
  }
});

test('a range inside one chunk stays a single request, and a bad range is empty', () => {
  assert.deepEqual(espn.dateWindows('2026-09-01', '2026-09-10'), [['2026-09-01', '2026-09-10']]);
  assert.deepEqual(espn.dateWindows('2026-09-10', '2026-09-01'), []);
  assert.deepEqual(espn.dateWindows('nonsense', '2026-09-01'), []);
});
