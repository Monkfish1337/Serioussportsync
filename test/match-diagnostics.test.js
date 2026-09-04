'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-match-diagnostics-'));
process.env.SPORT_VIDEO_FILE = path.join(dir, 'sport-video.json');
process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'match-diagnostics-test-secret-00000000000000000000000000000000';
const diagnostics = require('../lib/match-diagnostics');
const promotions = require('../lib/promotions');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function today(offsetDays) {
  return new Date(Date.now() + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
}

function seedReleases(releases) {
  fs.writeFileSync(process.env.SPORT_VIDEO_FILE, JSON.stringify({
    version: 1, releases, discoverySource: 'search-index',
  }));
}

const ucl = promotions.byPrefix.ucl;

test('names the stage and reason a release was rejected, not just that it was', () => {
  const date = today(-2);
  const dmy = date.slice(8, 10) + '.' + date.slice(5, 7) + '.' + date.slice(0, 4);
  const event = {
    id: 'ucl:diag-1', name: 'AEK Athens vs Levski Sofia', date,
    aliases: ['AEK Athens vs Levski Sofia'],
    teamNames: { home: ['AEK Athens'], away: ['Levski Sofia'] },
  };
  seedReleases([
    // Matches on the card title alone.
    { id: 'a', title: 'AEK Athens vs Levski Sofia ' + dmy, date, detailUrl: 'https://sport-video.org.ua/a.html', infoHash: 'a'.repeat(40) },
    // Dropped by the shared release filter before relevance is ever consulted.
    { id: 'b', title: 'AEK Athens vs Levski Sofia Highlights ' + dmy, date, detailUrl: 'https://sport-video.org.ua/b.html' },
    // Right date, wrong fixture.
    { id: 'c', title: 'Real Madrid vs Real Sociedad ' + dmy, date, detailUrl: 'https://sport-video.org.ua/c.html' },
  ]);

  const report = diagnostics.diagnose({ events: [event], promotionId: 'ucl', days: 30 });
  assert.equal(report.rows.length, 3);
  const byRelease = new Map(report.rows.map((row) => [row.release.id, row]));

  assert.equal(byRelease.get('a').decision, 'matched');
  assert.equal(byRelease.get('a').stage, 'card-title');
  assert.equal(byRelease.get('a').release.prepared, true);

  assert.equal(byRelease.get('b').decision, 'rejected');
  assert.equal(byRelease.get('b').stage, 'release-filter');
  assert.equal(byRelease.get('b').reason, 'sports-noise');

  assert.equal(byRelease.get('c').decision, 'rejected');
  assert.equal(byRelease.get('c').stage, 'relevance');
  // The reason has to be specific enough to act on — which alias was missing.
  assert.match(byRelease.get('c').reason, /team/);

  assert.equal(report.summary.matchedEvents, 1);
  assert.ok(report.summary.rejectionsByReason['release-filter:sports-noise'] >= 1);
});

test('records events that have no release at all, rather than omitting them', () => {
  const date = today(-1);
  seedReleases([]);
  const report = diagnostics.diagnose({
    events: [{ id: 'ucl:diag-2', name: 'Bodo Glimt vs NEC', date }],
    promotionId: 'ucl', days: 30,
  });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].decision, 'no-candidate');
  assert.equal(report.rows[0].release, null);
  assert.equal(report.summary.eventsWithNoRelease, 1);
  // The queries SSS generated are carried even with nothing to match against,
  // because an empty result is usually a query problem.
  assert.ok(report.rows[0].searchTitles.length > 0);
});

test('carries the aliases and generated queries used for the decision', () => {
  const date = today(0);
  seedReleases([]);
  const event = {
    id: 'ucl:diag-3', name: 'Olympique Lyonnais vs Fenerbahce', date,
    aliases: ['Olympique Lyonnais vs Fenerbahce', 'Lyon vs Fenerbahce'],
    teamNames: { home: ['Olympique Lyonnais', 'Lyon'], away: ['Fenerbahce'] },
  };
  const report = diagnostics.diagnose({ events: [event], promotionId: 'ucl', days: 30 });
  const row = report.rows[0];
  assert.deepEqual(row.homeNames, ['Olympique Lyonnais', 'Lyon']);
  assert.deepEqual(row.eventAliases, ['Olympique Lyonnais vs Fenerbahce', 'Lyon vs Fenerbahce']);
  assert.ok(row.searchTitles.some((title) => /Fenerbahce/i.test(title)));
});

test('exports a spreadsheet-safe CSV that never carries a torrent URL', () => {
  const date = today(-1);
  const dmy = date.slice(8, 10) + '.' + date.slice(5, 7) + '.' + date.slice(0, 4);
  seedReleases([{
    id: 'x', title: '=cmd|calc!A1 ' + dmy, date,
    detailUrl: 'https://sport-video.org.ua/x.html',
    torrentUrl: 'https://sport-video.org.ua/private.torrent',
    indexTitle: 'quote " and, comma ' + dmy,
  }]);
  const report = diagnostics.diagnose({
    events: [{ id: 'ucl:diag-4', name: 'A vs B', date }], promotionId: 'ucl', days: 30,
  });
  const csv = diagnostics.toCsv(report);
  const header = csv.split('\r\n')[0];
  assert.equal(header, diagnostics.CSV_COLUMNS.join(','));
  assert.doesNotMatch(csv, /private\.torrent/);
  // A leading = would be evaluated as a formula by Excel and Sheets.
  assert.match(csv, /"'=cmd\|calc!A1/);
  // Embedded quotes are doubled, so the row does not break the column count.
  assert.match(csv, /quote "" and, comma/);
});

test('scopes the export to one promotion and a date window', () => {
  seedReleases([]);
  const events = [
    { id: 'ucl:in', name: 'In window', date: today(-3) },
    { id: 'ucl:out', name: 'Way out of window', date: today(-400) },
    { id: 'mlb:other', name: 'Other promotion', date: today(-3) },
  ];
  const report = diagnostics.diagnose({ events, promotionId: 'ucl', days: 30 });
  assert.deepEqual(report.rows.map((row) => row.eventId), ['ucl:in']);
  const all = diagnostics.diagnose({ events, days: 30 });
  assert.deepEqual(all.rows.map((row) => row.eventId).sort(), ['mlb:other', 'ucl:in']);
});

// A real export carried 14,758 rejections against 394 matches, which reads as
// total failure until you notice nearly all of it is one sport's fixture being
// correctly rejected against another sport's release. The overlap score is what
// separates a genuine near miss from that noise.
test('scores how much of the event name the release title actually carries', () => {
  const csv = diagnostics.toCsv({ rows: [{
    promotion: 'f1', eventId: 'f1:1', eventName: 'Hungarian Grand Prix Practice 1',
    nameOverlap: 1, nearMiss: true,
    decision: 'rejected', stage: 'release-filter', reason: 'foreign-language',
    release: { title: 'Formula 1 Hungarian Grand Prix Practice 1 24.07.2026' },
  }] });
  const [header, row] = csv.trim().split('\r\n');
  const columns = header.split(',');
  assert.ok(columns.includes('name_overlap'), 'expected a name_overlap column');
  assert.ok(columns.includes('near_miss'), 'expected a near_miss column');
  const cells = row.slice(1, -1).split('","');
  assert.equal(cells.length, diagnostics.CSV_COLUMNS.length,
    'every column must be written for every row');
  assert.equal(cells[columns.indexOf('name_overlap')], '1');
  assert.equal(cells[columns.indexOf('near_miss')], 'yes');
});

test('an unrelated sport scores near zero and a true pairing scores high', () => {
  const rows = diagnostics.toCsv({ rows: [
    { eventName: 'Detroit Tigers vs Cleveland Guardians', decision: 'rejected',
      nameOverlap: 0, nearMiss: false,
      release: { title: 'Colorado Buffaloes at Georgia Tech Yellow Jackets 03.09.2026' } },
    { eventName: 'San Francisco Giants vs Pittsburgh Pirates', decision: 'matched',
      nameOverlap: 1, nearMiss: false,
      release: { title: 'San Francisco Giants at Pittsburgh Pirates 03.09.2026' } },
  ] }).trim().split('\r\n');
  const columns = rows[0].split(',');
  const overlapAt = columns.indexOf('name_overlap');
  assert.equal(rows[1].slice(1, -1).split('","')[overlapAt], '0');
  assert.equal(rows[2].slice(1, -1).split('","')[overlapAt], '1');
});
