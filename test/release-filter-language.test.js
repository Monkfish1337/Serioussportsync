'use strict';

// The foreign-language filter used to reject any release whose title contained
// an English nationality adjective. Sport is full of those as place names — the
// F1 and MotoGP calendars are literally a list of them — so "Formula 1
// Hungarian Grand Prix Practice 1" was dropped as Hungarian-audio. In a real
// diagnostics export this was the only genuine false negative in 14,758
// rejections, and it was enough to leave F1 and MotoGP matching nothing at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const releaseFilter = require('../lib/sources/release-filter');

// Observed verbatim in a Sport-Video export, alongside the wider calendar.
const REAL_EVENT_TITLES = [
  'Formula 1 Hungarian Grand Prix Practice 1 24.07.2026',
  'Formula 1 Hungarian Grand Prix Practice 2 24.07.2026',
  'Formula 1 Hungarian Grand Prix Practice 3 25.07.2026',
  'Formula 1 Hungarian Grand Prix Qualifying 25.07.2026',
  'Formula 1 Dutch Grand Prix Practice 1 21.08.2026',
  'Formula 1 Dutch Grand Prix Sprint Qualifying 21.08.2026',
  'Formula 1 Italian Grand Prix Race 06.09.2026',
  'Formula 1 Japanese Grand Prix 2026 1080p',
  'Formula 1 Brazilian Grand Prix Sprint 2026',
  'Formula 1 Chinese Grand Prix 2026',
  'Formula 1 Turkish Grand Prix 2026',
  'MotoGP Spanish GP Race 2026',
  'MotoGP Czech Grand Prix 2026',
  'French Open 2026 Final',
  'Italian Open Masters 2026',
];

const REAL_LANGUAGE_TAGS = [
  'UFC 300 SPANISH 1080p',
  'NFL Week 1 2026 GERMAN DUB 720p',
  'F1 2026 Race MULTI.ITALIAN.1080p',
  'Boxing 2026 [DUTCH] HDTV',
  'Some Event 2026 JAPANESE 1080p',
  'Event 2026 DEUTSCH 720p',
  'Event 2026 PT-BR 1080p',
  'Match 2026 POLSKI',
  'Fight 2026 MAGYAR',
  'Race 2026 FRANCAIS',
  'Game 2026 ESPANOL',
];

test('a nationality in an event name is not a language tag', () => {
  for (const title of REAL_EVENT_TITLES) {
    assert.notEqual(releaseFilter.rejectionReason(title), 'foreign-language',
      'wrongly dropped as foreign language: ' + title);
    assert.equal(releaseFilter.isLikelyEventContent(title), true,
      'wrongly filtered out: ' + title);
  }
});

test('an actual language tag is still rejected', () => {
  for (const title of REAL_LANGUAGE_TAGS) {
    assert.equal(releaseFilter.rejectionReason(title), 'foreign-language',
      'should have been dropped as foreign language: ' + title);
  }
});

test('the opt-out still admits foreign-language releases', () => {
  assert.equal(
    releaseFilter.rejectionReason('UFC 300 SPANISH 1080p', null, { allowForeignLanguage: true }),
    null);
});
