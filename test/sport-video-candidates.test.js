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
