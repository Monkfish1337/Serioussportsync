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
  // `unseen` counts events a deliberately truncated preview did not fetch, as
  // distinct from ones the source genuinely dropped. This fixture is an `mlb`
  // source, which has no skippable path, so the fetch is complete and a missing
  // event really is a removal.
  assert.deepEqual(result.counts, {
    before: 3, after: 3, added: 1, updated: 1, unchanged: 1, removed: 1, unseen: 0,
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

// ===== A preview cannot speak about removals =====
//
// Reported as "AEW still looks broken", with a Preview refresh reading:
//
//   After refresh: 3 events · +0 added · ~0 updated · =0 unchanged · 29 removed
//   Removed: 2026-08-30 All In London | 2026-10-26 Redemption | ...
//
// Nothing was removed — a preview writes nothing. But the number was not a
// prediction either: the preview asks the list endpoints ONLY, skipping the
// named-card lookups and the per-round walk, which is where most of AEW's
// events come from. It compared a deliberately truncated fetch against the full
// store and called the difference deletions, for cards a real refresh fetches
// without trouble.

test('a TheSportsDB preview reports unseen events, never removed ones', async () => {
  const promotion = {
    id: 'aew', name: 'AEW', idPrefix: 'aew',
    classify: () => 'ppv', buildAliases: () => [], genres: () => [],
    includeEvent: () => true,
  };
  const definition = { id: 'tsdb-aew', name: 'TheSportsDB · AEW', source: { type: 'thesportsdb', leagueId: '4563' } };
  const existing = [
    { promotion: 'aew', name: 'All In London', date: '2026-08-30', sourceId: '2391901', source: { type: 'thesportsdb' } },
    { promotion: 'aew', name: 'Redemption', date: '2026-10-26', sourceId: '2499459', source: { type: 'thesportsdb' } },
  ];
  const out = await diff.compare(promotion, definition, existing, {
    // One event back, standing in for the truncated list-endpoint fetch.
    fetchPromotion: async () => ([{ sourceId: '9', name: 'Collision #161', date: '2026-09-13' }]),
    normalizeRecord: (raw) => ({
      id: 'aew:' + raw.sourceId, promotion: 'aew', sourceId: raw.sourceId,
      name: raw.name, date: raw.date, source: { type: 'thesportsdb' },
    }),
    inScope: () => true,
  });

  assert.equal(out.partial, true);
  assert.equal(out.counts.removed, 0, 'a truncated fetch has nothing to say about removals');
  assert.equal(out.counts.unseen, 2);
  assert.deepEqual(out.samples.removed, []);
  assert.equal(out.samples.unseen.length, 2, 'still shown, just not as deletions');
  assert.match(String(out.partialNote), /skips/);
});

test('a source with no skippable path still reports removals honestly', async () => {
  const promotion = {
    id: 'epl', name: 'Premier League', idPrefix: 'epl',
    classify: () => 'match', buildAliases: () => [], genres: () => [],
    includeEvent: () => true,
  };
  const definition = { id: 'fd-epl', name: 'football-data', source: { type: 'football-data', competitionId: 'PL' } };
  const existing = [
    { promotion: 'epl', name: 'Arsenal vs Chelsea', date: '2026-09-01', sourceId: '1', source: { type: 'football-data' } },
  ];
  const out = await diff.compare(promotion, definition, existing, {
    fetchPromotion: async () => ([]),
    normalizeRecord: () => null,
    inScope: () => true,
  });
  assert.equal(out.partial, false);
  assert.equal(out.counts.removed, 1, 'a complete fetch that lost an event IS a removal');
  assert.equal(out.counts.unseen, 0);
  assert.equal(out.partialNote, null);
});

test('the preview UI drops the removed count when the fetch was partial', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'admin-promotions.js'), 'utf8');
  assert.match(source, /if\(!result\.partial\)head\+=' · -'\+c\.removed\+' removed'/);
  assert.match(source, /Not seen by this preview/);
});
