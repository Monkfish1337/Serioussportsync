'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const aliases = require('../lib/promotion-aliases');
const { createGenericPromotion } = require('../lib/promotions');
const adminPromotions = require('../lib/admin-promotions');
const customPromotions = require('../lib/custom-promotions');

test('derives stable F1 aliases while removing release noise', () => {
  const result = aliases.derivePromotionAliases('Formula 1', [
    'Formula.1.2026.Dutch.Grand.Prix.1080p.WEB-DL.H264-GROUP',
    'F1.2026.Dutch.GP.Qualifying.2160p.UHD-GROUP',
  ]);
  assert.deepEqual(result, ['Formula 1', 'F1', 'Formula1']);
});

test('retains a stable named series but drops its changing event number', () => {
  const result = aliases.derivePromotionAliases('Ultimate Fighting Championship', [
    'UFC.Fight.Night.285.Hernandez.vs.Rodrigues.1080p.WEB-DL.H264',
    'UFC.Fight.Night.286.Smith.vs.Jones.720p.WEBRip',
  ]);
  assert.deepEqual(result, ['Ultimate Fighting Championship', 'UFC', 'UFC Fight Night']);
});

test('suggested keywords mirror aliases in lower case', () => {
  const result = aliases.suggestPromotionSetup('Formula 1', 'F1.2026.Dutch.GP.1080p');
  assert.deepEqual(result.keywords, ['formula 1', 'f1', 'formula1']);
});

test('derives exclusions that distinguish known-bad releases', () => {
  const result = aliases.suggestPromotionSetup(
    'Formula 1',
    ['F1.2026.Dutch.Grand.Prix.1080p'],
    ['Formula.2.2026.Dutch.Grand.Prix.1080p', 'F1.Academy.2026.Round.4.720p']
  );
  assert.ok(result.exclusions.includes('Formula 2'));
  assert.ok(result.exclusions.includes('academy'));
  assert.ok(!result.exclusions.includes('1080p'));
});

test('learns a promotion-date-event search layout from release examples', () => {
  const templates = aliases.deriveSearchTitleTemplates('Major League Baseball', [
    'MLB.2026.08.25.Pittsburgh.Pirates.vs.San.Diego.Padres.1080p.WEB.h264',
  ]);
  assert.equal(templates[0], '{promotion} {date_spaced} {name}');
});

test('does not learn an event stage as part of a promotion alias', () => {
  const result = aliases.derivePromotionAliases('Champions League', [
    'UEFA.Champions.League.FINAL.2026.05.30.PSG.vs.Arsenal.1080p.HDTV',
  ]);
  assert.ok(result.includes('UEFA Champions League'));
  assert.ok(!result.some((alias) => /\bfinal\b/i.test(alias)));
});

test('football fixture matching requires both selected teams', () => {
  const promotion = createGenericPromotion({
    id: 'ucl-test', name: 'Champions League', source: 'football-data', competitionId: 'CL',
    searchTitleTemplates: ['{promotion} {date_spaced} {name}'],
    relevanceKeywords: ['ucl', 'champions league'], promotionAliases: ['UCL', 'Champions League'],
    requireDateInTitle: false,
  });
  const event = { name: 'Bayern München vs PSG', date: '2026-05-06' };
  assert.equal(promotion.isRelevantStreamTitle('real-madrid-ucl-knockout-stages', event).reason, 'no-home-team');
  assert.equal(promotion.isRelevantStreamTitle('UCL FINAL 2025-2026 PSG - ARSENAL', event).reason, 'no-home-team');
  assert.equal(promotion.isRelevantStreamTitle('Bayern München vs PSG 06.05.2026.mkv', event).ok, true);
});

test('two-digit football dates reject an old repeat fixture', () => {
  const promotion = createGenericPromotion({
    id: 'ucl-test', name: 'Champions League', source: 'football-data', competitionId: 'CL',
    searchTitleTemplates: ['{name}'], relevanceKeywords: ['ucl'], requireDateInTitle: false,
  });
  const event = { name: 'Bayern München vs PSG', date: '2026-05-06' };
  const result = promotion.isRelevantStreamTitle('ICC18 - Bayern München vs PSG 21.07.18', event);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong-date');
});

test('removes reject words that contradict promotion identity', () => {
  const rules = aliases.sanitizeMatchingRules(
    'Major League Baseball', ['MLB'], ['major league baseball', 'mlb'], ['mlb', 'network']
  );
  assert.deepEqual(rules.exclusions, ['network']);
  assert.deepEqual(rules.removedExclusions, ['mlb']);
});

test('generic promotion repairs an MLB conflict and generates the observed release query', () => {
  const promotion = createGenericPromotion({
    id: 'baseball-test',
    name: 'Major League Baseball',
    source: 'mlb',
    searchTitleTemplates: ['{promotion} {date_spaced} {name}', '{name}'],
    relevanceKeywords: ['major league baseball', 'mlb'],
    promotionAliases: ['Major League Baseball', 'MLB'],
    exclusionKeywords: ['mlb', 'network'],
  });
  const event = { name: 'San Diego Padres vs Pittsburgh Pirates', date: '2026-08-25' };
  assert.ok(promotion.searchTitles(event).includes('MLB 2026 08 25 Pittsburgh Pirates vs San Diego Padres'));
  assert.deepEqual(promotion.ignoredExclusionKeywords, ['mlb']);
  assert.equal(promotion.isRelevantStreamTitle(
    'MLB 2026 08 25 Pittsburgh Pirates vs San Diego Padres 1080p WEB h264', event
  ).ok, true);
});

test('stored promotion validation prevents contradictory reject rules', () => {
  const verdict = customPromotions.validateSpec({
    id: 'baseball-test', name: 'Major League Baseball', source: 'mlb',
    searchTitleTemplates: ['{name}'], relevanceKeywords: ['mlb'],
    promotionAliases: ['MLB'], exclusionKeywords: ['mlb'],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /conflict/i);
});

test('saved aliases generate queries and participate in relevance matching', () => {
  const promotion = createGenericPromotion({
    id: 'test-f1',
    name: 'Formula 1',
    leagueId: '4370',
    searchTitleTemplates: ['{name} {year}'],
    relevanceKeywords: ['formula 1'],
    promotionAliases: ['F1'],
  });
  const event = { name: 'Formula 1 Dutch Grand Prix', date: '2026-08-23' };
  assert.ok(promotion.searchTitles(event).includes('F1 Dutch Grand Prix'));
  assert.equal(promotion.isRelevantStreamTitle('F1.2026.Dutch.Grand.Prix.1080p', event).ok, true);
});

test('promotions wizard emits valid browser JavaScript and keeps expert tools optional', () => {
  const listHtml = adminPromotions.renderBody({});
  assert.match(listHtml, /Create promotion/);
  assert.match(listHtml, /id="promotionWizard" hidden/);
  const html = adminPromotions.renderBody({ create: true });
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script[1])); // eslint-disable-line no-new-func
  assert.equal((html.match(/data-wizard-panel=/g) || []).length, 5);
  assert.match(html, /What should users see/);
  assert.match(html, /Where do event names and dates come from/);
  assert.match(html, /Add real release titles/);
  assert.match(html, /Create provider in Metadata/);
  assert.doesNotMatch(html, /name="sourceMode" value="provider"/);
  assert.match(html, /Advanced search patterns/);
  assert.match(html, /id="deriveAliases"/);
  assert.match(html, /name="promotionAliases"/);
  assert.match(html, /name="exclusionKeywords"/);
  assert.match(html, /id="previewMatching"/);
  assert.match(html, /id="researchAliases"/);
  assert.match(html, /alias-research/);
  assert.match(html, /name="sourceRef"/);
  assert.match(html, /Preview refresh/);
  assert.match(html, /source-preview/);
  assert.match(html, /event-diff-confirm[^>]+disabled/);
});

test('matching preview shows generated queries and good/bad verdicts', () => {
  const result = adminPromotions.previewMatching({
    name: 'Formula 1',
    eventName: 'Formula 1 Dutch Grand Prix',
    eventDate: '2026-08-23',
    searchTitleTemplates: '{name}\n{name} {year}',
    relevanceKeywords: 'formula 1',
    promotionAliases: 'F1',
    exclusionKeywords: 'formula 2, academy',
    goodExamples: 'F1.2026.Dutch.Grand.Prix.1080p',
    badExamples: 'F1.Academy.2026.Dutch.Grand.Prix.720p',
  });
  assert.equal(result.ok, true);
  assert.ok(result.queries.includes('F1 Dutch Grand Prix'));
  assert.deepEqual(result.examples.map((item) => item.accepted), [true, false]);
  assert.equal(result.examples[1].reason, 'excluded:academy');
});

test('matching preview reports and repairs conflicting reject words', () => {
  const result = adminPromotions.previewMatching({
    name: 'Major League Baseball',
    eventName: 'San Diego Padres vs Pittsburgh Pirates',
    eventDate: '2026-08-25',
    searchTitleTemplates: '{promotion} {date_spaced} {name}',
    relevanceKeywords: 'major league baseball, mlb',
    promotionAliases: 'Major League Baseball\nMLB',
    exclusionKeywords: 'mlb, network',
    goodExamples: 'MLB.2026.08.25.Pittsburgh.Pirates.vs.San.Diego.Padres.1080p.WEB.h264',
  });
  assert.deepEqual(result.warnings, ['mlb']);
  assert.equal(result.examples[0].accepted, true);
});

test('native indexer release finder applies expansive filters and sorting without exposing NZBs', async () => {
  let capturedQueries;
  const result = await adminPromotions.searchReleaseExamples({
    diySearchKind: 'newznab', diySearchName: 'Hydra', diySearchUrl: 'http://hydra:5076',
    diySearchApiKey: 'secret-key',
  }, {
    query: 'MLB; Cubs Diamondbacks', includeTerms: 'MLB', excludeTerms: 'network',
    quality: '1080p', indexerName: 'geek', maxAgeDays: '30', minSizeGb: '1',
    maxSizeGb: '20', sort: 'largest', limit: '20',
  }, {
    now: Date.parse('2026-08-27T12:00:00Z'),
    search: async (queries, provider, options) => {
      capturedQueries = queries;
      assert.equal(provider.enabled, true);
      assert.equal(options.maxQueries, 5);
      return { ok: true, results: [
        { title: 'MLB 2026 08 26 Cubs vs Diamondbacks 1080p', size: 8 * 1024 ** 3, publishedAt: '2026-08-26T12:00:00Z', indexer: 'NZBGeek', nzbUrl: 'https://secret/nzb/1' },
        { title: 'MLB Network Daily Show 1080p', size: 10 * 1024 ** 3, publishedAt: '2026-08-26T12:00:00Z', indexer: 'NZBGeek', nzbUrl: 'https://secret/nzb/2' },
        { title: 'MLB 2026 08 25 Padres vs Pirates 720p', size: 5 * 1024 ** 3, publishedAt: '2026-08-25T12:00:00Z', indexer: 'NZBGeek', nzbUrl: 'https://secret/nzb/3' },
      ] };
    },
  });
  assert.deepEqual(capturedQueries, ['MLB', 'Cubs Diamondbacks']);
  assert.equal(result.total, 1);
  assert.equal(result.results[0].title, 'MLB 2026 08 26 Cubs vs Diamondbacks 1080p');
  assert.equal(result.results[0].sizeLabel, '8.0 GB');
  assert.ok(!Object.hasOwn(result.results[0], 'nzbUrl'));
  assert.doesNotMatch(JSON.stringify(result), /secret-key|secret\/nzb/);
});

test('release finder explains when native indexer settings are absent', async () => {
  const result = await adminPromotions.searchReleaseExamples({}, { query: 'MLB' });
  assert.equal(result.ok, false);
  assert.match(result.error, /DIY Discover/);
});

test('alias research combines configured sources, explains decisions, and strips secrets', async () => {
  const result = await adminPromotions.researchAliases({
    diySearchKind: 'prowlarr', diySearchName: 'Prowlarr',
    diySearchUrl: 'http://prowlarr:9696', diySearchApiKey: 'native-secret',
    uuManifestUrl: 'http://usenet-ultimate:1337/stremio/private-config/manifest.json',
    easynewsUsername: 'alice', easynewsPassword: 'easynews-secret',
  }, {
    name: 'UEFA Champions League', eventName: 'LASK vs Celtic FC', eventDate: '2026-08-25',
    query: 'UEFA Champions League 2026.08.25 LASK vs Celtic',
    promotionAliases: 'UEFA Champions League\nUCL',
    relevanceKeywords: 'uefa champions league, ucl',
    searchTitleTemplates: '{promotion} {date_dotted} {name}', requireDateInTitle: '1',
  }, {
    nativeSearch: async (queries, provider, options) => {
      assert.ok(queries.length > 0 && queries.length <= 3);
      assert.equal(provider.apiKey, 'native-secret');
      assert.equal(options.maxQueries, 3);
      return { ok: true, results: [{
        title: 'UEFA.Champions.League.2026.08.25.LASK.vs.Celtic.FC.1080p.WEB',
        indexer: 'NZBGeek', size: 8 * 1024 ** 3, nzbUrl: 'https://secret/native.nzb',
      }] };
    },
    uuSearch: async () => ({ ok: true, results: [{
      title: 'UEFA.Champions.League.2026.08.25.LASK.vs.Celts.720p',
      indexer: 'DrunkenSlug', nzbUrl: 'https://secret/uu.nzb',
    }] }),
    easynewsSearch: async (_queries, options) => {
      assert.equal(options.password, 'easynews-secret');
      return { ok: false, error: 'network timeout at https://members.easynews.com/private?token=secret', results: [] };
    },
    companionConfig: { url: 'http://companion:8080', authToken: 'companion-secret' },
    companionSearch: async (input) => {
      assert.equal(input.throwOnFailure, true);
      assert.ok(input.searchTitles.length > 0 && input.searchTitles.length <= 3);
      return [{
        title: 'UEFA.Champions.League.2026.08.25.LASK.vs.Celtic.FC.2160p.WEB',
        infoHash: 'a'.repeat(40), magnetTrackers: ['https://tracker.secret/announce'],
        size: 20 * 1024 ** 3, publishDate: '2026-08-26T00:00:00Z',
      }];
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { discovered: 3, matched: 2, possible: 1, rejected: 0 });
  assert.equal(result.groups.matched[0].reason, 'matched');
  assert.match(result.groups.possible[0].reason, /away-team/);
  assert.equal(result.providers.find((provider) => provider.id === 'easynews').error, 'Timed out or unavailable');
  assert.ok(result.suggested.aliases.length > 0);
  assert.equal(result.providers.find((provider) => provider.id === 'companion').count, 1);
  assert.doesNotMatch(JSON.stringify(result), /native-secret|easynews-secret|companion-secret|private-config|secret\/.*nzb|members\.easynews|infoHash|magnetTrackers|tracker\.secret/);
});

test('alias research requires an event and at least one configured source', async () => {
  assert.match((await adminPromotions.researchAliases({}, { name: 'UCL' })).error, /event/i);
  const result = await adminPromotions.researchAliases({}, {
    name: 'UCL', eventName: 'LASK vs Celtic', eventDate: '2026-08-25',
  }, { companionConfig: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /Configure/);
});

test('editing a legacy embedded MLB promotion does not fall back to TSDB validation', () => {
  const originalUpdate = customPromotions.update;
  const originalAssign = require('../lib/metadata-sources').assign;
  const originalReload = require('../lib/promotions').reload;
  let saved;
  customPromotions.update = (_id, spec) => { saved = spec; return spec; };
  require('../lib/metadata-sources').assign = () => null;
  require('../lib/promotions').reload = () => null;
  try {
    adminPromotions.saveFromForm({
      id: 'mlb', name: 'MLB', sourceRef: '', promotionAliases: 'MLB',
      relevanceKeywords: 'mlb', exclusionKeywords: 'mlb',
      searchTitleTemplates: '{promotion} {date_spaced} {name}', posterShape: 'landscape',
    }, { updateId: 'mlb', existingSpec: { id: 'mlb', name: 'MLB', source: 'mlb' } });
    assert.equal(saved.source, 'mlb');
    assert.equal(saved.leagueId, undefined);
    assert.deepEqual(saved.exclusionKeywords, []);
  } finally {
    customPromotions.update = originalUpdate;
    require('../lib/metadata-sources').assign = originalAssign;
    require('../lib/promotions').reload = originalReload;
  }
});

test('new football-data promotions automatically require fixture dates', () => {
  const originalAdd = customPromotions.add;
  const originalAssign = require('../lib/metadata-sources').assign;
  const originalReload = require('../lib/promotions').reload;
  let saved;
  customPromotions.add = (spec) => { saved = spec; return spec; };
  require('../lib/metadata-sources').assign = () => null;
  require('../lib/promotions').reload = () => null;
  try {
    adminPromotions.saveFromForm({
      id: 'ucl-test', name: 'Champions League', source: 'football-data',
      competitionId: 'CL', promotionAliases: 'UCL', relevanceKeywords: 'ucl',
      searchTitleTemplates: '{promotion} {date_spaced} {name}', posterShape: 'landscape',
      requireDateMode: 'auto',
    });
    assert.equal(saved.requireDateInTitle, true);
  } finally {
    customPromotions.add = originalAdd;
    require('../lib/metadata-sources').assign = originalAssign;
    require('../lib/promotions').reload = originalReload;
  }
});
