'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');
const transform = require('../lib/transform');
const refresh = require('../scripts/refresh');
const tsdb = require('../lib/sources/thesportsdb');
const admin = require('../lib/admin-promotions');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const byId = (id) => promotions.all.find((promotion) => promotion.id === id);

test('weekly wrestling programs have separate promotions and no premium-card overlap', () => {
  const cases = [
    ['wwe-raw', 'RAW #1702 Raw Is Stranger Things', 'wwe'],
    ['wwe-smackdown', 'SmackDown #1376', 'wwe'],
    ['wwe-nxt', 'NXT #819 New Years Evil', 'wwe'],
    ['aew-dynamite', 'Dynamite #327', 'aew'],
    ['aew-collision', 'Collision #126', 'aew'],
  ];
  for (const [id, rawName, parent] of cases) {
    const promotion = byId(id);
    assert.ok(promotion, id);
    const event = transform.fromTsdb({ idEvent: '1', strEvent: rawName, dateEvent: '2026-09-20' }, promotion);
    assert.equal(promotion.includeEvent(event), true, id);
    assert.equal(byId(parent).includeEvent({ name: rawName }), false, parent + ' duplicates ' + rawName);
    assert.ok(promotion.catalogs.length >= 2);
    assert.equal(refresh.inScope({ date: '2025-12-31' }, promotion), false);
  }
  assert.equal(byId('wwe-nxt').includeEvent({ name: 'NXT Heatwave' }), false);
  assert.equal(byId('wwe').includeEvent({ name: 'NXT Heatwave' }), true);
});

test('weekly wrestling shows recompute the US Eastern air date instead of TSDB\'s UTC date', () => {
  const cases = [
    ['wwe-raw', 'RAW #1736', '2026-09-01', '00:00:00', '2026-08-31'],
    ['wwe-smackdown', 'SmackDown #1400', '2026-09-05', '00:00:00', '2026-09-04'],
    ['wwe-nxt', 'NXT #825', '2026-09-10', '01:00:00', '2026-09-09'],
    ['aew-dynamite', 'Dynamite #340', '2026-09-11', '00:00:00', '2026-09-10'],
    ['aew-collision', 'Collision #130', '2026-09-14', '00:00:00', '2026-09-13'],
  ];
  for (const [id, rawName, dateEvent, strTime, expectedDate] of cases) {
    const promotion = byId(id);
    const event = transform.fromTsdb({ idEvent: '1', strEvent: rawName, dateEvent, strTime }, promotion);
    assert.equal(event.date, expectedDate, id);
    assert.equal(event.dateLocal, expectedDate, id);
  }
  // The bare (name, date) call made by the cached-event repair sweep in
  // scripts/refresh.js carries no raw record — must no-op rather than
  // re-deriving (and potentially re-shifting) an already-corrected date.
  const raw = byId('wwe-raw');
  assert.equal(raw.correctDate('RAW #1736', '2026-08-31'), '2026-08-31');
});

test('weekly release matching requires the right show and date', () => {
  const promotion = byId('wwe-raw');
  const event = { name: 'WWE Raw #1739', date: '2026-09-21' };
  assert.equal(promotion.searchTitles(event)[0], 'WWE Raw 2026 09 21');
  assert.equal(promotion.isRelevantStreamTitle('WWE.RAW.2026.09.21.1080p', event).ok, true);
  assert.equal(promotion.isRelevantStreamTitle('WWE.NXT.2026.09.21.1080p', event).ok, false);
  assert.equal(promotion.isRelevantStreamTitle('WWE.RAW.2026.09.14.1080p', event).ok, false);
  assert.equal(promotion.isRelevantStreamTitle('WWE.RAW.1080p', event).ok, false);
  const smackdown = byId('wwe-smackdown');
  assert.equal(smackdown.searchTitles({name:'WWE SmackDown #1413',date:'2026-09-18'})[0],
    'WWE SmackDown 2026 09 18');
  assert.equal(smackdown.isRelevantStreamTitle(
    'WWE.Friday.Night.Smackdown.2026.09.18.1080p.WEB.h264-TRB',
    {name:'WWE SmackDown #1413',date:'2026-09-19'}).ok, true);
  assert.equal(smackdown.isRelevantStreamTitle('WWE.RAW.2026.09.18.1080p',
    {name:'WWE SmackDown #1413',date:'2026-09-18'}).ok, false);
});

test('weekly matching lab keeps date strict and permits a targeted research search', async () => {
  const html = admin.renderMatchingLab('wwe-smackdown');
  assert.match(html, /id="lab-date"[^>]*checked/);
  assert.match(html, /id="lab-query"/);
  assert.match(html, /body\.append\('query',document\.getElementById\('lab-query'\)\.value\)/);
  const settings = require('../lib/settings');
  const original = {bm:settings.getBitmagnet, pw:settings.getProwlarr};
  settings.getBitmagnet = () => ({enabled:false});
  settings.getProwlarr = () => ({url:'http://prowlarr:9696',apiKey:'test-key',enabled:true,liveSearchEnabled:false});
  try {
    const result = await admin.researchAliases({}, {
      promotionId:'wwe-smackdown',name:'WWE SmackDown',eventName:'WWE SmackDown #1413',
      eventDate:'2026-09-19',query:'WWE Friday Night SmackDown 2026 09 18',
    }, {
      companionConfig:{},
      prowlarrSearch:async (queries) => {
        assert.equal(queries[0], 'WWE Friday Night SmackDown 2026 09 18');
        return {ok:true,results:[
          {title:'WWE.Friday.Night.Smackdown.2026.09.18.1080p.WEB.h264-TRB'},
          {title:'WWE.Friday.Night.Smackdown.2026.08.18.1080p.WEB.h264-TRB'},
          {title:'WWE.Friday.Night.Smackdown.2026.09.18.German.1080p.WEB.h264-SPORTY'},
        ]};
      },
    });
    assert.equal(result.counts.matched, 1);
    assert.equal(result.counts.possible, 1);
    assert.equal(result.groups.possible[0].reason, 'wrong-date');
    assert.equal(result.counts.rejected, 1);
    assert.equal(result.groups.rejected[0].reason, 'foreign-language');
  } finally {
    settings.getBitmagnet = original.bm;
    settings.getProwlarr = original.pw;
  }
});

test('matching lab samples the displayed local date from older weekly records', () => {
  const store = require('../lib/store');
  const original = store.getEvents;
  store.getEvents = () => [{ id:'wwe-raw:2579121', promotion:'wwe-raw',
    name:'WWE Raw #1736', date:'2026-09-01', dateLocal:'2026-08-31' }];
  try {
    const html = admin.renderMatchingLab('wwe-raw');
    assert.match(html, /data-date="2026-08-31">2026-08-31 · WWE Raw #1736/);
  } finally {
    store.getEvents = original;
  }
});

test('a saved weekly rule cannot weaken the show and date identity checks', () => {
  const overrides = require('../lib/promotion-overrides');
  const original = overrides.find;
  overrides.find = (id) => id === 'wwe-raw' ? {
    promotionId:id,promotionAliases:['WWE Raw','WWE NXT','WR','WWE Monday Night Raw S34E36'],
    relevanceKeywords:['wwe','WR','WWE Monday Night Raw S34E36'],searchTitleTemplates:['{name}'],
    exclusionKeywords:[],requireDateInTitle:false,
  } : null;
  try {
    promotions.reload();
    const promotion = byId('wwe-raw');
    const event = {name:'WWE Raw #1739',date:'2026-09-21'};
    assert.equal(promotion.isRelevantStreamTitle('WWE.RAW.2026.09.21.1080p',event).ok,true);
    assert.equal(promotion.isRelevantStreamTitle('WWE.RAW.1080p',event).ok,false);
    assert.equal(promotion.isRelevantStreamTitle('WWE.NXT.2026.09.21.1080p',event).ok,false);
    assert.equal(promotion.searchTitles(event).some((title) => /\bWR\b|S34E36/i.test(title)), false);
  } finally {
    overrides.find = original;
    promotions.reload();
  }
});

test('weekly saved rules discard one-episode aliases before saving', () => {
  const overrides = require('../lib/promotion-overrides');
  const cleaned = overrides.sanitizeWeekly({
    promotionAliases:'WWE Raw\nWR\nWWE Monday Night Raw S34E36',
    relevanceKeywords:'wwe raw, WR, wwe monday night raw s34e36',
    searchTitleTemplates:'{name}\nWWE Raw S34E36 {date_spaced}',
  });
  assert.deepEqual(cleaned.promotionAliases, ['WWE Raw', 'WWE Monday Night Raw']);
  assert.deepEqual(cleaned.relevanceKeywords, ['wwe raw', 'wwe monday night raw']);
  assert.equal(cleaned.searchTitleTemplates.some((value) => /S34E36/i.test(value)), false);
});

test('the promotion page exposes each metadata start date, including WWE default', () => {
  const html = admin.renderBody({ events: [] });
  assert.match(html, /action="\/admin\/promotions\/wwe\/metadata-start-date"/);
  assert.match(html, new RegExp('Metadata from ' + new Date().getUTCFullYear() + '-01-01'));
  assert.match(html, /action="\/admin\/promotions\/wwe-raw\/metadata-start-date"/);
});

test('metadata start dates persist per promotion and reject invalid dates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-metadata-start-'));
  try {
    const file = path.join(dir, 'settings.json');
    const script = `
      const assert = require('node:assert/strict');
      const settings = require('./lib/settings');
      const promotions = require('./lib/promotions');
      settings.setPromotionMetadataStartDate('wwe', '2026-09-01');
      promotions.reload();
      assert.equal(promotions.all.find(p => p.id === 'wwe').metadataStartDate, '2026-09-01');
      assert.throws(() => settings.setPromotionMetadataStartDate('wwe', '2026-02-30'), /real date/);
      settings.setPromotionMetadataStartDate('wwe', '');
      promotions.reload();
      assert.equal(promotions.all.find(p => p.id === 'wwe').metadataStartDate,
        new Date().getUTCFullYear() + '-01-01');
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, SETTINGS_FILE: file }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one refresh reuses TSDB league results for sibling weekly promotions', async () => {
  const original = tsdb.fetchAll;
  const cache = new Map();
  let calls = 0;
  let requested;
  try {
    tsdb.fetchAll = async (options) => { calls++; requested = options; return []; };
    await refresh.refreshPromotion(byId('wwe'), () => {}, { sourceCache: cache });
    await refresh.refreshPromotion(byId('wwe-raw'), () => {}, { sourceCache: cache });
    await refresh.refreshPromotion(byId('wwe-smackdown'), () => {}, { sourceCache: cache });
  } finally { tsdb.fetchAll = original; }
  assert.equal(calls, 1);
  assert.equal(requested.startDate, new Date().getUTCFullYear() + '-01-01');
  assert.ok(requested.seasons.every((season) => Number(String(season).slice(-4)) >= new Date().getUTCFullYear()));
});

test('date-aware round seek skips old TSDB episodes with bounded probes', async () => {
  const calls = [];
  const base = Date.parse('2026-01-01T00:00:00Z');
  const day = (round) => new Date(base + round * 86400000).toISOString().slice(0, 10);
  const startDate = day(190);
  const events = await tsdb.fetchSeasonAllRounds('4444', '2026', () => {}, 0, {
    startDate, dateOrderedRounds: true,
    fetchRound: async (_league, _season, round) => {
      calls.push(round);
      return round <= 200 ? [{ idEvent: String(round), dateEvent: day(round), strEvent: 'RAW #' + round }] : [];
    },
    pause: async () => {},
  });
  assert.ok(calls.length < 35, 'expected a seek, got ' + calls.length + ' requests');
  assert.ok(events.length > 0);
  assert.ok(events.every((event) => event.dateEvent >= startDate));
  assert.equal(events[0].dateEvent, startDate);
});
