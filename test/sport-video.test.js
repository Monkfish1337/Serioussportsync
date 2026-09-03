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
    eventId: 'mlb:123', eventTitle: event.name, promotion: 'mlb',
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
