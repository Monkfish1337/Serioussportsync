'use strict';
// Discussions #42: F1 Practice 1, 2 and 3 are separate catalog items, but all
// three were one 'practice' session to the matcher, so opening Practice 3
// offered Practice 1 and 2 releases as well.
const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');

const f1 = promotions.all.find((p) => p.id === 'f1');
const practice3 = { id: 'f1:p3', name: 'Azerbaijan Grand Prix Practice 3', date: '2026-09-25', round: '17' };

test('a practice event accepts only its own practice number', () => {
  const ok = (title) => f1.isRelevantStreamTitle(title, practice3).ok;
  // Sport-Video's naming, from the live Sport-Video tab on 2026-09-24.
  assert.equal(ok('Formula 1 Azerbaijan Grand Prix Practice 3 25.09.2026'), true);
  assert.equal(ok('Formula 1 Azerbaijan Grand Prix Practice 1 24.09.2026'), false);
  assert.equal(ok('Formula 1 Azerbaijan Grand Prix Practice 2 24.09.2026'), false);
  // Scene forms.
  assert.equal(ok('Formula1.2026.Round17.Azerbaijan.Practice.Three.1080p.WEB'), true);
  assert.equal(ok('Formula1.2026.Round17.Azerbaijan.Practice.One.1080p.WEB'), false);
  assert.equal(ok('F1.2026.R17.Azerbaijan.Grand.Prix.FP3.1080p'), true);
  assert.equal(ok('F1.2026.R17.Azerbaijan.Grand.Prix.FP2.1080p'), false);
  assert.equal(ok('Formula.1.2026.Azerbaijan.GP.Free.Practice.3.1080p'), true);
  assert.equal(ok('Формула 1 2026 Этап 17 Азербайджан Третья практика'), true);
  assert.equal(ok('Формула 1 2026 Этап 17 Азербайджан Практика 1'), false);
  // A release naming no number (all practices bundled) is still offered.
  assert.equal(ok('Formula 1 2026 Azerbaijan GP Practice 1080p'), true);
  assert.equal(f1.isRelevantStreamTitle('Formula 1 Azerbaijan Grand Prix Practice 1 24.09.2026', practice3).reason, 'practice(1≠3)');
});

test('practice searches ask for the session number first', () => {
  const titles = f1.searchTitles(practice3);
  assert.equal(titles[0], 'Formula 1 2026 Azerbaijan GP Practice 3');
  assert.ok(titles.includes('F1 2026 Azerbaijan FP3'));
  assert.ok(titles.indexOf('Formula 1 2026 Azerbaijan GP Practice') > titles.indexOf('F1 2026 Azerbaijan FP3'));
});

test('other sessions are unaffected', () => {
  const quali = { id: 'f1:q', name: 'Azerbaijan Grand Prix Qualifying', date: '2026-09-26', round: '17' };
  assert.equal(f1.isRelevantStreamTitle('Formula 1 Azerbaijan Grand Prix Qualifying 26.09.2026', quali).ok, true);
  assert.equal(f1.isRelevantStreamTitle('Formula 1 Azerbaijan Grand Prix Practice 3 25.09.2026', quali).ok, false);
  assert.equal(f1.searchTitles(quali)[0], 'Formula 1 2026 Azerbaijan GP Qualifying');
});
