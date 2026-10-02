'use strict';

// Fallback artwork for the built-in promotions (issue #69). The defaults were
// TheSportsDB league banners and badges from 2014-2020, and every event keeps
// the default its promotion had when it was ingested, so 128 MotoGP events
// still showed the 2015 banner with the old logo. The defaults are now cards
// bundled in public/ (scripts/make-promotion-art.js), and a stored fallback is
// swapped for the current default when the event is served.

process.env.PUBLIC_URL = 'https://sss.test.invalid';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const promotions = require('../lib/promotions');
const transform = require('../lib/transform');

const BUILT_IN = ['f1', 'motogp', 'ufc', 'one', 'boxing', 'wwe', 'wwe-raw', 'wwe-smackdown', 'wwe-nxt',
  'aew', 'aew-dynamite', 'aew-collision', 'mlb', 'nfl', 'nba', 'nhl', 'ucl', 'epl', 'motd'];
const byId = (id) => promotions.all.find((p) => p.id === id);

test('every built-in promotion falls back to its own bundled card, never a TheSportsDB league image', () => {
  const seen = new Set();
  for (const id of BUILT_IN) {
    const { poster, fanart } = byId(id).defaults;
    for (const url of [poster, fanart]) {
      const m = String(url).match(/^https:\/\/sss\.test\.invalid\/assets\/(promo-[\w-]+\.png)$/);
      assert.ok(m, id + ': ' + url);
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', m[1])), m[1] + ' is shipped');
    }
    assert.equal(seen.has(poster), false, 'two promotions share ' + poster);
    seen.add(poster);
  }
  assert.match(byId('boxing').defaults.poster, /promo-boxing-poster\.png$/, 'portrait tiles get a portrait card');
  for (const id of ['mlb', 'nfl', 'nba', 'nhl', 'ucl', 'epl']) {
    assert.match(byId(id).defaults.poster, new RegExp('promo-' + id + '-square\\.png$'), 'square tiles get a square card');
  }
});

test('a stored league image or old bundled card is served as the current default', () => {
  const motogp = byId('motogp');
  const id = motogp.idPrefix + ':stale-1';
  const stale = { id, name: 'Grand Prix of Japan', date: '2026-10-04',
    poster: 'https://r2.thesportsdb.com/images/media/league/banner/qrxpqu1441138872.jpg',
    thumb: 'https://r2.thesportsdb.com/images/media/league/banner/qrxpqu1441138872.jpg',
    fanart: 'https://r2.thesportsdb.com/images/media/league/banner/qrxpqu1441138872.jpg' };
  const meta = transform.toCatalogMeta(stale);
  assert.equal(meta.poster, motogp.defaults.poster);
  assert.equal(transform.toDetailMeta(stale).background, motogp.defaults.fanart);

  const f1 = byId('f1');
  const old = transform.toCatalogMeta({ id: f1.idPrefix + ':old-1', name: 'Race', date: '2026-10-04',
    poster: 'https://old.example/assets/f1-upcoming.jpg' });
  assert.equal(old.poster, f1.defaults.poster, 'a card that is no longer shipped is not served');
});

test('an event with its own art keeps it, even when a league image is stored first', () => {
  const ufc = byId('ufc');
  const own = 'https://r2.thesportsdb.com/images/media/event/thumb/abc123.jpg';
  const meta = transform.toCatalogMeta({ id: ufc.idPrefix + ':own-1', name: 'UFC 330', date: '2026-10-04',
    poster: 'https://r2.thesportsdb.com/images/media/league/banner/rwyuqv1463908317.jpg', thumb: own });
  assert.equal(meta.poster, own);
  assert.equal(transform.toCatalogMeta({ id: ufc.idPrefix + ':own-2', name: 'UFC 331', date: '2026-10-04', poster: own }).poster, own);
});

test('without PUBLIC_URL the cards are served from the repository, so no tile is blank', () => {
  const out = execFileSync(process.execPath, ['-e',
    "const p=require('./lib/promotions');console.log(p.all.find(x=>x.id==='motogp').defaults.poster)"],
  { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { PUBLIC_URL: '' }), encoding: 'utf8' });
  assert.equal(out.trim(), 'https://raw.githubusercontent.com/Monkfish1337/Serioussportsync/main/public/promo-motogp.png');
});

// Reported from Nuvio: WWE NXT #856 and AEW Collision #162/#163 drew black.
// TheSportsDB gave their images on www.thesportsdb.com/images/…, which does
// not serve images; the same path on r2.thesportsdb.com does.
test('TheSportsDB images on the www host are served from its image CDN', () => {
  const nxt = byId('wwe-nxt');
  const www = 'https://www.thesportsdb.com/images/media/event/thumb/fd5vn91790142898.jpg';
  const r2 = 'https://r2.thesportsdb.com/images/media/event/thumb/fd5vn91790142898.jpg';
  const stored = { id: nxt.idPrefix + ':2607549', name: 'WWE NXT #856', date: '2026-09-22', poster: www, thumb: www, fanart: www };
  assert.equal(transform.toCatalogMeta(stored).poster, r2, 'events stored before the fix');
  assert.equal(transform.toDetailMeta(stored).background, r2);
  const fresh = transform.fromTsdb({ idEvent: '2607549', strEvent: 'NXT #856', dateEvent: '2026-09-22', strThumb: www, strFanart: www }, nxt);
  assert.equal(fresh.poster, r2, 'and new ones as they come in');
  assert.equal(fresh.thumb, r2);
  assert.equal(transform.toCatalogMeta({ id: nxt.idPrefix + ':1', name: 'x', date: '2026-09-22', poster: r2 }).poster, r2, 'r2 is left alone');
});
