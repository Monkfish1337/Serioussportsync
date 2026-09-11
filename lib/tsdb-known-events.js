'use strict';

// Recurring card names for TheSportsDB leagues whose upcoming events the list
// endpoints do not reach.
//
// Measured against the live free-key API and the running instance on
// 2026-09-11:
//
//   eventsnextleague.php?id=4563    -> 1 event ("Collision #161", weekly TV)
//   eventsnextleague.php?id=4443    -> 1 event (UFC, so the cap is the key's
//                                     shape rather than an AEW data gap)
//   eventsseason.php?id=4563&s=2026 -> 15 events, ending 2026-02-19
//   searchevents.php?e=All_Out      -> idEvent 2579127, 2026-09-27, AEW
//
// And in the instance's own store, filtered per promotion:
//
//   aew     32 events, every one of them in the past, newest 2026-08-30
//   ufc     84 events, future dates out to 2026-12-12
//   wwe     74 events, future dates out to 2026-12-12
//   boxing  100+ events, future dates out to 2026-10-31
//   f1      100+ events, future dates out to 2026-12-06
//
// So this is NOT a general TheSportsDB problem, and an earlier version of this
// file claimed it was. AEW is the outlier: its schedule is roughly three
// weekly TV tapings a week, the promotion correctly discards those, and what
// survives the free key's caps is past cards only. Every other league here
// reaches its future events through the endpoints already in use.
//
// Hence one list, not a framework. Names are added when a league is measured
// to need them, not because it is plausible that it might.
//
// Keyed by league id rather than carried on the source object: a promotion's
// source resolves from its own fallback in lib/promotions.js, the system
// registry in lib/metadata-sources.js, or a user-created entry, and only the
// league id is common to all three. Putting the names on the promotion literal
// was tried first and had no effect, because the registry definition wins.
const TSDB_KNOWN_EVENTS = Object.freeze({
  // AEW pay-per-views and specials, including the pre-shows TheSportsDB files
  // as events of their own ("... Zero Hour", "... The Buy In").
  '4563': Object.freeze([
    'All In', 'All Out', 'Revolution', 'Double or Nothing', 'Forbidden Door',
    'WrestleDream', 'Full Gear', 'Worlds End', 'Dynasty', 'Grand Slam',
    'Fyter Fest', 'Fight for the Fallen', 'Winter Is Coming', 'Blood and Guts',
  ]),
});

function knownEventsFor(leagueId) {
  return (TSDB_KNOWN_EVENTS[String(leagueId || '')] || []).slice();
}

module.exports = { TSDB_KNOWN_EVENTS, knownEventsFor };
