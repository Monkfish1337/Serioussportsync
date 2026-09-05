'use strict';

// Deselecting a team takes its catalog out of the manifest without throwing
// anything away.
//
// The behaviour being fixed: a team catalog, once created, stayed in the
// catalog list for good. You deselected the team AND then had to go and switch
// the catalog off by hand, or it sat there forever. The team pick is now the
// single source of truth — deselect and it leaves the manifest by itself.
//
// Leaving is not deleting, and that distinction is load-bearing in two
// directions. Re-picking the team has to cost no provider calls, and deleting
// a promotion outright is what left a store full of unreachable `manutd:`
// events in 0.89.1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-team-retention-'));
process.env.CUSTOM_PROMOTIONS_FILE = path.join(dir, 'custom-promotions.json');

const customPromotions = require('../lib/custom-promotions');
const promotions = require('../lib/promotions');
const teamPicker = require('../lib/team-picker');
const refresh = require('../scripts/refresh');

const COWBOYS = {
  id: '6', name: 'Dallas Cowboys', fullName: 'Dallas Cowboys', abbreviation: 'DAL',
  names: ['Dallas Cowboys', 'Dallas', 'Cowboys', 'DAL'],
};

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a team pick creates a served catalog', () => {
  const spec = teamPicker.specFor('nfl', COWBOYS);
  customPromotions.add(spec);
  promotions.reload();

  const live = promotions.enabled.find((p) => p.id === spec.id);
  assert.ok(live, 'the catalog should be served straight away');
  assert.ok(promotions.byPrefix[spec.idPrefix], 'and reachable by prefix');
});

test('deselecting removes it from the manifest but keeps the promotion', () => {
  const spec = teamPicker.specFor('nfl', COWBOYS);
  const stored = customPromotions.findById(spec.id);
  customPromotions.update(spec.id, Object.assign({}, stored, { enabled: false }));
  promotions.reload();

  // Out of the manifest: byPrefix and enabled carry only served promotions,
  // so the catalog disappears from every client with no second step.
  assert.equal(promotions.enabled.some((p) => p.id === spec.id), false,
    'a deselected team must not be served');
  assert.equal(promotions.byPrefix[spec.idPrefix], undefined);

  // Still known: this is what stops the refresh treating its events as
  // orphans, because the prune keys on promotions.all, not the enabled list.
  const known = promotions.all.find((p) => p.id === spec.id);
  assert.ok(known, 'the promotion is retained, not deleted');
  assert.equal(known.enabled, false);
  assert.equal(
    refresh.isOrphanEventId(spec.idPrefix + ':12345', refresh.knownPromotionPrefixes()),
    false,
    'a retained promotion protects its stored events from the orphan prune');
});

test('picking the team again restores it with nothing to re-fetch', () => {
  const spec = teamPicker.specFor('nfl', COWBOYS);
  const stored = customPromotions.findById(spec.id);
  assert.equal(stored.enabled, false, 'the disabled state is on disk, not just in memory');

  customPromotions.update(spec.id, Object.assign({}, stored, { enabled: true }));
  promotions.reload();
  assert.ok(promotions.enabled.some((p) => p.id === spec.id), 'restored to the manifest');

  // The spec is unchanged apart from the flag — same id, same source, same
  // filter — so the events already in the store still belong to it.
  const back = customPromotions.findById(spec.id);
  assert.equal(back.id, spec.id);
  assert.equal(back.source, 'espn');
  assert.equal(back.teamFilter.id, '6');
});

test('a spec with no enabled flag is served, so nothing existing changes', () => {
  const spec = teamPicker.specFor('mlb', {
    id: '147', name: 'New York Yankees', abbreviation: 'NYY', names: ['New York Yankees', 'Yankees'],
  });
  delete spec.enabled;
  const normalised = customPromotions.normaliseSpec(spec);
  assert.equal(normalised.enabled, true,
    'promotions saved before this release must keep working');
  assert.equal(promotions.createGenericPromotion(normalised).enabled, true);
});
