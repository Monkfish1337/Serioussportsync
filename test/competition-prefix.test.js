'use strict';

// Two matching regressions that only showed up in the INDEXER pipelines, and
// so were invisible to every diagnostic run against Sport-Video.
//
// Sport-Video names its releases bare — "Manchester United vs Arsenal
// 02.09.2026". Usenet and torrent indexers almost never do: the dominant scene
// convention puts the competition first, "EPL Manchester United vs Arsenal
// 02.09.2026". The 0.87.1 collision guard, which required the token before a
// team name to be something it recognised, treated that prefix as foreign
// context and rejected the release. Man United went from several sources per
// fixture to none, and the Sport-Video export could never have shown it.
//
// The fix is a vocabulary of competition words, plus each promotion's own
// names, that are allowed to sit in front of a team. Which then exposed a
// second bug in the wizard: see the ambiguous-alias tests below.

const test = require('node:test');
const assert = require('node:assert/strict');
const promotions = require('../lib/promotions');
const customPromotions = require('../lib/custom-promotions');
const teamPicker = require('../lib/team-picker');

const UNITED = {
  id: '66', name: 'Man United', fullName: 'Manchester United FC', abbreviation: 'MUN',
};

function wizardUnited() {
  return promotions.createGenericPromotion(
    customPromotions.normaliseSpec(teamPicker.specFor('epl', UNITED)));
}

const FIXTURE = {
  id: 'epl-mun:test', date: '2026-09-02T00:00:00Z',
  name: 'Man United vs Arsenal',
  source: { date: '2026-09-02' },
};

// Every one of these was rejected before the fix, and every one is a shape a
// real indexer returns.
test('a competition prefix does not hide the teams behind it', () => {
  const promotion = wizardUnited();
  for (const title of [
    'EPL Manchester United vs Arsenal 02.09.2026',
    'Premier League Manchester United vs Arsenal 02.09.2026',
    'English Premier League Man United vs Arsenal 02.09.2026',
    'Football.EPL.Manchester.United.vs.Arsenal.02.09.2026.1080p',
    'UEFA Champions League Manchester United vs Arsenal 02.09.2026',
    'FA Cup Man Utd vs Arsenal 02.09.2026',
    'Carabao Cup Man United vs Arsenal 02.09.2026',
    // Already worked; kept so a future narrowing cannot cost them.
    'Manchester United vs Arsenal 02.09.2026',
    'EPL 2026 09 02 Manchester United vs Arsenal 1080p',
  ]) {
    const verdict = promotion.isRelevantStreamTitle(title, FIXTURE);
    assert.equal(verdict.ok, true, 'should have matched: ' + title
      + ' (' + (verdict.reason || '') + ')');
  }
});

// The prefix vocabulary must not become a way in for the wrong fixture: the
// guard it relaxes is the one that stops "Inter Milan" satisfying "Milan".
test('the prefix vocabulary does not readmit the wrong club', () => {
  const promotion = wizardUnited();
  for (const title of [
    'EPL Manchester City vs Arsenal 02.09.2026',
    'EPL Liverpool vs Arsenal 02.09.2026',
    'Premier League Newcastle United vs Arsenal 02.09.2026',
  ]) {
    assert.equal(promotion.isRelevantStreamTitle(title, FIXTURE).ok, false,
      'wrongly matched: ' + title);
  }
});

// The wizard hands a single-club promotion the whole `epl` alias preset, which
// is right for coverage and wrong for identity: that table lists "Manchester"
// under BOTH Manchester clubs, and "United" under a club whose rivals all carry
// "United" in their own names. The promotion this replaces carried a bespoke
// guard; buildAliasLookup now drops any form that cannot name one club.
test('an alias that names two clubs names neither', () => {
  const promotion = wizardUnited();
  for (const title of [
    'EPL Manchester City vs Arsenal 02.09.2026',     // "Manchester"
    'EPL Newcastle United vs Arsenal 02.09.2026',    // "United"
    'EPL Leeds United vs Arsenal 02.09.2026',
    'EPL West Ham United vs Arsenal 02.09.2026',
  ]) {
    assert.equal(promotion.isRelevantStreamTitle(title, FIXTURE).ok, false,
      'ambiguous alias let the wrong club through: ' + title);
  }

  // Forms that identify exactly one club are untouched — dropping those would
  // cost far more matches than the collision ever did.
  for (const title of [
    'EPL Man Utd vs Arsenal 02.09.2026',
    'EPL MUFC vs Arsenal 02.09.2026',
    'EPL Manchester United vs Arsenal 02.09.2026',
  ]) {
    assert.equal(promotion.isRelevantStreamTitle(title, FIXTURE).ok, true,
      'unambiguous alias wrongly dropped: ' + title);
  }
});

// The shipped league promotions read the same preset and must be unaffected:
// there both clubs live inside the promotion, so the matchup split does the
// work and nothing depended on the shared form.
test('the league promotions still match their own fixtures', () => {
  const epl = promotions.byPrefix.epl;
  assert.ok(epl, 'the EPL promotion should exist');
  const derby = {
    id: 'epl:derby', date: '2026-09-02T00:00:00Z',
    name: 'Manchester United FC vs Manchester City FC',
    teamNames: { home: ['Manchester United FC'], away: ['Manchester City FC'] },
    source: { date: '2026-09-02' },
  };
  assert.equal(
    epl.isRelevantStreamTitle('EPL Manchester United vs Manchester City 02.09.2026', derby).ok,
    true);
  assert.equal(
    epl.isRelevantStreamTitle('EPL Everton vs Manchester City 02.09.2026', derby).ok,
    false);
});
