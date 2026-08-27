'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const aliases = require('../lib/promotion-aliases');
const { createGenericPromotion } = require('../lib/promotions');
const adminPromotions = require('../lib/admin-promotions');

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

test('promotions form emits valid browser JavaScript for the alias assistant', () => {
  const html = adminPromotions.renderBody({});
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script[1])); // eslint-disable-line no-new-func
  assert.match(html, /id="deriveAliases"/);
  assert.match(html, /name="promotionAliases"/);
  assert.match(html, /name="exclusionKeywords"/);
  assert.match(html, /id="previewMatching"/);
  assert.match(html, /Help SSS recognize releases/);
  assert.match(html, /Add it under Metadata/);
  assert.match(html, /name="sourceRef"/);
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
