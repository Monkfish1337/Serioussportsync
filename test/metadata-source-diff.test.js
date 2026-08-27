'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const diff = require('../lib/metadata-source-diff');

function event(sourceId, name, date) {
  return {
    id: 'demo:' + sourceId, sourceId, promotion: 'demo', name, date,
    time: '12:00:00', venue: null, source: { type: 'mlb' },
  };
}

test('classifies added, updated, unchanged, and removed promotion events', async () => {
  const promotion = {
    id: 'demo', idPrefix: 'demo', name: 'Demo', source: { type: 'mlb' },
    classify: () => 'event', buildAliases: () => [], genres: () => [], includeEvent: () => true,
  };
  const before = [event('1', 'Cubs vs Diamondbacks', '2026-08-26'),
    event('2', 'Old title', '2026-08-27'), event('3', 'Removed game', '2026-08-28')];
  const after = [event('1', 'Cubs vs Diamondbacks', '2026-08-26'),
    event('2', 'Corrected title', '2026-08-27'), event('4', 'Added game', '2026-08-29')];
  const result = await diff.compare(promotion, {
    id: 'mlb-official', name: 'Official MLB', source: { type: 'mlb' },
  }, before, {
    fetchPromotion: async () => after,
    normalizeRecord: (raw) => raw,
    inScope: () => true,
  });
  assert.deepEqual(result.counts, {
    before: 3, after: 3, added: 1, updated: 1, unchanged: 1, removed: 1,
  });
  assert.equal(result.samples.added[0].name, 'Added game');
  assert.equal(result.samples.updated[0].name, 'Corrected title');
  assert.equal(result.samples.removed[0].name, 'Removed game');
});

test('source-diff errors redact provider credentials', () => {
  const message = diff.safeError(new Error(
    'https://www.thesportsdb.com/api/v1/json/premium-key/events?apikey=secret-token'
  ));
  assert.doesNotMatch(message, /premium-key|secret-token/);
});

test('counts same-title doubleheaders independently', async () => {
  const promotion = { id: 'demo', name: 'Demo', source: { type: 'mlb' }, includeEvent: () => true };
  const gameOne = event('10', 'Guardians vs Reds', '2026-08-26');
  const gameTwo = event('11', 'Guardians vs Reds', '2026-08-26');
  const result = await diff.compare(promotion, { id: 'mlb', name: 'MLB', source: { type: 'mlb' } },
    [gameOne], { fetchPromotion: async () => [gameOne, gameTwo], normalizeRecord: (raw) => raw, inScope: () => true });
  assert.equal(result.counts.unchanged, 1);
  assert.equal(result.counts.added, 1);
});
