'use strict';

// AEW's Upcoming row was empty.
//
// Reported as "All Out on 27 Sep 2026 isn't on upcoming". Not a matching bug:
// the instance's store held 32 AEW events and every one of them was in the
// past, newest 2026-08-30. TheSportsDB's free key caps its list endpoints,
// AEW runs about three weekly TV tapings a week, and what survives the cap is
// shows the promotion correctly discards. Measured on 2026-09-11:
//
//   eventsnextleague.php?id=4563    -> 1 event  ("Collision #161")
//   eventsseason.php?id=4563&s=2026 -> 15 events, ending 2026-02-19
//   searchevents.php?e=All_Out      -> idEvent 2579127, 2026-09-27, AEW
//
// The last line is the fix: the event is in the database, just not reachable
// by listing. Ask for it by name.
//
// AEW is the ONLY shipped league that needs this. Checked in the same store on
// the same day: ufc 84 events out to 2026-12-12, wwe 74 out to 2026-12-12,
// boxing 100+ out to 2026-10-31, f1 100+ out to 2026-12-06. An earlier version
// of this change added a WWE list too, on the assumption that Raw and SmackDown
// would crowd out the PLEs the same way. They do not, and the list was removed.

const test = require('node:test');
const assert = require('node:assert');
const known = require('../lib/tsdb-known-events');
const tsdb = require('../lib/sources/thesportsdb');
const promotions = require('../lib/promotions');

test('AEW has its recurring cards listed', () => {
  const aew = known.knownEventsFor('4563');
  assert.ok(aew.includes('All Out'), 'the reported miss must be covered');
  assert.ok(aew.includes('Revolution') && aew.includes('Full Gear'));
});

test('a league is only listed once it has been measured to need it', () => {
  // WWE was added here on the assumption that Raw and SmackDown would crowd
  // out the PLEs the way AEW's weekly TV crowds out its PPVs. Checked against
  // the running instance: wwe had 74 events with future dates out to
  // 2026-12-12, so it never needed this and the list was removed. Fifteen
  // HTTP requests per refresh is not a free hedge.
  assert.deepEqual(known.knownEventsFor('4444'), [], 'WWE reaches its own PLEs');
});

test('a league with no list is simply not affected', () => {
  // UFC numbers its cards, so there is no stable name to look up and nothing
  // to add. The absence must be an empty list, not undefined, or the adapter
  // would have to guard at every call site.
  assert.deepEqual(known.knownEventsFor('4443'), []);
  assert.deepEqual(known.knownEventsFor(''), []);
  assert.deepEqual(known.knownEventsFor(undefined), []);
});

test('the lists are keyed by league, and reach the shipped promotions', () => {
  // The names cannot live on the source object: a promotion's source comes
  // from its own fallback, the system metadata-source registry, or a
  // user-created entry, and only the league id is common to all three. AEW's
  // resolved source is the registry's, which is why an earlier attempt to put
  // the names on the promotion literal had no effect at all.
  for (const id of ['aew']) {
    const promotion = promotions.all.find((p) => p.id === id);
    assert.ok(promotion, id + ' must exist');
    assert.equal(promotion.source.type, 'thesportsdb');
    assert.ok(known.knownEventsFor(promotion.source.leagueId).length > 0,
      id + ' must resolve to a name list through its league id');
  }
});

test('the caller cannot mutate the shared list', () => {
  const first = known.knownEventsFor('4563');
  first.push('Not A Real Card');
  assert.ok(!known.knownEventsFor('4563').includes('Not A Real Card'));
});

test('named lookups ask the right endpoint and keep only this league', async () => {
  // searchevents is global — asking for "Revolution" must not file some other
  // promotion's event under AEW.
  const asked = [];
  const lookup = async (leagueId, name) => {
    asked.push(name);
    if (name === 'All Out') {
      return [{ idEvent: '2579127', idLeague: '4563', strEvent: 'All Out', dateEvent: '2026-09-27' }];
    }
    if (name === 'Revolution') {
      return [{ idEvent: '999', idLeague: '9999', strEvent: 'Revolution', dateEvent: '2026-03-01' }];
    }
    return [];
  };
  const events = await tsdb.fetchNamedEvents('4563', ['All Out', 'Revolution', 'Nothing'],
    () => {}, { lookup });
  assert.deepEqual(asked, ['All Out', 'Revolution', 'Nothing']);
  assert.equal(events.length, 1, "the other league's Revolution must be dropped");
  assert.equal(events[0].idEvent, '2579127');
});

test('a failing name does not lose the others', async () => {
  const lookup = async (leagueId, name) => {
    if (name === 'All In') throw new Error('timeout');
    return [{ idEvent: '2579127', idLeague: '4563', strEvent: name, dateEvent: '2026-09-27' }];
  };
  const events = await tsdb.fetchNamedEvents('4563', ['All In', 'All Out'], () => {}, { lookup });
  assert.equal(events.length, 1);
});

test('spaces become underscores in the query, which is what the endpoint wants', () => {
  // searchevents.php?e=All_Out is what returned idEvent 2579127; the same
  // request with a space returns nothing.
  const urls = [];
  const encoded = String(tsdb.fetchNamedEvent);
  assert.ok(encoded.includes("replace("), 'the name must be rewritten before it is sent');
  assert.ok(encoded.includes('searchevents.php?e='));
  assert.equal(urls.length, 0);
});

// The named lookups are expensive: one request per name, with
// config.tsdb.requestDelayMs between them to stay inside the free key's 30/min.
// At the shipped 3000ms that is 42 seconds for AEW's fourteen names. Added
// unconditionally, they pushed every AEW refresh — and the 60s interactive
// source preview — past its deadline. A preview that times out is worse than
// the empty Upcoming row this was built to fix.

// The gate deciding which names still need a lookup has been wrong twice, both
// times because something that was not the answer satisfied it. It is
// `namesNeedingLookup`, exported so these are real assertions on behaviour
// rather than greps of the file.

test('a future event elsewhere in the league does not cover a card', () => {
  // Gate v1 was "skip if any future event came back at all". AEW's list
  // endpoints DO reach the future — they return the next Dynamite or Collision,
  // because AEW runs weekly TV — while All Out never appears in them. One
  // future taping satisfied the gate and the reported PPV stayed missing.
  const fetched = [
    { strEvent: 'Collision #161', dateEvent: '2026-09-13' },
    { strEvent: 'Dynamite #362 Rebel Heart', dateEvent: '2026-09-10' },
  ];
  const missing = tsdb.namesNeedingLookup(fetched, ['All Out', 'Full Gear'], '2026-09-12');
  assert.deepEqual(missing, ['All Out', 'Full Gear'],
    'weekly TV reaching the future says nothing about the PPVs');
});

test("last year's card does not cover this year's", () => {
  // Gate v2, and the reason AEW's Upcoming row was STILL empty after v1 was
  // fixed. These cards are annual, and the season walk covers every season in
  // the event window — which starts 2025-01-01. Measured against the live free
  // key on 2026-09-12, the AEW 2025 walk returns 101 events including All Out
  // 2025-09-20, WrestleDream 2025-10-19, Revolution, Dynasty, Double or
  // Nothing, Forbidden Door and All In. Ten of the fourteen names looked
  // "covered", every lookup was skipped, and the 2026 cards were never asked
  // for.
  const fetched = [
    { strEvent: 'All Out', dateEvent: '2025-09-20' },
    { strEvent: 'WrestleDream', dateEvent: '2025-10-19' },
    { strEvent: 'Revolution', dateEvent: '2025-03-10' },
  ];
  const missing = tsdb.namesNeedingLookup(
    fetched, ['All Out', 'WrestleDream', 'Revolution'], '2026-09-12');
  assert.deepEqual(missing, ['All Out', 'WrestleDream', 'Revolution'],
    'an annual card that already happened is history, not coverage');
});

test('a card already reachable ahead is not looked up again', () => {
  // The gate still has to earn its keep: its whole purpose is that fourteen
  // names at 3000ms apart is 42 seconds a refresh.
  const fetched = [
    { strEvent: 'All Out', dateEvent: '2026-09-27' },
    { strEvent: 'Full Gear', dateEvent: '2026-11-15' },
  ];
  assert.deepEqual(
    tsdb.namesNeedingLookup(fetched, ['All Out', 'Full Gear'], '2026-09-12'), []);
  // Today counts as ahead — a card running tonight is still upcoming.
  assert.deepEqual(
    tsdb.namesNeedingLookup([{ strEvent: 'All Out', dateEvent: '2026-09-12' }],
      ['All Out'], '2026-09-12'), []);
  // TheSportsDB decorates these names ("All In London The Buy In"), so the
  // match is a containment, not an equality.
  assert.deepEqual(
    tsdb.namesNeedingLookup([{ strEvent: 'All Out Zero Hour', dateEvent: '2026-09-27' }],
      ['All Out'], '2026-09-12'), []);
});

test('undated and unnamed records cannot cover anything', () => {
  const fetched = [{ strEvent: 'All Out' }, { dateEvent: '2026-09-27' }, {}, null];
  assert.deepEqual(tsdb.namesNeedingLookup(fetched, ['All Out'], '2026-09-12'), ['All Out']);
  assert.deepEqual(tsdb.namesNeedingLookup([], [], '2026-09-12'), []);
  assert.deepEqual(tsdb.namesNeedingLookup(null, ['All Out'], '2026-09-12'), ['All Out']);
});

test('the lookup takes the missing names, not the whole list', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'sources', 'thesportsdb.js'), 'utf8');
  assert.match(source, /fetchNamedEvents\(leagueId, missing, log\)/);
});

test('one season cannot spend the whole round-walk budget', () => {
  // Measured on AEW with the event window's two seasons and a single shared
  // deadline: 2025 walked to round 127 and stopped "out of time budget", and
  // 2026 — the season anyone is actually asking about — got one round. Seasons
  // are walked oldest-first, so the oldest simply took all of it.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'sources', 'thesportsdb.js'), 'utf8')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.match(source, /seasonDeadlineAt/,
    'each season needs its own stop, not the run-wide one');
  assert.match(source, /fetchSeasonAllRounds\(leagueId, season, log, seasonDeadlineAt\)/);
  // Anchored on `await`, because the declaration of fetchSeasonAllRounds
  // itself names its fourth parameter deadlineAt — it is the call that must
  // pass the per-season stop.
  assert.ok(!/await fetchSeasonAllRounds\(leagueId, season, log, deadlineAt\)/.test(source),
    'the shared deadline must not still be handed to the walk');
});

test('a preview never pays for the per-round season walk either', () => {
  // WWE has no name list and still timed out at 60s. The round walk is one
  // request per round at config.tsdb.requestDelayMs apart, continuing until
  // five rounds in a row come back empty — for a league with weekly TV that
  // is forty-odd requests, well over two minutes.
  const adapter = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'sources', 'thesportsdb.js'), 'utf8');
  assert.match(adapter, /opts\.skipRoundWalk/);
  assert.match(adapter, /deadlineAt/, 'a slow source must degrade to a partial answer, not an error');

  const diff = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'metadata-source-diff.js'), 'utf8');
  assert.match(diff, /skipRoundWalk: true/);
  assert.match(diff, /deadlineMs/);

  const refreshSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scripts', 'refresh.js'), 'utf8');
  assert.match(refreshSource, /skipRoundWalk: opts\.skipRoundWalk === true/,
    'the flag has to survive the trip from the diff to the adapter');
});

test('a preview never pays for named lookups', () => {
  // 14 names x 3000ms is 42s against a 60s preview deadline.
  const adapter = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'sources', 'thesportsdb.js'), 'utf8');
  assert.match(adapter, /opts\.skipNamedLookups/);

  const diff = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib', 'metadata-source-diff.js'), 'utf8');
  assert.match(diff, /skipNamedLookups: true/,
    'every fetch through the diff is a preview and must opt out');

  const refreshSource = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scripts', 'refresh.js'), 'utf8');
  assert.match(refreshSource, /skipNamedLookups: opts\.skipNamedLookups === true/,
    'the flag has to survive the trip from the diff to the adapter');
});
