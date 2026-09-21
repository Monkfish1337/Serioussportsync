'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const promotions = require('../lib/promotions');
const teamPicker = require('../lib/team-picker');
const { buildManifest } = require('../lib/manifest');
const { handleCatalog } = require('../lib/catalog');

test('a roster is materialized once without disabling pre-existing team catalogs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-team-roster-'));
  try {
    const file = path.join(dir, 'custom-promotions.json');
    const script = `
      const assert = require('node:assert/strict');
      const custom = require('./lib/custom-promotions');
      const picker = require('./lib/team-picker');
      const teams = [
        {id:'1',name:'First Team',abbreviation:'ONE',names:['First Team']},
        {id:'2',name:'Second Team',abbreviation:'TWO',names:['Second Team']},
      ];
      const specs = teams.map(t => picker.specFor('nfl',t));
      assert.equal(custom.ensureTeamRoster(specs),true);
      assert.equal(custom.ensureTeamRoster(specs),false);
      const saved = custom.list();
      assert.equal(saved.length,2);
      assert.ok(saved.every(s => s.enabled && s.autoTeam));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, CUSTOM_PROMOTIONS_FILE: file }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one account can add a team without showing it in another account', () => {
  const spec = teamPicker.specFor('nfl', {
    id: '6', name: 'Dallas Cowboys', abbreviation: 'DAL', names: ['Dallas Cowboys'],
  });
  const promotion = promotions.createGenericPromotion(spec);
  promotions.enabled.push(promotion);
  try {
    const chosen = { config: { teamPromotions: [spec.id], catalogs: [] } };
    const other = { config: { teamPromotions: [], catalogs: [] } };
    const chosenCatalogs = buildManifest({ user: chosen }).catalogs.map((catalog) => catalog.id);
    const otherCatalogs = buildManifest({ user: other }).catalogs.map((catalog) => catalog.id);
    assert.ok(chosenCatalogs.includes(spec.id + '-upcoming'));
    assert.ok(chosenCatalogs.includes(spec.id + '-recent'));
    assert.ok(!otherCatalogs.includes(spec.id + '-upcoming'));
    assert.deepEqual(handleCatalog({ type: require('../config').addonType,
      id: spec.id + '-recent' }, { user: other }), { metas: [] });
  } finally { promotions.enabled.pop(); }
});
