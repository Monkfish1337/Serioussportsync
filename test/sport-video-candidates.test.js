'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-sport-video-candidates-'));
process.env.SPORT_VIDEO_FILE = path.join(dir, 'sport-video.json');
process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'sport-video-candidates-test-secret-00000000000000000000000000';
const settings = require('../lib/settings');
const sportVideo = require('../lib/sources/sport-video');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function seed(releases) {
  fs.writeFileSync(process.env.SPORT_VIDEO_FILE, JSON.stringify({
    version: 1, releases, lastScanAt: null, lastSuccessAt: null, lastError: '',
  }));
}

// Regression for the 0.81.0 ordering bug: candidatesForEvent sliced the matched
// records to the row limit BEFORE it filtered for a usable info hash. An event
// with more matches than the limit could therefore drop its one prepared (and
// possibly already warmed) release in favour of unprepared ones, and then
// return nothing at all once the hash filter removed those — so a release the
// admin had warmed to TorBox never appeared when the event was opened.
test('returns prepared releases even when unprepared ones are stored first', async () => {
  const match = [{ eventId: 'mlb:123', eventTitle: 'Braves vs Nationals', promotion: 'mlb' }];
  const releases = [];
  for (let index = 0; index < 6; index += 1) {
    releases.push({
      id: 'pending-' + index, title: 'Pending release ' + index, date: '2026-09-02',
      detailUrl: 'https://sport-video.org.ua/pending' + index + '.html', matches: match,
    });
  }
  releases.push({
    id: 'ready', title: 'Atlanta Braves at Washington Nationals 02.09.2026',
    date: '2026-09-02', infoHash: 'c'.repeat(40), size: 5996835794,
    resolution: '1280x720', video: '59.94 fps, 6600 Kbps',
    trackers: ['https://tracker.example/announce'], matches: match,
  });
  seed(releases);

  const original = settings.getSportVideo;
  settings.getSportVideo = () => ({ enabled: true });
  try {
    const candidates = await sportVideo.candidatesForEvent('mlb:123', { hydrate: false });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].infoHash, 'c'.repeat(40));
    // The detail-page geometry travels with the candidate so stream ranking and
    // row labelling can treat it like any other 720p result.
    assert.equal(candidates[0].resolution, '1280x720');
    assert.equal(candidates[0].source, 'sport-video');
  } finally {
    settings.getSportVideo = original;
  }
});

test('ignores releases matched to a different event', async () => {
  seed([{
    id: 'other', title: 'Some Other Fixture 02.09.2026', date: '2026-09-02',
    infoHash: 'd'.repeat(40), matches: [{ eventId: 'mlb:999', eventTitle: 'Other', promotion: 'mlb' }],
  }]);
  const original = settings.getSportVideo;
  settings.getSportVideo = () => ({ enabled: true });
  try {
    assert.deepEqual(await sportVideo.candidatesForEvent('mlb:123', { hydrate: false }), []);
  } finally {
    settings.getSportVideo = original;
  }
});

test('stays silent while the source is disabled', async () => {
  seed([{
    id: 'ready', title: 'Atlanta Braves at Washington Nationals 02.09.2026', date: '2026-09-02',
    infoHash: 'c'.repeat(40), matches: [{ eventId: 'mlb:123', eventTitle: 'x', promotion: 'mlb' }],
  }]);
  const original = settings.getSportVideo;
  settings.getSportVideo = () => ({ enabled: false });
  try {
    assert.deepEqual(await sportVideo.candidatesForEvent('mlb:123', { hydrate: false }), []);
  } finally {
    settings.getSportVideo = original;
  }
});

// TorBox holds a cached copy for at least 30 days, so re-preparing and
// re-warming an old fixture buys nothing: it is either still cached and needs
// no warming, or has aged out with nobody watching. Automatic work therefore
// stops at a configurable age; the manual buttons do not.
function daysAgo(count) {
  return new Date(Date.now() - count * 86400000).toISOString().slice(0, 10);
}

test('measures a match by its fixture date, falling back to the release date', () => {
  assert.equal(sportVideo.matchAgeDays({
    date: daysAgo(30), matches: [{ eventDate: daysAgo(3) }],
  }), 3);
  // Records written before 0.81.4 carry no eventDate; matching guarantees the
  // release date is within a day of the fixture.
  assert.equal(sportVideo.matchAgeDays({ date: daysAgo(9), matches: [{}] }), 9);
  // An upcoming fixture is never outside the window.
  assert.ok(sportVideo.matchAgeDays({
    date: daysAgo(-4), matches: [{ eventDate: daysAgo(-4) }],
  }) < 0);
  assert.equal(sportVideo.matchAgeDays({ date: '', matches: [] }), Infinity);
});

test('stops warming automatically once a fixture leaves the window', async () => {
  const match = (age) => [{
    eventId: 'ucl:' + age, eventTitle: 'x', eventDate: daysAgo(age), promotion: 'ucl',
  }];
  const releases = [
    { id: 'fresh', title: 'Fresh', infoHash: 'a'.repeat(40), date: daysAgo(2), matches: match(2) },
    { id: 'stale', title: 'Stale', infoHash: 'b'.repeat(40), date: daysAgo(40), matches: match(40) },
  ];
  const original = settings.getSportVideo;
  const submitted = [];
  settings.getSportVideo = () => ({
    enabled: true, autoWarmPromotions: ['ucl'], autoWarmPerScan: 10, autoWarmWindowDays: 14,
  });
  const streams = require('../lib/streams');
  const users = require('../lib/users');
  const originalWarm = streams.warmTorbox;
  const originalList = users.listUsers;
  const originalFind = users.findById;
  users.listUsers = () => [{ id: 'u1' }];
  users.findById = () => ({ id: 'u1', username: 'tester', config: { torboxApiKey: 'k' } });
  streams.warmTorbox = async ({ infoHash }) => { submitted.push(infoHash); return { ok: true, queued: true }; };
  try {
    const result = await sportVideo.autoWarmMatched(releases, {});
    assert.deepEqual(submitted, ['a'.repeat(40)]);
    assert.equal(result.warmed, 1);
    // The in-window record is stamped so a later scan does not resubmit it;
    // the out-of-window one is left untouched for a manual warm.
    assert.ok(releases[0].autoWarmedAt);
    assert.equal(releases[1].autoWarmedAt, undefined);
  } finally {
    settings.getSportVideo = original;
    streams.warmTorbox = originalWarm;
    users.listUsers = originalList;
    users.findById = originalFind;
  }
});

// The store is read on the request path — once when an event is opened and
// again when a row is played. After discovery moved to the full search index
// the file reached ~1.5 MB, making an uncached read a ~11ms synchronous parse
// on every stream request.
test('reads the store once and serves repeats from cache', () => {
  seed([{
    id: 'cached', title: 'Cached release', date: '2026-09-02', infoHash: 'c'.repeat(40),
    matches: [{ eventId: 'mlb:123', eventTitle: 'x', eventDate: '2026-09-02', promotion: 'mlb' }],
  }]);
  sportVideo.invalidate();

  const realReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function counted(target, ...rest) {
    if (String(target) === process.env.SPORT_VIDEO_FILE) reads += 1;
    return realReadFileSync.call(this, target, ...rest);
  };
  try {
    for (let i = 0; i < 25; i += 1) sportVideo.load();
    assert.equal(reads, 1, 'expected one read for 25 loads, got ' + reads);

    // An edit made outside the process must still be picked up.
    const raw = realReadFileSync(process.env.SPORT_VIDEO_FILE, 'utf8');
    fs.writeFileSync(process.env.SPORT_VIDEO_FILE, raw + ' ');
    sportVideo.load();
    assert.equal(reads, 2, 'an external edit should force a re-read');
  } finally {
    fs.readFileSync = realReadFileSync;
    sportVideo.invalidate();
  }
});

test('migrates stored state forward instead of relying on read-site fallbacks', () => {
  const migrated = sportVideo.migrateState({
    version: 1,
    releases: [
      { id: 'a', title: 'A', date: '2026-08-26', matches: [{ eventId: 'ucl:1', promotion: 'ucl' }] },
      { id: 'b', title: 'B', date: '2026-08-27' },
    ],
  });
  assert.equal(migrated.version, sportVideo.STATE_VERSION);
  // A pre-0.81.4 match gains the fixture date the age window needs.
  assert.equal(migrated.releases[0].matches[0].eventDate, '2026-08-26');
  // A record with no matches array at all is normalised rather than left to
  // whichever read site touches it first.
  assert.deepEqual(migrated.releases[1].matches, []);
  assert.equal(migrated.releases[1].indexTitle, '');
  assert.equal(migrated.releases[1].fromIndex, false);
  // Already-current state is returned untouched.
  const current = { version: sportVideo.STATE_VERSION, releases: [] };
  assert.equal(sportVideo.migrateState(current), current);
});

// Narrowing the expensive half of the pipeline to named sides. MLB alone is
// ~2,400 fixtures a season; preparing every one of them spends detail fetches
// and TorBox quota on games nobody asked for.
test('prepares only selected teams, and leaves unfiltered promotions alone', () => {
  const yankees = {
    matches: [{ promotion: 'mlb', eventTeams: ['New York Yankees', 'Los Angeles Angels'] }],
  };
  const otherGame = {
    matches: [{ promotion: 'mlb', eventTeams: ['Chicago Cubs', 'Milwaukee Brewers'] }],
  };
  const filters = { mlb: ['New York Yankees'] };

  assert.equal(sportVideo.matchesSelectedTeams(yankees, filters), true);
  assert.equal(sportVideo.matchesSelectedTeams(otherGame, filters), false);
  // Either side counts, not just the home team.
  assert.equal(sportVideo.matchesSelectedTeams({
    matches: [{ promotion: 'mlb', eventTeams: ['Boston Red Sox', 'New York Yankees'] }],
  }, filters), true);

  // A promotion with nothing selected is not filtered — this is what keeps
  // boxing, UFC and anything else without a recurring line-up working.
  const boxing = { matches: [{ promotion: 'boxing', eventTeams: ['Fury', 'Usyk'] }] };
  assert.equal(sportVideo.matchesSelectedTeams(boxing, filters), true);
  assert.equal(sportVideo.matchesSelectedTeams(boxing, { boxing: [] }), true);

  // No filters configured at all: everything passes.
  assert.equal(sportVideo.matchesSelectedTeams(otherGame, {}), true);
});

test('never drops a release the team filter cannot judge', () => {
  const filters = { mlb: ['New York Yankees'] };
  // Matched before this feature existed, so it carries no eventTeams.
  assert.equal(sportVideo.matchesSelectedTeams({
    matches: [{ promotion: 'mlb', eventTitle: 'Cubs at Brewers' }],
  }, filters), true);
  // A fixture whose name does not split into two sides.
  assert.equal(sportVideo.matchesSelectedTeams({
    matches: [{ promotion: 'mlb', eventTeams: [] }],
  }, filters), true);
  // Matched to a second promotion that is unfiltered.
  assert.equal(sportVideo.matchesSelectedTeams({
    matches: [
      { promotion: 'mlb', eventTeams: ['Chicago Cubs', 'Milwaukee Brewers'] },
      { promotion: 'boxing', eventTeams: ['Fury', 'Usyk'] },
    ],
  }, filters), true);
});

test('reads both sides of a fixture however the provider names it', () => {
  assert.deepEqual(sportVideo.participantsOf({ name: 'New York Yankees at Los Angeles Angels' }),
    ['New York Yankees', 'Los Angeles Angels']);
  assert.deepEqual(sportVideo.participantsOf({ name: 'AEK Athens FC vs PFC Levski Sofia' }),
    ['AEK Athens FC', 'PFC Levski Sofia']);
  // Structured provider names win over the title when both are present.
  assert.deepEqual(sportVideo.participantsOf({
    name: 'Lyon vs Fenerbahce',
    teamNames: { home: ['Olympique Lyonnais', 'Lyon'], away: ['Fenerbahce SK'] },
  }), ['Olympique Lyonnais', 'Fenerbahce SK']);
  // A single-sided event has no participants to filter on.
  assert.deepEqual(sportVideo.participantsOf({ name: 'UFC 300' }), []);
});
