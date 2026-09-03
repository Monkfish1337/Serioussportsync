'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const vm = require('node:vm');
const sportVideo = require('../lib/sources/sport-video');
const promotions = require('../lib/promotions');
const admin = require('../lib/admin-sport-video');
const chrome = require('../lib/tabler-chrome');
const settings = require('../lib/settings');
const streams = require('../lib/streams');

test('parses the limited RSS title feed without trusting its homepage links', () => {
  const xml = '<?xml version="1.0"?><rss><channel>'
    + '<item><title>Atlanta Braves at Washington Nationals 02.09.2026</title><link>http://sport-video.org.ua/index.html</link></item>'
    + '<item><title><![CDATA[Falkirk vs Rangers 02.09.2026]]></title><link>http://sport-video.org.ua/index.html</link></item>'
    + '</channel></rss>';
  assert.deepEqual(sportVideo.parseRss(xml), [
    'Atlanta Braves at Washington Nationals 02.09.2026',
    'Falkirk vs Rangers 02.09.2026',
  ]);
});

test('parses dated catalogue cards and ignores navigation headings', () => {
  const html = '<strong>BASEBALL</strong><div><a href="./baseball.html">Baseball</a></div>'
    + '<div><strong>Atlanta Braves at Washington Nationals 02.09.2026</strong>'
    + '<span>poster</span><a href="./ABWN020926.html"><img></a></div>';
  const records = sportVideo.parseCatalog(html, 'baseball');
  assert.equal(records.length, 1);
  assert.equal(records[0].date, '2026-09-02');
  assert.equal(records[0].detailUrl, 'https://sport-video.org.ua/ABWN020926.html');
});

test('detail parsing accepts only same-origin torrent resources', () => {
  const record = {
    id: 'release', title: 'Atlanta Braves at Washington Nationals 02.09.2026',
    detailUrl: 'https://sport-video.org.ua/ABWN020926.html',
  };
  const html = '<table><tr><td>Video</td><td>59.94 fps, 6600 Kbps</td></tr>'
    + '<tr><td>Aspect Ratio</td><td>1280x720</td></tr><tr><td>Language</td><td>engl</td></tr></table>'
    + '<a href="images/ABWN020926.jpg"></a>'
    + '<a href="./Atlanta Braves at Washington Nationals 02.09.2026.mkv.torrent"></a>';
  const parsed = sportVideo.parseDetail(html, record);
  assert.match(parsed.torrentUrl, /^https:\/\/sport-video\.org\.ua\//);
  assert.equal(parsed.resolution, '1280x720');
  assert.throws(() => sportVideo.parseDetail(
    '<a href="https://attacker.example/release.torrent"></a>', record),
  /approved source origin/);
});

test('derives a torrent info hash, size, name, and public trackers from bencode', () => {
  const info = 'd6:lengthi12345e4:name9:match.mkve';
  const encoded = Buffer.from('d8:announce14:http://tracker4:info' + info + 'e');
  const metadata = sportVideo.torrentMetadata(encoded);
  assert.equal(metadata.infoHash, crypto.createHash('sha1').update(Buffer.from(info)).digest('hex'));
  assert.equal(metadata.name, 'match.mkv');
  assert.equal(metadata.size, 12345);
  assert.deepEqual(metadata.trackers, ['http://tracker']);
  assert.throws(() => sportVideo.torrentMetadata(Buffer.from('not-a-torrent')), /Invalid torrent/);
});

test('matches a source release to the existing MLB event rules', () => {
  const event = {
    id: 'mlb:123', name: 'Atlanta Braves vs Washington Nationals', date: '2026-09-02',
  };
  const matches = sportVideo.matchRelease({
    title: 'Atlanta Braves at Washington Nationals 02.09.2026', date: '2026-09-02',
  }, [event], promotions);
  assert.deepEqual(matches, [{
    eventId: 'mlb:123', eventTitle: event.name, eventDate: event.date, promotion: 'mlb',
    // Carried so the team filter can be applied without a catalog lookup.
    eventTeams: ['Atlanta Braves', 'Washington Nationals'],
  }]);
});

test('renders a dedicated, filterable source console without exposing torrent URLs', () => {
  const html = admin.renderBody({
    config: {
      enabled: true, autoScan: true, intervalHours: 6, startDelaySeconds: 90,
      maxDetailsPerScan: 50, categories: ['baseball'],
    },
    status: { releases: 1, matched: 1, prepared: 1, rssCount: 1 },
    releases: [{
      id: 'abc', title: 'Atlanta Braves at Washington Nationals 02.09.2026',
      date: '2026-09-02', category: 'baseball', infoHash: 'a'.repeat(40),
      torrentUrl: 'https://sport-video.org.ua/private.torrent', size: 12345,
      matches: [{ eventId: 'mlb:123', eventTitle: 'Atlanta Braves vs Washington Nationals', promotion: 'mlb' }],
    }],
    cached: new Set(), torboxConfigured: true,
  });
  assert.match(html, /Discovered releases/);
  assert.match(html, /Warm to TorBox/);
  assert.match(html, /id="sv-search"/);
  assert.match(html, /id="sv-category"/);
  assert.doesNotMatch(html, /private\.torrent/);
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new vm.Script(script[1]));
  }
  assert.ok(chrome.ADMIN_SECTIONS.some((section) => section.id === 'sport-video'));
});

test('feeds a matched direct release into TorBox discovery without Companion or Prowlarr', async () => {
  const originals = {
    getSportVideo: settings.getSportVideo,
    getCompanion: settings.getCompanion,
    getProwlarr: settings.getProwlarr,
    candidatesForEvent: sportVideo.candidatesForEvent,
  };
  try {
    settings.getSportVideo = () => ({ enabled: true });
    settings.getCompanion = () => ({ url: '', authToken: '' });
    settings.getProwlarr = () => ({ url: '', apiKey: '' });
    sportVideo.candidatesForEvent = async () => [{
      infoHash: 'b'.repeat(40), title: 'Atlanta Braves at Washington Nationals 02.09.2026',
      size: 5996835794, indexer: 'Sport-Video', trackers: ['https://tracker.example/announce'],
    }];
    const messages = [];
    const candidates = await streams._test.discoverTorrentCandidates({
      promo: promotions.getByEventId('mlb:123'),
      event: { id: 'mlb:123', name: 'Atlanta Braves vs Washington Nationals', date: '2026-09-02' },
      titles: ['MLB 2026 RS 02.09.2026 Atlanta Braves @ Washington Nationals'],
      log: (message) => messages.push(message), discoveryBudgetMs: 5000,
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].indexer, 'Sport-Video');
    assert.ok(messages.some((message) => /matched direct candidate/.test(message)));
  } finally {
    settings.getSportVideo = originals.getSportVideo;
    settings.getCompanion = originals.getCompanion;
    settings.getProwlarr = originals.getProwlarr;
    sportVideo.candidatesForEvent = originals.candidatesForEvent;
  }
});

test('collects dated archive pages from the site index, newest first', () => {
  const html = '<a href="./index.html">Home</a><a href="./schedule.html">Schedule</a>'
    + '<a href="./august2026-1.html">1</a><a href="./august2026-10.html">10</a>'
    + '<a href="./august2026-2.html">2</a><a href="./september2026.html">Sep</a>'
    + '<a href="./july2026.html">Jul</a><a href="./december2025-3.html">Dec</a>'
    + '<a href="./august2026-1.html">dupe</a><a href="./oldergames.html">Older</a>'
    + '<a href="https://evil.example/august2026-1.html">off-site</a>';
  const links = sportVideo.parseArchiveLinks(html);
  assert.deepEqual(links.map((entry) => entry.file), [
    'september2026.html',
    'august2026-1.html', 'august2026-2.html', 'august2026-10.html',
    'july2026.html',
    'december2025-3.html',
  ]);
  // Navigation and non-archive pages never become archive targets.
  assert.ok(!links.some((entry) => /index|schedule|oldergames/.test(entry.file)));
});

test('re-matches stored releases once their event metadata arrives', () => {
  const stored = [{
    id: 'a', title: 'Atlanta Braves at Washington Nationals 02.09.2026',
    date: '2026-09-02', matches: [],
  }];
  // First pass: the fixture does not exist yet, which is the normal case for a
  // source that publishes ahead of a metadata refresh.
  assert.equal(sportVideo.rematchReleases(stored, [], promotions), 0);
  assert.deepEqual(stored[0].matches, []);
  // Second pass: the same stored record now matches without being rediscovered.
  const matched = sportVideo.rematchReleases(stored, [{
    id: 'mlb:123', name: 'Atlanta Braves vs Washington Nationals', date: '2026-09-02',
  }], promotions);
  assert.equal(matched, 1);
  assert.equal(stored[0].matches[0].eventId, 'mlb:123');
  assert.ok(stored[0].matchedAt);
});

test('never matches a release the stream pipeline would reject', () => {
  const event = {
    id: 'mlb:123', name: 'Atlanta Braves vs Washington Nationals', date: '2026-09-02',
  };
  const report = {};
  // Highlights are dropped by the shared release filter in lib/streams.js.
  // Matching one here would offer a Warm button for a row that could never be
  // served, which is exactly the admin/stream asymmetry 0.81.1 removes.
  assert.deepEqual(sportVideo.matchRelease({
    title: 'Atlanta Braves at Washington Nationals Highlights 02.09.2026',
    date: '2026-09-02',
  }, [event], promotions, report), []);
  assert.deepEqual(report.exclusions, ['release filter']);
  assert.equal(sportVideo.matchRelease({
    title: 'Atlanta Braves at Washington Nationals 02.09.2026', date: '2026-09-02',
  }, [event], promotions).length, 1);
});

test('ranks a source that reports pixel geometry instead of a scene token', () => {
  const geometry = { title: 'Atlanta Braves at Washington Nationals 02.09.2026', resolution: '1920x1080', size: 1 };
  const scene = { title: 'MLB.2026.09.02.Braves.vs.Nationals.720p.WEB-DL', size: 9 };
  assert.equal(streams._test.candidateResolution(geometry), '1080p');
  const list = [scene, geometry];
  streams._test.sortCandidates(list, 'size', 'publishDate');
  // Without the geometry translation the larger 720p release sorted first and
  // the Sport-Video row was pushed toward (or past) the row cap.
  assert.equal(list[0], geometry);
  assert.match(streams._test.buildTorboxRow(geometry, 'https://example/resolve').name, /1080p/);
});

// The site's search box is client-side and backed by one static index of every
// page. Reading it is a single request that covers the whole catalogue, which
// is why 0.81.2 stopped depending on how many listing pages a scan can afford.
const SEARCH_INDEX_SAMPLE = [
  '// search index for WYSIWYG Web Builder',
  'var database_length = 0;',
  'function SearchDatabase()',
  '{',
  '   database_length = 0;',
  '   this[database_length++] = new SearchPage("start.html", "Sport Video", "kw", "desc");',
  '   this[database_length++] = new SearchPage("august2026-3.html", "August 2026 page 3", "kw", "desc");',
  '   this[database_length++] = new SearchPage("AALS260826.html", "AEK Athens vs Levski Sofia 26.08.2026 UEFA Champions League Football torrent download free", "kw", "desc");',
  '   this[database_length++] = new SearchPage("NYYLAA020926.html", "New York Yankees at Los Angeles Angels 02.09.2026 Torrent MLB 2026 Live Stream Video Free Download baseball", "kw", "desc");',
  '   this[database_length++] = new SearchPage("NODATE.html", "Premier League Highlights Show", "kw", "desc");',
  '   return this;',
  '}',
].join('\r\n');

test('reads every page from the static search index the site search uses', () => {
  const entries = sportVideo.parseSearchIndex(SEARCH_INDEX_SAMPLE);
  // Navigation, month-listing and undated pages are not releases.
  assert.deepEqual(entries.map((entry) => entry.title), [
    'AEK Athens vs Levski Sofia 26.08.2026',
    'New York Yankees at Los Angeles Angels 02.09.2026',
  ]);
  const [ucl, mlb] = entries;
  assert.equal(ucl.date, '2026-08-26');
  assert.equal(ucl.detailUrl, 'https://sport-video.org.ua/AALS260826.html');
  assert.equal(ucl.category, 'football');
  assert.match(ucl.indexTitle, /UEFA Champions League/);
  assert.equal(mlb.category, 'baseball');
  assert.equal(mlb.date, '2026-09-02');
});

test('trims the index marketing tail without losing the event identity', () => {
  assert.equal(
    sportVideo.cleanIndexTitle('AEK Athens vs Levski Sofia 26.08.2026 UEFA Champions League Football torrent download free'),
    'AEK Athens vs Levski Sofia 26.08.2026');
  assert.equal(sportVideo.cleanIndexTitle('No date here at all'), 'No date here at all');
});

// Regression for the release that prompted the rewrite: it is present on the
// site and its fixture is in the Champions League catalog, so discovery must
// connect the two.
test('matches the Champions League release the crawl kept missing', () => {
  const entries = sportVideo.parseSearchIndex(SEARCH_INDEX_SAMPLE);
  const record = entries.find((entry) => /AEK Athens/.test(entry.title));
  const event = {
    id: 'ucl:2026-aek-levski', name: 'AEK Athens vs Levski Sofia', date: '2026-08-26',
  };
  assert.equal(sportVideo.rematchReleases([record], [event], promotions), 1);
  assert.equal(record.matches[0].eventId, event.id);
  assert.equal(record.matches[0].promotion, 'ucl');
});

test('accepts the competition name the index title carries but the card title does not', () => {
  // A promotion that identifies its events by keyword rather than by team —
  // the shape where a bare "Team A vs Team B date" card title cannot pass.
  const stub = {
    getByEventId: () => ({
      id: 'stub',
      isRelevantStreamTitle(title) {
        return /champions league/i.test(title)
          ? { ok: true } : { ok: false, reason: 'no-keyword-match' };
      },
    }),
  };
  const event = { id: 'stub:1', name: 'AEK Athens vs Levski Sofia', date: '2026-08-26' };
  const record = {
    title: 'AEK Athens vs Levski Sofia 26.08.2026',
    indexTitle: 'AEK Athens vs Levski Sofia 26.08.2026 UEFA Champions League Football',
    date: '2026-08-26',
  };
  assert.equal(sportVideo.matchRelease(record, [event], stub).length, 1);
  // Without the index title there is no keyword evidence and it must not match.
  assert.deepEqual(
    sportVideo.matchRelease({ title: record.title, date: record.date }, [event], stub), []);
});

test('only compares a release against fixtures inside its own date window', () => {
  const record = { title: 'AEK Athens vs Levski Sofia 26.08.2026', date: '2026-08-26' };
  const farAway = {
    id: 'ucl:other', name: 'AEK Athens vs Levski Sofia', date: '2026-11-26',
  };
  assert.equal(sportVideo.rematchReleases([record], [farAway], promotions), 0);
  assert.equal(record.matchExclusion, undefined);
});

test('never warms automatically until a promotion is explicitly selected', async () => {
  const original = settings.getSportVideo;
  settings.getSportVideo = () => ({ enabled: true, autoWarmPromotions: [], autoWarmPerScan: 5 });
  try {
    const result = await sportVideo.autoWarmMatched([{
      infoHash: 'e'.repeat(40), title: 'anything',
      matches: [{ eventId: 'ucl:1', eventTitle: 'x', promotion: 'ucl' }],
    }], {});
    assert.deepEqual(result, { attempted: 0, warmed: 0, ready: 0 });
  } finally {
    settings.getSportVideo = original;
  }
});
