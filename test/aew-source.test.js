'use strict';

// AEW gets its schedule from AEW.
//
// TheSportsDB's free key cannot reach AEW's upcoming cards: eventsnextleague
// returns one event, eventsseason returns fifteen, and AEW runs about three
// weekly tapings a week — so the fifteen are spent before February and every
// PPV falls outside them. Three rounds of workarounds (named-card lookups
// against a hand-written list of recurring names, then two corrections to the
// gate deciding when to run them) and the Upcoming row was still empty or
// carrying the wrong dates.
//
// allelitewrestling.com publishes the schedule. The site is Wix, which embeds
// the page's data as JSON in <script id="wix-warmup-data">, so this reads a
// structured collection rather than scraping markup.
//
// The records below are real, taken from the live pages on 2026-09-12.

const test = require('node:test');
const assert = require('node:assert/strict');
const aew = require('../lib/sources/aew');
const promotions = require('../lib/promotions');

// From /events — the upcoming collection.
const ALL_OUT = {
  _id: '1aff3352-9e38-42eb-904c-b673ee83ea87',
  eventName: 'AEW: All Out', eventType: 'AEW: All Out PPV',
  title: 'AEW All Out 2026', date: 'SEPTEMBER 26, 2026',
  sortByDate: { $date: '2026-09-26T16:00:00.000Z' },
  venue: 'Now Arena', city: 'Chicago, IL', isRoh: false,
  promoImage: 'wix:image://v1/815952_1fdbdfc740bc48faa044640de5ed011a~mv2.jpg/AEW-All-Out-2026-X.jpg#originWidth=1920&originHeight=1080',
};
// From /aewonppv — the replays collection. Different field names for the same
// things, which is the reason the adapter accepts both.
const ALL_IN = {
  _id: 'd0e8310f-1b51-459a-a05c-63b6f1aba33b',
  title: 'AEW All In London 2026', date: 'August 30, 2026', sortBy: '2026-08-30',
  venue: 'Wembley Stadium', city: 'London, England',
  image: 'wix:image://v1/815952_18be2c1621c6454d8c27b5aaa389d6ee~mv2.jpg/AEW-All-In-R7PPV.jpg#originWidth=1920&originHeight=1080',
};

function pageWith(collection, records) {
  const warmup = { appsWarmupData: { dataBinding: { dataStore: { recordsByCollectionId: {} } } } };
  warmup.appsWarmupData.dataBinding.dataStore.recordsByCollectionId[collection] =
    Object.fromEntries(records.map((r) => [r._id, r]));
  return '<html><body><script id="wix-warmup-data">' + JSON.stringify(warmup) + '</script></body></html>';
}

test('an upcoming card parses with AEW’s own local date', () => {
  const [event] = aew.parseEvents(pageWith('AEWEvents', [ALL_OUT]));
  assert.equal(event.date, '2026-09-26',
    'TheSportsDB had this on the 27th; AEW says the 26th, and releases are '
    + 'named by the local date, so the old one was wrong for matching too');
  assert.equal(event.name, 'All Out 2026');
  assert.equal(event.venue, 'Now Arena');
  assert.equal(event.city, 'Chicago, IL');
  assert.deepEqual(event.source, { type: 'aew', eventId: ALL_OUT._id });
});

test('a past card parses from the replays collection, which names things differently', () => {
  const [event] = aew.parseEvents(pageWith('PPVReplays', [ALL_IN]));
  assert.equal(event.date, '2026-08-30', 'sortBy, a plain string, not sortByDate');
  assert.equal(event.name, 'All In London 2026');
  assert.ok(event.poster, 'and `image` rather than `promoImage`');
});

test('the AEW prefix is stripped, because every downstream filter expects it gone', () => {
  // The promotion's weekly-TV filter and its alias builder were both written
  // against unprefixed names. Left prefixed, "AEW Collision Springfield" does
  // not match /^Collision/ and every taping lands in the catalogue.
  assert.equal(aew.eventNameOf({ title: 'AEW Collision Springfield' }), 'Collision Springfield');
  assert.equal(aew.eventNameOf({ title: 'AEW: All Out' }), 'All Out');
  assert.equal(aew.eventNameOf({ eventName: 'AEW Grand Slam: France' }), 'Grand Slam: France');
});

test('the promotion drops weekly TV and fan events, and keeps the cards', () => {
  const promotion = promotions.all.find((p) => p.id === 'aew');
  const keep = (name) => promotion.includeEvent({ name });
  assert.equal(keep('All Out 2026'), true);
  assert.equal(keep('WrestleDream 2026'), true);
  assert.equal(keep('Grand Slam France'), true);
  assert.equal(keep('Fright Night Dynamite Collision'), true, 'a special, not a taping');
  assert.equal(keep('Collision Springfield'), false);
  assert.equal(keep('Dynamite Norfolk'), false);
  assert.equal(keep('Dynamite Collision Indianapolis'), false);
  // AEW's own schedule lists these; TheSportsDB's never did, so the rule
  // arrived with the source that publishes them.
  assert.equal(keep('All Out Afternoon Block Party'), false);
});

test('Ring of Honor shares the CMS and is a different promotion', () => {
  assert.equal(aew.toRaw(Object.assign({}, ALL_OUT, { isRoh: true })), null);
});

test('Wix media URIs become fetchable URLs', () => {
  assert.equal(
    aew.wixImageUrl('wix:image://v1/815952_abc~mv2.jpg/Name-X.jpg#originWidth=1920'),
    'https://static.wixstatic.com/media/815952_abc~mv2.jpg');
  assert.equal(aew.wixImageUrl('https://example.com/a.jpg'), 'https://example.com/a.jpg');
  assert.equal(aew.wixImageUrl(''), null);
  assert.equal(aew.wixImageUrl(null), null);
});

test('the written date is a fallback only, because the live data is not clean', () => {
  // One live record reads "OCTOBER, 21" — no year, stray comma. sortByDate is
  // preferred for exactly this reason.
  assert.equal(aew.parseWrittenDate('SEPTEMBER 26, 2026'), '2026-09-26');
  assert.equal(aew.parseWrittenDate('August 30, 2026'), '2026-08-30');
  assert.equal(aew.parseWrittenDate('OCTOBER, 21'), null);
  assert.equal(aew.parseWrittenDate(''), null);

  const noStamp = { _id: 'x', title: 'AEW Revolution 2026', date: 'March 15, 2026' };
  assert.equal(aew.recordDate(noStamp), '2026-03-15');
  assert.equal(aew.recordDate({ _id: 'y', title: 'AEW Whatever', date: 'OCTOBER, 21' }), null);
  assert.equal(aew.toRaw({ _id: 'y', title: 'AEW Whatever', date: 'OCTOBER, 21' }), null,
    'an event with no usable date is dropped, not dated wrongly');
});

test('a shape change degrades to nothing rather than throwing', () => {
  // The warmup blob is an undocumented implementation detail of somebody's CMS.
  // A refresh must survive it changing.
  assert.deepEqual(aew.parseEvents('<html><body>nothing here</body></html>'), []);
  assert.deepEqual(aew.parseEvents('<script id="wix-warmup-data">not json</script>'), []);
  assert.deepEqual(aew.parseEvents(''), []);
  assert.deepEqual(aew.eventRecordsFrom({}), []);
  assert.deepEqual(aew.eventRecordsFrom(null), []);
});

test('a renamed collection is still found', () => {
  // The key has been AEWEvents, but a CMS collection can be renamed by whoever
  // edits the site. Records that look like events are taken from any collection.
  const [event] = aew.parseEvents(pageWith('SomethingElse', [ALL_OUT]));
  assert.equal(event.name, 'All Out 2026');
});

test('the promotion is wired to the new source, end to end', () => {
  const promotion = promotions.all.find((p) => p.id === 'aew');
  assert.deepEqual(promotion.source, { type: 'aew' });

  // The refresh has to dispatch it and normalise it, or the source returns
  // records that go nowhere.
  const refreshSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scripts', 'refresh.js'), 'utf8');
  assert.match(refreshSource, /promotion\.source\.type === 'aew'/);
  assert.match(refreshSource, /aew\.fetchAll/);

  // TheSportsDB stays available for anyone with a premium key who prefers it.
  const sources = require('../lib/metadata-sources');
  const ids = sources.list().map((item) => item.id);
  assert.ok(ids.includes('aew-official'));
  assert.ok(ids.includes('tsdb-aew'), 'the old source is offered, not deleted');
});

test('a normalised AEW event carries its artwork', () => {
  const transform = require('../lib/transform');
  const promotion = promotions.all.find((p) => p.id === 'aew');
  const event = transform.fromWiki(aew.toRaw(ALL_OUT), promotion);
  assert.equal(event.date, '2026-09-26');
  assert.ok(String(event.poster).startsWith('https://static.wixstatic.com/media/'),
    'TheSportsDB gave AEW no event-level artwork at all');
  assert.equal(event.source.type, 'aew');
});

// ===== The source change broke two things downstream =====
//
// AEW's own schedule names cards WITH the year — "All Out 2026" — where
// TheSportsDB named them "All Out". Better data, and it broke both halves of
// the promotion's matching, because both were written assuming the year was
// absent.

test('a year already in the name does not collapse the query list', () => {
  // The builder only added a query when the year was MISSING, so a card named
  // "All Out 2026" produced exactly one string and that was everything the
  // indexers were ever asked.
  const promotion = promotions.all.find((p) => p.id === 'aew');
  const queries = promotion.searchTitles({ name: 'All Out 2026', date: '2026-09-26' });
  assert.ok(queries.length >= 3, 'got: ' + JSON.stringify(queries));
  assert.equal(queries[0], 'AEW All Out 2026', 'the observed release shape leads');
  assert.ok(queries.includes('AEW All Out'), 'plenty of releases omit the year');
  assert.ok(queries.includes('All Out 2026'), 'and some lead with the card name');

  // A card with no year in its name reaches the same place from the other side.
  const undated = promotion.searchTitles({ name: 'Grand Slam France', date: '2026-10-06' });
  assert.ok(undated.includes('AEW Grand Slam France 2026'));
  assert.ok(undated.includes('AEW Grand Slam France'));
});

test('the matcher requires the card name, not merely a long word from it', () => {
  const promotion = promotions.all.find((p) => p.id === 'aew');
  const event = { name: 'All Out 2026', date: '2026-09-26' };
  const ok = (t) => assert.equal(promotion.isRelevantStreamTitle(t, event).ok, true, t);
  const no = (t) => assert.equal(promotion.isRelevantStreamTitle(t, event).ok, false, t);

  ok('AEW.All.Out.2026.PPV.1080p.WEB.h264-HEEL');
  ok('AEW All Out 2026 1080p');
  ok('AEW.All.Out.1080p.WEB');

  // The old rule kept words of four characters or more and accepted the title
  // if ANY of them appeared — and returned ok for anything AEW when none
  // survived the filter. "All Out" has no word that long, so every AEW release
  // matched it; once the source added the year, the only token left was "2026"
  // and Full Gear matched an All Out fixture.
  no('AEW.Full.Gear.2026.1080p');
  no('AEW.All.In.London.2026.1080p');
  no('AEW.Dynamite.2026.09.16.1080p');
  // Still year-precise, and still AEW-only.
  no('AEW.All.Out.2025.1080p');
  no('WWE.All.Out.2026');
});
