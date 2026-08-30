'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');

test('MotoGP removes complete session labels before deriving location aliases', () => {
  const motogp = promotions.getByEventId('motogp:aragon-practice');
  const event = {
    id: 'motogp:aragon-practice',
    name: 'Aragón Free Practice',
    date: '2026-08-29',
  };
  const titles = motogp.searchTitles(event);
  assert.ok(titles.includes('MotoGP 2026 aragón Free Practice'));
  assert.ok(titles.every((title) => !/aragón free free practice/i.test(title)));
  assert.deepEqual(
    motogp.isRelevantStreamTitle('MotoGP.2026.Aragon.FP1.1080p.WEB.h264', event),
    { ok: true },
  );
});

test('MotoGP strips compact FP session suffixes generically', () => {
  const motogp = promotions.getByEventId('motogp:unknown');
  const event = { id: 'motogp:unknown', name: 'New Circuit FP2', date: '2026-08-29' };
  assert.ok(motogp.searchTitles(event).includes('MotoGP 2026 new circuit FP2'));
});
