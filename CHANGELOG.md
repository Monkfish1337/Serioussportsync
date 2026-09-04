# Changelog

## 0.90.3

### A slow usenet source failed permanently, not intermittently

From a real log, on a Man United fixture with usenet coverage sitting on the
user's own indexer:

    uu: network error: network timeout at: http://192.168.1.16:1337/...
    stream request complete rows=2 pipelineRows={"usenetUltimate":0, ...}

A stream request has to answer inside Nuvio's ~10s patience, so each pipeline
gets about 7.5s. A Usenet Ultimate or Newznab instance that fans out to several
indexers routinely needs longer than that. The part that turned a slow source
into a dead one: a search that times out returns nothing AND caches nothing,
because only a result that succeeded is recorded. So every subsequent request
repeated the same doomed search under the same budget, forever, while torrents
— which are also warmed in the background at a 15s budget — kept working.

Raising the live budget is not the fix; the client gives up at ten seconds.
Turning on automatic usenet warming is not either: it is off by default on
purpose, because Newznab indexers meter API hits per day and warming every
event in the window would spend that allowance on fixtures nobody opened.

So the retry is demand-driven. A live usenet search that runs out of budget
schedules ONE background search for that event at the warm budget; the result
lands in the availability index and the next request is served from it
instantly. One in flight per event and account, only for events someone
actually opened, and `STREAM_USENET_BACKFILL=off` disables it.

A source that answers — including "nothing here", HTTP 401, or "unsupported" —
never triggers a retry. Backfilling those would spend metered indexer calls
re-learning an answer already given.

## 0.90.2

### Refresh several promotions at once

Between "refresh this one" and "refresh all thirty" there was nothing, so
touching four promotions meant four page loads with a preview each — or the
global button and a full pull of everything else, which is the expensive way to
refresh four things.

Each row on Promotions now has a tick box, with select-all in the header and a
"Refresh selected" button above the table. Disabled promotions are shown ticked
out, since a refresh skips them anyway.

The refreshes run one after another in the background rather than together:
several of these sources are rate-limited, and the event store is
read-modify-written per run, so overlapping runs would race and lose events.
One warm pass runs at the end instead of one per promotion.

There is no preview gate here, unlike the single-promotion button. That gate
exists because the single-promotion route can also apply a pending source
CHANGE, and a source change should be previewed first. This one only re-fetches
with the settings already saved — the same thing the global "Refresh catalogs"
button does, to fewer promotions.

The tick boxes are not inside a form. The rows already contain two forms each,
and wrapping the table in a third would nest them — the exact mistake that
detached the Configure Save button in 0.89.0. A test asserts the bulk form
closes before the table opens.

## 0.90.1

### Link pulling stopped for competition-prefixed releases

The worst regression I have shipped in this series, and the diagnostics could
not have caught it. The 0.87.1 collision guard — added to stop "Inter Milan"
satisfying a check for "Milan" — required the word before a team name to be
something it recognised. Indexers put the competition first:

    EPL Manchester United vs Arsenal 02.09.2026
    Football.EPL.Manchester.United.vs.Arsenal.02.09.2026.1080p
    UEFA Champions League Manchester United vs Arsenal 02.09.2026

"EPL" was not recognised, so every one of those was rejected as not naming the
team. Fixtures that had several Usenet and torrent sources dropped to none.

Every matching diagnostic I ran was against Sport-Video, which names its
releases bare — no prefix, so nothing to reject. The pipelines that carry the
convention are the ones with no export to read. That gap is now closed by
tests, not by another export.

The guard now knows a vocabulary of competition words, plus each promotion's
own names and aliases. The collision it was added for still holds: all
thirteen recorded invariants pass, "Serie A Juventus vs Inter Milan" included.

### An alias that names two clubs now names neither

Fixing the above exposed a second bug in the new team wizard. A wizard club is
built on the `epl` alias preset, and that table lists "Manchester" under both
Manchester clubs and "United" under a club whose rivals all carry "United" in
their own names. So a Man United catalog matched "EPL Manchester City vs
Arsenal" and "EPL Newcastle United vs Arsenal". The hand-built Man United
promotion this replaced carried a bespoke guard against exactly that, which
went away with it.

The alias table used to let the last-registered club win a shared form, and the
comment there accepted that cost deliberately. It was the right call while only
league promotions read the table — both clubs are inside the same promotion and
the matchup split sorts them out — and the wrong one the moment a single club
did. Any form that cannot name one club, whether shared outright or sitting
inside another club's name, is now dropped from the table. "Man Utd", "MUFC",
"Wolves", "Spurs" and "Magpies" are untouched.

### The discovered catalogs have their own artwork

All seven fell back to the SSS banner, so the home screen showed seven
identical rows with nothing to tell them apart. Each sport now has its own
bundled tile — football, American football, basketball, baseball, hockey,
rugby and a trophy for the rest — drawn by `scripts/make-discovered-art.py`,
which is checked in so the set can be regenerated or restyled.

### Deleting a promotion left its events behind forever

Nothing pruned an event whose promotion no longer existed: no catalog could
render it and no promotion existed to build a search from, so it sat in the
store as a fixture that pulls no links. Removing the shipped Man United
promotion in 0.89.1 created a store full of them.

The refresh now drops them. Known, not enabled, is the test — a promotion you
switch off keeps its events, because re-fetching them costs API budget.

## 0.90.0

### Tabler is served from the addon, not from a CDN

The admin loaded its entire stylesheet and JavaScript from cdn.jsdelivr.net at
runtime. On any network that could not reach it — which a self-hosted addon
behind a restrictive firewall often cannot — every page rendered as unstyled
HTML: a wall of raw form controls, with nothing to indicate why. Depending on
the public internet to draw its own admin page was the wrong trade for a
self-hosted product.

`@tabler/core` is a dependency now, served from the installed package at
`/assets/vendor/tabler`, with the version in the URL so a browser cache cannot
outlive an upgrade. A test asserts that no page references a CDN and that every
vendored asset it does reference is actually served.

`package.json` was reformatted by npm when the dependency was added — the diff
is large but the content is unchanged apart from the new entry.

### The Sport-Video switches now show which one is in charge

"Scan automatically" was drawn identically to "Enable Sport-Video results", so
it read as active while the feature itself was off. Everything below the master
switch is now dimmed and labelled when the master is off.

Deliberately dimmed rather than disabled: a disabled input submits nothing, so
disabling them would have silently cleared every Sport-Video setting on the next
save — the same trap the DIY Usenet page split had to avoid, and the test
asserts against it in both states.

## 0.89.1

### The Save button on Configure did nothing

A regression from 0.89.0, and entirely self-inflicted. Embedding the Nuvio
collection editor *inside* the account form nested one form in another, which
HTML does not allow: the browser closes the outer form at the first inner
`</form>`, so everything after it — including the Save button — stopped
belonging to any form at all. It rendered perfectly and submitted nothing.

The editor now sits outside the account form, still on the Configure page. A
route test asserts no `</form>` appears between the account form and its Save
button, so this cannot come back quietly.

### DIY Usenet has its own page

It was by far the largest thing on Configure — two discovery backends, two
playback backends, roughly thirty inputs and four test buttons — burying a page
whose actual job is a handful of switches.

Configure now carries one switch and a link. Everything else lives at
`/account/usenet`, in the sidebar beside Account, saved by its own route.

That last part matters more than it looks: `/account/save` had to stop listing
those fields, because a form that no longer renders an input submits nothing for
it, and the save would have blanked every DIY, NZB DAV and NNTP setting on the
account. Both halves are pinned by tests.

### Man United removed

The Configure-page wizard creates a club promotion from a pick now, so keeping a
hand-built promotion for one club meant two promotions competing for the same
fixtures. Removed along with its metadata source assignment; the default Nuvio
"Football" folder now points at the Premier League and Champions League
promotions instead.

The wizard was improved in the same change so it loses nothing: a Premier League
pick now carries the curated `epl` alias preset, which knows the forms a
mechanical deriver misses — Wolves for Wolverhampton Wanderers, Spurs for
Tottenham. Verified: a wizard-created Man United matches both
"Man Utd vs Wolves" and "Manchester United vs Wolverhampton".

`scripts/test-man-united.js` and its `test:manutd` npm script are gone; the
script file can be deleted.

## 0.89.0

### Select your team

The stated goal, from the start: pick your Premier League club, NFL, NBA and
MLB team, and the catalogs are produced with no further configuration. The
Configure page now does exactly that — four choosers, each turning a pick into a
promotion with Upcoming and Recent catalogs, refreshed immediately so it is
never an empty row you have to trust.

A pick produces one of two shapes, and the difference matters:

- **A football club gets a team feed.** football-data's `/teams/{id}/matches`
  returns that club's fixtures from every competition the key covers, which is
  why the shipped Man United promotion spans the league, both domestic cups and
  Europe. Substituting a filtered league feed would have quietly dropped every
  cup and European fixture — the opposite of "results in all competitions".
- **A US team gets its league, narrowed.** ESPN and statsapi have no per-team
  schedule endpoint here and the league call costs the same either way, so the
  promotion fetches the league and keeps its own club's fixtures through a new
  `teamFilter`, matched on provider team id first and naming forms second.

Supporting work: `fetchCompetitionTeams` for football-data and `fetchTeams` for
ESPN (32 NFL, 30 NBA, 30 MLB clubs with logos), team lists cached for twelve
hours because they change once a season, and MLB fixtures now carry structured
team names and ids like ESPN and football-data already did.

Picking the same team twice updates its promotion rather than leaving a second
copy of the catalogs behind. A chooser whose provider is unconfigured or down
says so and leaves the other three working.

**Creating a promotion stays admin-only.** The wizard is on the Configure page
because choosing a team is a user's decision, but a promotion is shared by
everyone on the server — so a non-admin sees the picker, sees what it would do,
and is told an admin has to create it. Hiding it would be worse: they would have
no way to know what to ask for.

### The Configure / Admin line

As specified: Configure is what a user chooses, Admin is what an operator runs.

- The team wizard opens the Configure page.
- **Nuvio collection folders are now edited on Configure**, embedded rather than
  linked, next to the export they feed. Arranging folders changes what everyone
  sees, so the editor is admin-only in place, with an explanation for everyone
  else.

## 0.88.1

### A club's own name spelled out is no longer mistaken for a different club

0.87.1 stopped one club matching inside another's name ("Milan" inside "Inter
Milan") by requiring the word in front of a match to belong to the same club.
Diffing two live exports showed that cost exactly one real match:
football-data registers Atlético Mineiro as **"CA Mineiro"**, so none of its
three naming forms contain "Atletico" — and the release writes "Atletico
Mineiro". The leading word was the club's own name, and the rule could not know
it.

The provider's own abbreviation is the signal. A multi-word form beginning with
a short prefix ("CA") says the club HAS a spelled-out prefix, so a long leading
word starting with one of those letters is plausibly that expansion.

Deliberately narrow: only the prefix of a **multi-word** form counts. A
standalone three-letter code must not, because MIL is AC Milan's tla and its
"I" would put "Inter" straight back through the gap the rule closes. Both
directions are pinned by tests, along with a different club that also begins
with "Atletico" still being refused.

## 0.88.0

### Release-first ingestion

The catalogs are built from fixture feeds, and no feed covers everything the
site carries. A scan found 620 releases within a day of some fixture that
matched nothing at all — rugby, tennis, the South American cups — because no
promotion claims those competitions and, for several of them, no free feed
exists to claim them with. All of it was being discovered and thrown away.

For exactly that remainder the direction is now inverted: the release becomes
the event.

- Seven "Discovered" promotions, one per sport the discovery index labels,
  each owning the releases no fixture feed claimed. The metadata is weak by
  construction — a name parsed from the release title, the date the site
  published it against, a generic mark — which is the trade this is for. Where
  a real feed exists it wins, and the release never reaches ingestion.
- Implemented as an ordinary source (`source: 'sport-video'`) rather than as
  something writing events directly, so pruning, the event window, catalogs,
  streams, the availability gate and the Nuvio export all work with no special
  cases. The next Sport-Video rematch links the release back to the event it
  produced, so playback and TorBox warming need no new plumbing either.
- Event ids are derived from the release's own identity, so a rescan produces
  the same event rather than a duplicate.
- A release matched only to the event it previously created still counts as
  unclaimed. Treating that as claimed would make the event vanish on the next
  refresh and return on the one after, flickering forever.
- Relevance for these promotions is replaced, not extended. The generic matcher
  decides a non-matchup event on promotion keywords, which a discovered
  promotion has none of — that would either accept every release sharing a date
  (the NFL false-positive shape) or reject the event's own release for lacking
  a keyword nobody writes. The question here is exact: the event was built from
  a release title, so a relevant release still has to carry that title.

Catalog count goes from 52 to 66. Disable the sports you do not want in
Admin → Promotions; the availability gate will not hide these, since by
construction every one of them has content.

### Prepared no longer reads as a funnel it never was

Preparation and matching are independent, so the Sport-Video card could show
more prepared than matched — which is what happens to releases prepared while
the NFL matcher was over-accepting, and then correctly disconnected by 0.86.2.
The card now counts prepared-and-matched, and names the orphans separately
instead of leaving the arithmetic looking broken.

## 0.87.1

Two findings from the first live export after the leagues shipped — 233 matches,
0 false positives, and exactly one genuine miss.

### "Club" hid a club

football-data registers "Club Atlético de Madrid"; the release says "Atletico
Madrid". "Club" and "Clube" are pure filler and now strip alongside the FC/CF
initialisms. Disambiguating prefixes are deliberately still kept — "AC Milan"
reduced to "Milan" would be worse than the problem it solved.

### One club found inside another club's name

Adding Serie A exposed a collision that would have shipped as a false positive:
AC Milan's short name is "Milan", which is a whole word inside "Inter Milan".
Both the boundary regex and the contiguous matcher said yes, so a Juventus vs
Inter release would have attached to a Juventus vs Milan fixture.

Team matching now checks the word in front of the match: it has to belong to the
same club. "Borussia Dortmund" is fine for a club named "Dortmund" because
"Borussia" appears in its own naming forms; "Inter Milan" is not, because
"Inter" appears in none of Milan's. Verified in both directions — Inter still
matches "Inter Milan".

## 0.87.0

### Ten leagues, chosen from what the site actually carries

A scan showed 620 discovered releases matching no event in any catalog. These
are the competitions behind the largest blocks of them, so every one of these
fixtures was being found and thrown away:

- **WNBA** and **College Football** on the existing ESPN adapter — one line of
  configuration each, and the two biggest single blocks (56 and 33 releases).
  Each path was checked against the live endpoint first: a wrong one answers
  200 with an empty list rather than an error. CFL was checked and rejected on
  those grounds — ESPN still serves the path, but its newest fixture is 2022.
- **La Liga, Premier League, EFL Championship, Serie A, Brasileirão, Ligue 1,
  Bundesliga and Eredivisie** on football-data.org. A key without access to one
  competition fails that promotion's refresh with a clear message and leaves
  the others working.

### Clubs are recognised whichever name the release used

Adding the feeds was the easy half. The two sides name clubs differently, and
on first measurement only one pairing in six matched:

- **Accents were destroyed, not folded.** The plain team matcher stripped every
  non-ASCII character, so "München" became "m nchen" and could never match a
  "Munchen" release. It now folds through the same helper the rest of the
  codebase already used.
- **Legal affixes.** "Manchester City FC" from the provider against a
  "Manchester City" release. Both team paths now also try the affix-stripped
  scene form.
- **Connector words.** "Celta Vigo" against "Celta de Vigo". Dropped from both
  sides — while the match stays contiguous, so "Real Madrid" still cannot be
  assembled out of "Real Sociedad vs Atletico Madrid".
- **football-data fixtures now carry every naming form the provider supplies**
  (name, shortName and tla) rather than only the one the event is titled with.
  That is what makes "Man City" find a "Manchester City" release, and "Inter"
  find "Inter Milan".

All five real pairings that failed on first measurement now match, and the
three near-miss collisions above are still refused.

Not covered, and left deliberately: rugby (170 releases — no free fixture feed
found), tennis (61), and the Argentine and Copa competitions (41), which are
outside football-data's free tier.

## 0.86.2

### Every NFL fixture was matching every American-football release on its date

Two compounding bugs. In a real export, 234 of 252 NFL "matches" were wrong —
college and CFL games attached to NFL fixtures, each one offered as "Warm to
TorBox" in the console.

- **" at " was not a matchup separator.** Every team check reaches its team
  list by splitting the fixture name, and the splitter knew `vs`, `v`, `@` and
  `-` but not `at` — the separator the ESPN adapter produces. For NFL and NBA
  no team check ran at all. This was introduced in 0.84.0 on the stated
  assumption that "the promotion matchers already split on" that convention.
  They did not.
- **The site's category blurb satisfied the keyword check.** With the team
  check skipped, relevance fell through to keywords, and Sport-Video appends a
  per-category blurb to every index entry — "NFL CFL UFL NCAAFB …" on every
  American-football entry, "MLB … Major League Baseball" on every baseball one.
  Any release in the section therefore satisfied the promotion's keyword.

Fixed on both sides:

- Structured home and away names supplied by an adapter are now used directly,
  without parsing the fixture title at all. That removes the dependency on
  title formatting, and on getting home and away the right way round — which
  splitting "Away at Home" as home-first also got wrong. `at` was added to the
  separator list for everything that still parses names.
- The index title is now a supplement, never a substitute. It is retried only
  when the release's own name already identified the fixture and the single
  objection was a missing competition keyword. Any other rejection — wrong
  teams, wrong date, an exclusion — stands. The legitimate case it was added
  for still works: a bare "AEK Athens vs Levski Sofia 26.08.2026" is still
  rescued by the "UEFA Champions League" suffix.

Anything already warmed to TorBox on a bad match stays in TorBox; the wrong
rows disappear from the console on the next scan.

## 0.86.1

### A nationality in an event name was read as a language tag

- The foreign-language filter rejected any release title containing an English
  nationality adjective. Sport is full of those as place names — the F1 and
  MotoGP calendars are literally a list of them — so "Formula 1 Hungarian
  Grand Prix Practice 1" was dropped as Hungarian audio.
- In a real diagnostics export this was the ONLY genuine false negative among
  14,758 rejections, and it was enough to leave F1 and MotoGP matching nothing
  at all.
- Ambiguous words are now guarded against the nouns that make them a place
  (Grand Prix, GP, Open, Masters, Cup, League, Championship and friends).
  Native-language names — DEUTSCH, ESPANOL, MAGYAR, POLSKI — need no guard and
  are still rejected outright, as are real tags like "GERMAN DUB".

### Match diagnostics: near misses are now separable from noise

Every event is replayed against every release within a day of it, so the great
majority of rows are one sport's fixture being correctly rejected against
another sport's release. Read raw, that looks like catastrophic failure.

- Two new CSV columns: `name_overlap` (share of the event's distinctive words
  present in the release title, 0-1) and `near_miss` (a rejection whose release
  really does look like this fixture). Sort on those and the list worth reading
  drops from ~14,000 rows to a few dozen.
- The summary now counts near misses and groups them by reason, so the report
  says how many rejections are actually suspicious rather than only how many
  there were.

## 0.86.0

### Catalog availability gate

The fixture feeds are a schedule; the catalogs are meant to be a library. On a
real deployment most stored events have nothing behind them, and a catalog full
of unwatchable fixtures reads as the addon being broken rather than the content
not existing.

- New Admin -> Database switch: **only show events with known content**. With it
  on, a catalog lists just the events something has actually been found for.
- "Known content" merges two sources that previously knew nothing about each
  other: every event the SQLite availability index has stored a release
  against (TorBox, Prowlarr, Usenet Ultimate, Easynews, the DIY lane) and every
  event a Sport-Video release matched. The merged set is cached for a minute,
  so the gate costs nothing per request.
- The gate is deliberately scope-blind. Availability in the index is per
  provider and per credential scope, but "this fixture has content somewhere"
  is a property of the event, not of one viewer's account.
- Curated events are always shown. An operator who added an event by hand meant
  it.
- Optional second switch keeps future fixtures visible even with nothing found
  yet, for anyone who wants Recent cleaned up without losing the schedule.
- The gate fails open. If the availability data cannot be read at all, it hides
  nothing rather than emptying every catalog on the deployment at once.
- The admin card shows coverage per promotion — events, how many have content,
  and what the gate would leave — *before* the switch, because turning a gate on
  blind is how you end up with empty catalogs and no idea why.

Off by default: turning it on visibly changes what every client sees.

## 0.85.1

### A newly added promotion could show a permanently blank row

- Catalog and meta responses were cached for an hour regardless of content, so
  a client that asked for a catalog before its promotion's first refresh cached
  the empty answer and kept showing an empty row for the next hour. The catalog
  was registered in the client and served correctly by the addon — NFL and NBA
  hit exactly this after 0.84.0, while every older catalog worked.
- An empty catalog and a meta miss are now revalidated instead of cached. A
  populated response still carries the full hour.

## 0.85.0

Four defects reported against 0.84.0.

### NFL preview failed with "ESPN scoreboard exceeded its size limit"

- The adapter's byte cap was sized from a browser probe that ESPN answered with
  a trimmed payload. A real refresh asks for `eventWindowDaysBack` +
  `eventWindowDaysAhead` — 120 days by default — in one request, and that
  response is larger than the cap.
- Fixed by bounding the request rather than raising the ceiling: the range is
  split into 31-day windows and the results de-duplicated by fixture id, so no
  single response can grow unbounded whatever the window setting. NBA was
  unaffected and its 385-fixture import confirmed the parser itself was sound.

### A promotion preview could hang on "Fetching and comparing events..."

- TheSportsDB's client was the only adapter with no request timeout at all, and
  its 429 back-off had no overall budget: four rate-limited retries could sleep
  for roughly seven minutes while the admin request stayed open.
- It now uses a 20s per-request timeout and refuses a retry it cannot afford
  within its budget, reporting the rate limit instead of waiting through it.
- Independently, "Preview refresh" now has a 60s deadline of its own, so any
  slow source reports failure rather than leaving the panel spinning. A preview
  writes nothing, so abandoning the in-flight work is safe.

### Catalog and home-row changes appeared not to save

- The manifest was being served with `max-age=3600`. It is configuration, not
  content — it carries the catalog selection, the published order and the
  `showInHome` hint — so a change saved on the Configure page could not take
  effect until the client's cache expired.
- It is now revalidated on use. Express's ETag keeps that a 304, so repeat
  requests stay as cheap as they were.

### Removing a promotion from a Nuvio collection folder did not save

- Emptying a folder was refused outright, which made removing a promotion
  impossible for any folder holding only one, and any folder emptied as a
  side-effect of a move was silently deleted.
- An existing folder may now be emptied and is kept. The export already skips
  folders that resolve to no catalogs, so nothing malformed reaches Nuvio, and
  Remove stays the explicit way to delete a folder. A brand-new folder with
  nothing selected is still refused.

## 0.84.0

### NFL and NBA

- Added ready-to-use NFL and NBA promotions, backed by a new ESPN scoreboard
  adapter that needs no key and no account.
- TheSportsDB was measured first and rejected: on the shared key its season
  endpoint returns about fifteen events for a 272-game NFL season. ESPN returns
  the full slate — 285 NFL fixtures for a season range, 71 NBA fixtures across
  nine days.
- Fixtures are named "Away at Home", the same convention MLB already produces,
  so promotion matching, alias generation and the Sport-Video team filter all
  work unchanged.
- Exclusion rules cover the studio programming that carries both team names on
  the same day — RedZone, condensed games, NFL Network and NBA TV shows,
  Summer League and G League.
- The adapter also knows NHL and MLB paths, so either can be added later
  without new code.

### Structured team names

- `transform.fromWiki` now carries structured home and away names when the
  adapter supplies them. ESPN provides four naming forms per side — full name,
  location, nickname and abbreviation — which the team filter and team-aware
  matching both prefer over splitting a fixture title.

### Custom promotions

- `espn` is accepted as a custom promotion source with a validated league
  reference, so the forthcoming team wizard can create these promotions through
  the same path as any other.

The ESPN endpoint is undocumented and carries no compatibility promise — the
same trade already made for MLB's statsapi feed. The adapter fails soft: a
shape change drops individual records rather than failing a refresh, and that
behaviour is covered by tests built from real captured payloads.

## 0.83.0

### Narrow Sport-Video to the teams you follow

- Added a per-promotion team filter to the Sport-Video page. Selecting Man
  United under its promotion, or the Yankees under MLB, restricts torrent
  detail fetching and automatic TorBox warming to that side's fixtures.
- The selectable teams are derived from your own catalog — every side appearing
  in a fixture over the last 120 days, ordered by how many fixtures it appears
  in — rather than a hardcoded club list, so the picker stays correct as
  competitions come and go.
- Filtering applies only to the expensive half. Everything still matches, stays
  listed in the console, and appears in the diagnostics export; the Prepare and
  Warm to TorBox buttons ignore the filter entirely.
- A promotion with nothing selected is not filtered. Boxing, UFC and anything
  else without a recurring line-up therefore behaves exactly as before, and
  selecting an MLB team does not silently narrow Champions League.
- The filter fails open wherever it cannot judge: a release matched before this
  release carries no team names, and a fixture whose title does not name two
  sides is never dropped by a rule that could not have applied to it.
- Matches now carry both sides of their fixture, so the filter needs no catalog
  lookup — the same approach used for the fixture date in 0.81.4.
- The scan panel reports how many matched releases the team filter skipped.

Man United is unaffected in practice: that promotion is already team-scoped
through football-data, so it has always pulled the club across every
competition. The filter matters for the competition-wide promotions — MLB is
roughly 2,400 fixtures a season, and every one of them was previously a
candidate for preparation.

## 0.82.0

### Request-path performance

- The Sport-Video store is cached on file modification time instead of being
  re-read and re-parsed on every request. Discovery through the search index
  had grown the file to roughly 1.5 MB, which made each read an 11ms
  synchronous parse — paid once when an event is opened and again when a row is
  played. A repeat read is now 0.005ms, and an edit made outside the process is
  still picked up.

### Stored state

- Added a numbered migration runner. Fields added to release records since
  0.81.0 were each absorbed by a fallback at the point of use; those are
  replaced by one forward-only migration that normalises the shape on load.
- Matches written before 0.81.4 gain the fixture date they were missing.

### Caching correctness

- Addon payloads are now `private` rather than `public`. These URLs embed the
  account's API token, so a shared proxy could hold one account's catalog and
  serve it to another viewer. Browser and client caching is unaffected, and
  conditional requests are still answered with a 304.
- Added `stale-if-error` so a transient upstream failure serves the last good
  catalog instead of an empty one.

### Tests

- Added route-level tests covering the HTTP surface, which had no coverage at
  all: every unauthenticated `/admin` route is walked from the live router,
  per-user addon routes are checked against wrong, truncated and absent API
  tokens, and the signed resolve endpoint is checked against unsigned,
  tampered, expired and cross-account links.
- Added a deployment contract test asserting the container hardening, the
  loopback-only default binding, resource limits, the absence of committed
  secrets, and that the publish workflow verifies before it builds.
- Added coverage for the store cache and the migration runner.
- 186 tests to 205.

### Release safety and resources

- `container.yml` now runs the full unit suite before building. It is a
  separate workflow from `ci.yml` with no dependency between them, so a failing
  suite could previously still publish `:latest` — as happened with 44bc161.
- Added a memory ceiling, CPU limit and log rotation to the compose file, all
  overridable through `SSS_MEM_LIMIT` and `SSS_CPUS`.

## 0.81.4

### Automatic work is bounded to a rolling window

- Added an **Automatic window** setting, default 14 days. Automatic preparation
  and automatic warming both stop for fixtures older than this.
- TorBox keeps a cached copy for at least 30 days, so an older fixture is
  either still cached — in which case warming it achieves nothing — or has aged
  out with nobody watching. Either way the per-scan budget belongs to current
  fixtures.
- Matches now carry the fixture date, so age is judged against the event rather
  than the release. Records stored before this release fall back to the release
  date, which matching already guarantees is within a day of the fixture.
- Upcoming fixtures are always inside the window.
- The manual Prepare and Warm to TorBox buttons ignore the limit entirely, so
  an old fixture can still be fetched deliberately.
- The scan panel reports how many matched releases sit outside the window.

## 0.81.3

### Match diagnostics export

- Added a downloadable match diagnostics report to the Sport-Video page, as CSV
  for spreadsheet analysis or JSON for the full detail.
- Covers every catalog event in a chosen window, filtered to one promotion or
  across all of them: the event's aliases, its provider team identities, the
  search queries SSS generated for it, every Sport-Video release within a day
  of it, and the decision made about each.
- Rejections now carry the stage and the reason — `release-filter:sports-noise`,
  `event-exclusion`, or the promotion's own verdict such as `no-away-team-alias`
  — instead of a release simply being absent from the matched list.
- Events with no nearby release are reported explicitly rather than omitted, so
  a supply gap is distinguishable from a matching failure. That distinction is
  the point: the first run of this report showed Champions League matching every
  release the source actually had, with the misses being fixtures the source had
  never published.
- Records whether each release is prepared, its info hash, and when it was
  auto-warmed, so the export cross-references against a TorBox library.
- Read-only: no network calls, no TorBox lookups, no state writes. Torrent URLs
  are never included, and CSV cells beginning with `=`, `+`, `-` or `@` are
  prefixed so a release title cannot execute as a spreadsheet formula.

## 0.81.2

### Discovery now uses the site's own search index

- Sport-Video's search box is client-side, backed by one static index of every
  page on the site. Reading that file is a single request that returns about
  1,860 dated releases — against roughly 300 reachable from the seven per-sport
  pages and ~700 from the bounded archive crawl 0.81.1 added.
- Discovery reads that index first and falls back to the listing crawl only
  when it cannot be read or returns implausibly few entries, so a change to the
  site's search degrades coverage instead of ending discovery.
- Conditional requests: an unchanged index costs a 304 rather than a megabyte.
- Index titles carry the competition ("… 26.08.2026 UEFA Champions League"),
  which the listing cards never did. Matching accepts either the card-style
  title or the fuller index title, so a promotion identified by keyword rather
  than by team can now match a plain "Team A vs Team B date" release.
- Sport labels are derived from the index title's own wording, and a label a
  category page confirmed is never downgraded to a derived one.

### Event-first matching

- Releases are compared only against fixtures within a day of them, instead of
  against the whole catalog. Matching a full site index stays cheap.
- Retention raised to 6,000 releases so a scan cannot evict what it just found.

### Opt-in automatic warming

- Promotions can be individually selected for automatic TorBox warming. A
  selected promotion has its matched, already-prepared releases submitted
  during a scan, bounded by a per-scan cap (default 5).
- Warming respects each account's catalog selection and only runs for accounts
  holding a TorBox key. Nothing is submitted for unselected promotions, which
  remains the default for every promotion.

## 0.81.1

### Sport-Video discovery coverage

- Added the dated archive index to discovery. The seven per-sport catalogue
  pages together list roughly 300 releases, while one month of the archive
  lists about 600 across ten paginated pages, most of which never appear on a
  category page at all.
- Archive pages are discovered from the site's own index and read newest first,
  bounded by a new **Archive pages per scan** control (default 12, 0 to read
  the sport pages only).
- A release found only on an archive page keeps any sport label a category page
  gave it previously, and is listed under "From archive" until one does.
- Raised the per-page size ceiling from 1 MB to 3 MB. The ceiling throws rather
  than truncates, so one page outgrowing it would have failed the whole scan.
- An unavailable archive index no longer discards the category results that
  already succeeded.

### Matching against current metadata

- Stored releases are now re-matched against the event catalog on every scan,
  not only when rediscovered. Sport-Video publishes ahead of metadata
  refreshes, so a release scanned before its fixture existed was previously
  stamped "No current SSS event" permanently.
- Added a **Re-match events** action that re-evaluates stored releases against
  the current catalog without any network access.
- Matching now applies the same sports-noise, foreign-language and per-event
  exclusion filters the stream pipeline applies. The console could previously
  offer a Warm button for a title the event's own stream request would reject.
- Releases rejected by those filters are shown as "Filtered out" with the
  reason, instead of being indistinguishable from genuinely unmatched rows.

### Warmed releases in Nuvio

- Fixed prepared releases being dropped before they could be served. Candidate
  selection sliced matched releases to the row limit *before* filtering for a
  usable info hash, so an event with more matches than the limit could discard
  its one prepared — and possibly already warmed — release, then return nothing
  once the hash filter removed the rest.
- Sport-Video reports resolution as a pixel geometry on the detail page rather
  than a scene token in the title. That geometry now travels with the candidate
  and is used for stream ranking and row labelling, so these rows no longer
  sort below every other result and fall outside the row cap.
- Candidate selection prefers already-prepared releases and reports its own
  status, resolution and video details to the stream pipeline.

## 0.79.0

- Add Companion Release Intelligence as a first-class Alias Research source, using recent title-only metadata before live event searches.
- Open shipped/read-only promotions through a dedicated Matching Lab with catalog-event selection, research, confirmation, rule generation, and safe report copying.
- Persist matching overlays separately from shipped promotion definitions so user aliases, templates, exclusions, and date rules survive image upgrades without replacing bespoke promotion logic.
- Mark tuned built-in promotions in the Promotions list and allow one-click restoration of shipped matching rules.

## 0.78.0

- Rebuild Promotion Wizard Alias Research around broad, rule-independent event queries so a new promotion can discover naming conventions before its aliases exist.
- Allow explicit research requests to use Companion's longer research window without increasing playback latency.
- Search up to six focused variants across configured DIY Usenet, Usenet Ultimate, Easynews, and Companion sources.
- Add user-confirmed release training and a sanitized, copyable research report containing queries, source counts, titles, and matching decisions—never credentials, hashes, trackers, or download links.

## 0.77.1

- Added SSS Companion as an Alias Research source, covering the torrent
  discoveries that feed the TorBox pipeline alongside the existing Usenet
  research providers.
- Companion results remain research-only: Alias Research does not query the
  TorBox cache, warm content, or start playback.
- Info hashes, magnet trackers, authentication tokens, and all download data
  are stripped before results reach the browser.

## 0.77.0

- Added admin-only Alias Research to the Promotion Wizard. Select a real event
  and SSS searches the account's configured DIY indexer, Usenet Ultimate, and
  Easynews services without downloading or submitting anything.
- Groups sanitised release metadata into matched, needs-review, and rejected
  results, with the current matching decision shown for every title.
- Shows per-provider status and the exact generated search queries, then offers
  one-click application of confirmed examples and conservatively derived rules.
- Provider credentials, manifest identifiers, download URLs, NZB URLs, Easynews
  playback data, and raw network errors are excluded from browser responses.
- Possible matches require explicit review and are never silently used to teach
  one-click aliases.

## 0.76.4

- Fixed provider query planning overriding a promotion's strongest curated
  release query with a shorter nickname variant.
- Reduced the shipped Champions League UU search from eight variants to three
  focused variants. UU/Prowlarr can now return completed hits before SSS's
  stream deadline instead of losing the whole response while slower searches
  are still running.
- Added regression coverage using the observed LASK vs Celtic query ordering.

## 0.76.3

- Corrected the module scope of the automatic team-identity fallback so legacy
  cached events and optional API-Football events receive the same suffix-free
  query generation as freshly refreshed UEFA events.

## 0.76.2

### Automatic UEFA release identities

- Derived search and matching identities from every name supplied by UEFA,
  including official, display, international, short, and team-code forms.
- Added provider-neutral removal of common football registration prefixes and
  suffixes such as `FC`, `CF`, `AFC`, `FK`, `NK`, `GNK`, `PFC`, `SK`, `SC`,
  and `BC`. Newly qualifying clubs now work without maintaining a seasonal
  hardcoded alias list.
- Added accent and punctuation folding for scene names such as `Bodø/Glimt` →
  `Bodo Glimt`, while retaining the authoritative Unicode identity for display.
- Fed dynamic team identities into both query generation and strict two-team
  candidate matching. Curated aliases still take priority for non-obvious
  identities such as PSG, Bayern, Inter, and Atlético Madrid.
- Added UCL search variants for round/leg labels, `DD.MM.YYYY`, and final-style
  `FINAL DD-MM-YYYY` naming observed in real indexer results.
- Compared the supplied manual Usenet sample against live UEFA fixtures: 44 of
  45 unique 2026 men's releases matched exactly one fixture with zero ambiguous
  matches. The remaining title had no corresponding fixture in UEFA's schedule.

## 0.76.1

### Official UEFA Champions League metadata

- Replaced the shipped Champions League dependency on API-Football with the
  public fixture feed used by UEFA.com. The default catalog now needs no API
  key, account, subscription, or free-plan season entitlement.
- Added Official UEFA as a reusable Metadata provider. It supports numeric UEFA
  competition IDs, read-only previews, production refreshes, current European
  season selection, bounded pagination, and event-window filtering.
- Preserved official match and team IDs, full English club identities, kickoff
  times, rounds, venues, crests, and stadium artwork. API-Football remains
  available as an optional provider for users whose plan covers their season.
- Corrected the generic football alias ranking so each curated release-friendly
  club name is searched before longer formal variants. UEFA's `Atleti` identity
  now produces `Atletico Madrid`, `Atletico de Madrid`, `Atlético de Madrid`,
  and `Atleti` matching without a one-off event fix.
- Updated installation, Metadata, and Admin guidance to stop implying that the
  API-Football free plan includes current Champions League seasons.

## 0.76.0

### API-Football metadata source

- Added API-Football as a first-class reusable metadata provider with an
  encrypted API key, provider creation, read-only event preview, production
  refresh support, quota-aware season selection, and clear authentication or
  provider error reporting.
- Preserved API-Football fixture IDs, team IDs, full team names, competition
  rounds, venues, crests, and league artwork in normalized SSS events. Full
  team names are used for display and search rather than a provider's shortened
  label becoming the only event identity.
- Kept every existing football-data.org source and assignment intact. Users
  can select either provider for new or existing promotions.

### Shipped UEFA Champions League promotion

- Added UEFA Champions League as a default promotion backed by API-Football
  competition `2`, with upcoming and recent catalogs and a seeded Metadata
  source that can be previewed or reassigned normally.
- Preserved an existing user-created promotion whose internal ID is already
  `ucl`; the shipped default yields to it instead of replacing its settings.
- Applied the existing UCL team identity preset automatically and prioritized
  exact scene-style queries such as `UEFA Champions League 2026.05.05 Arsenal
  vs Atletico Madrid` before broader alias variants.
- Required both selected teams and the fixture date, while rejecting women's,
  youth, U19, and highlights releases before playback rows are created.

## 0.75.0

### End-user-safe promotion matching

- Made both teams a hard requirement for matchup events. Broad competition
  aliases such as `UCL` can no longer admit a different fixture, including a
  Real Madrid result or PSG–Arsenal final for Bayern–PSG.
- Added two-digit date recognition for older release styles such as
  `21.07.18`, preventing historical repeats from bypassing fixture dates.
- Stopped event stages such as `FINAL`, `Semi Final`, `Quarter Final`, `Round`,
  and `Leg` from being learned as promotion aliases. Existing saved aliases
  are cleaned automatically when promotions load.
- Football-data schedules now automatically enable exact-date matching for
  newly created promotions unless the user explicitly changes the advanced
  preference.

### Usenet searches that finish in time

- Added a provider query planner that ranks exact-date matchup searches and
  sends a compact set of six variants to Usenet providers instead of blindly
  forwarding as many as 60 generated permutations.
- Bounded foreground Easynews to four short, ranked searches with per-query
  and total deadlines. Usenet Ultimate now receives an inner timeout that
  completes before SSS's eight-second stream response deadline.
- Applied the same ranked search plan to background availability warming,
  reducing unnecessary provider and indexer load.
- Added a per-promotion option to include non-English releases. Rejection logs
  now distinguish sports noise, foreign-language filtering, and custom
  promotion rules instead of reporting every exclusion as generic noise.

## 0.74.1

### Complete TorBox result refresh

- Fixed confirmed availability being mistaken for the event's complete result
  set. One ready database row could previously hide other matched candidates,
  including a second candidate that had just finished warming.
- Confirmed rows are now merged with the full stored discovery result. Fresh
  cached rows remain instant, `warming` candidates are rechecked on every
  Refresh Links request, and fresh negative observations avoid unnecessary
  TorBox calls.
- Added the ONE Friday Fights regression case: three matched candidates with
  one ready, one newly warmed, and one unavailable must return two playable
  TorBox rows plus the remaining warm action.

## 0.74.0

### User-created metadata providers

- Moved provider creation clearly into Metadata. Promotions now selects a
  tested saved provider and links back to the creator instead of presenting a
  fixed list of shipped adapters as the creation workflow.
- Added a no-code custom JSON/API provider. Users can enter a public schedule
  endpoint and map dotted paths for its event list, name, date, stable ID,
  time, venue, description, and artwork.
- Added read-only preview and normalized sample events before a custom provider
  is saved. Responses are bounded, redirects are revalidated, cloud metadata
  addresses are blocked, and no user-supplied JavaScript is evaluated.
- Connected custom providers to both preview and production event refreshes so
  they can be assigned to any compatible user-created promotion.

### Reliable Nuvio link refresh

- Prevented Express-generated conditional `304` responses on account stream
  lookups. Every Refresh Links request now receives a complete, freshly built
  response, avoiding the case where Nuvio clears a warmed row and receives no
  replacement body.

## 0.73.0

### Guided promotion creation

- Rebuilt promotion creation as a five-step wizard covering the user-facing
  name, event schedule, real release examples, optional artwork, and a final
  plain-language review.
- Let users link a saved schedule or create a reusable schedule from a
  TheSportsDB, MLB, ONE Championship, football-data.org, or TMDB provider in
  the same workflow. Recognised official schedule URLs can be pasted directly.
- Added a non-destructive schedule test with normalised sample events before a
  new promotion can continue, with credentials redacted from failures.
- Kept indexer release discovery and automatic alias/search-pattern learning in
  the guided path, while moving manual matching, pipeline, football, and date
  controls under clearly labelled Advanced sections.
- Made promotion and newly created schedule persistence transactional: if the
  promotion is invalid, the unused schedule is removed instead of being left
  behind.

### Clearer TorBox warming

- Updated warm result rows to tell users to check the TorBox dashboard and use
  Nuvio's **Refresh Links** once caching completes.

## 0.72.1

### TorBox warm refresh hotfix

- Made account-scoped stream responses private and non-cacheable so Nuvio's
  **Refresh Links** action always reaches SSS after a TorBox warm.
- Replaced a candidate's remembered `unavailable` state with `warming` as soon
  as SSS successfully submits it, allowing each refresh to recheck TorBox
  instead of waiting for the negative-cache TTL.
- Made existing warm links self-healing: clicking a stale **Warm to TorBox**
  row after the torrent becomes ready now resolves directly to playback.
- Stopped reporting a warm submission as successful when TorBox did not return
  a torrent ID, and kept transitional file-list readiness refreshable.

## 0.72.0

### Structured debug console

- Upgraded Logs into a structured, live debug console inspired by mature
  self-hosted media tooling, while keeping the default view readable for normal
  operation.
- Added trace, debug, info, warning, error and fatal level filters; category,
  account, plain-text and regex search; true server-sent live updates; pause,
  auto-scroll and jump-to-latest controls.
- Added expandable structured details, request IDs and stream context so one
  playback attempt can be followed through its query variants, pipeline
  durations, discovery totals, rejection decisions and cache outcomes.
- Added per-entry copy, copy-visible, readable `.log` and machine-readable
  `.ndjson` downloads, plus a guarded clear action and persistent display
  preferences.
- Bounded the in-memory log store by both entry count and bytes, and redacted
  secret-bearing structured fields before they reach the browser or exports.

## 0.71.0

### Operations console and availability funnel

- Rebuilt Logs as a responsive operations console with a dense terminal-style
  view, live pause/resume, selection-safe updates, fast filters, wrapping,
  one-click copy, plain-text export, auto-scroll and connection feedback.
- Added colour-coded summaries, warnings, errors and rejection rows so the
  discovery and filtering path can be understood at a glance.
- Logged a bounded sample of rejected release titles for every exclusion
  reason by default, with a persistent Logs switch to show every rejection
  while diagnosing matching problems.
- Replaced the ambiguous Recent searches result total with a discovery funnel:
  `discovered -> matched -> ready`. Existing databases migrate in place and
  older rows show an outcome-pending state until searched again.
- Recorded Torrent/TorBox match and immediate-cache counts after filtering, so
  broad discovery results such as `153 discovered -> 2 matched -> 1 ready` are
  represented accurately.

## 0.70.0

### Selective automatic preparation

- Kept Smart Availability enabled for every normal interactive pipeline while
  separating that low-cost search reuse from optional background work.
- Replaced the blanket warmer controls with plain-language automatic
  preparation choices. Torrent/TorBox is prepared by default; Usenet and
  Easynews remain on demand unless explicitly selected.
- Reduced the default recent-event preparation window from seven days to three
  and excluded events outside each account's selected catalogs.
- Confirmed that NZB DAV and native NNTP playback are never submitted, probed,
  or downloaded in the background; only an opted-in shared search source can
  be prepared.
- Fixed failed Companion/direct-Prowlarr discovery being reported as a
  successful torrent preparation, allowing diagnostics and the per-run circuit
  breaker to reflect real failures.
- Added automatic expired-row pruning at the start of preparation runs and
  surfaced the cleanup count on the Database page.
- Renamed warmer-facing controls and status text around the user outcome:
  preparing recent events so links appear faster.

## 0.69.2

### Release workflow hotfix

- Made the disposable CI session values available to every container workflow
  step so required Compose interpolation also succeeds while collecting logs
  and removing the public-image smoke-test stack.

## 0.69.1

### Fresh-install documentation

- Rebuilt the GitHub landing page around a clearly signposted fresh-server
  installation and recovery guide, including Linux and PowerShell commands,
  LAN binding, first login, verification, updates, backups, rebuilds, and
  common failures.
- Reduced `.env.example` from the full internal tuning surface to the single
  required secret and a few genuinely common deployment choices. Moved the
  retained advanced settings into a categorized configuration reference.
- Made the root Compose bind address and host port configurable while
  preserving the secure loopback default, and fail early when the required
  session secret is missing.
- Marked the bundled Dockge stack as an advanced homelab migration rather than
  a normal install, removed site-specific and retired settings, and restored
  the safe interactive playback deadline.
- Added the planned separation of Prowlarr from the companion to the backlog.

## 0.69.0

### Background discovery reliability and diagnostics

- Limited confirmed-result short-circuiting to interactive stream requests so
  background warming continues through normal discovery and refreshes the
  Smart Availability database.
- Added a per-account, per-provider warm-up circuit breaker. A provider is
  skipped for the rest of a run after two consecutive failures by default;
  the next run starts clean and interactive requests are never suppressed.
- Added live Database diagnostics for provider attempts, successes, failures,
  skipped checks, average and latest latency, last success, latest error, and
  circuit-breaker state.
- Fixed generic MotoGP session parsing so Free Practice and FP1-FP4 labels are
  removed before venue aliases are derived. This fixes malformed aliases such
  as `Aragón Free` without adding a venue-specific workaround.

## 0.68.0

### Confirmed-result serving and database detail

- Database recent-search rows now show the human-readable event title together
  with the stable event ID.
- Added a live Database setting for serving fresh confirmed results. It is on by
  default and can be disabled independently of background warming.
- Added scope-safe confirmed-result retrieval: the event, discovery source,
  provider account and unexpired availability observation must all match.
- TorBox cached/verified results, verified Easynews results, and verified DIY
  NZB DAV/native NNTP results can now bypass repeat discovery. Playback still
  passes through the normal provider resolver, so TorBox eviction and Usenet
  availability are revalidated when the user clicks.
- Database statistics now count confirmed-result lookups and successful serves.

## 0.67.0

### Smart Availability database control centre

- Replaced the legacy admin Health page and sidebar entry with a dedicated
  Database workspace.
- Added live background-warmer progress, current event/account scope, last-run
  results, errors, next scheduled run, provider coverage, hit rate, database
  size, and recent search activity.
- Added validated, persistent GUI controls for the rolling window, schedule,
  event batch size, startup delay, and enabled state. Changes apply to the
  running scheduler without a container restart and can be reset to environment
  defaults.
- Added focused maintenance actions for immediate warming, expired-row pruning,
  and wiping Smart Availability knowledge. The old Health mutation endpoints
  are removed; `/admin/health` redirects old bookmarks to Database.

## 0.66.1

### Configuration and playback compatibility hotfix

- Restored configuration saves from installed-app and private webviews that
  legitimately submit forms with `Origin: null`, while retaining explicit
  cross-site request rejection and SameSite session cookies.
- Restored DIY NZB DAV and native NNTP playback for Newznab/Prowlarr download
  URLs containing provider-issued `apikey` or token query parameters.
- Restored Prowlarr torrent download-proxy hydration for the same legitimate
  credential-query URL format while retaining protocol and metadata-host checks.
- Prevented companion and direct-Prowlarr timeouts or provider failures from
  being stored as successful empty Smart Availability searches. Genuine empty
  searches retain their short negative-cache TTL.

## 0.66.0

### Rolling availability warm-up

- Added a scheduled, non-blocking warm-up that searches events aired during a
  configurable rolling seven-day window rather than waiting for stream clicks.
- Spread work across rotating 25-event batches, reused fresh search TTLs, and
  coalesced overlapping jobs to limit indexer and provider traffic.
- Warmed server-wide torrent discovery plus account-scoped TorBox, Usenet
  Ultimate, native Newznab/Prowlarr, and Easynews knowledge without creating
  downloads or playback jobs.
- Added warm-up status and a manual **Warm recent events now** action to Admin
  Health, with safe controls to disable or tune the window and schedule.
- Moved Account, signed-in profile details, and the POST-only Log out control
  from the top-right dropdown into the sidebar for both admins and users.

## 0.65.0

### Smart Availability Index foundation

- Added a local, WAL-backed SQLite availability database with schema migrations,
  retention, safe backup checkpoints, health statistics, and an admin wipe action.
- Reused fresh Torrent, Usenet Ultimate, native Newznab/Prowlarr, and Easynews
  searches before making repeat provider calls; concurrent identical misses now
  share a single request and negative results use a short TTL.
- Stored provider payloads encrypted and isolated availability observations by
  non-reversible credential/configuration scope fingerprints.
- Reused fresh per-account TorBox cache observations and recorded successful or
  failed TorBox, Easynews, NZB DAV, and native NNTP playback attempts.
- Added reusable Full Event, Main Card, Prelims, Early Prelims, and Unknown
  release classification without changing current stream output.
- Imported legacy positive-cache history without deleting the rollback source.
- Upgraded the container and CI runtime from end-of-life Node.js 20 to Node.js 24
  LTS and raised source installations to Node.js 22 or newer.

## 0.64.0

### P1 security hardening

- Added same-origin mutation enforcement, POST-only logout, scoped addon CORS,
  non-cacheable account/admin pages, and CSP/frame/MIME/referrer/permissions
  browser protections.
- Made forwarded IP/host/protocol trust explicit with `TRUST_PROXY=1`, preventing
  direct clients from bypassing login throttling or spoofing generated origins.
- Added versioned sessions so password and role changes immediately revoke
  existing cookies, and removed production secret fallbacks from session,
  resolve-signature, and encryption code paths.
- Encrypted UU manifest URLs and provider usernames at rest in addition to
  existing provider secrets and private install tokens.
- Hardened configurable HTTP endpoints against URL credentials, secret query
  parameters, cloud metadata targets, unsafe redirects, and proxy-log leakage.
- Added hard response-size ceilings for companion, Prowlarr search/torrent, and
  NZB DAV control traffic; retained existing bounded indexer, WebDAV, NNTP, NZB,
  and archive handling.
- Reduced public health output to operational status only and restricted
  wildcard CORS to client-facing addon API routes.
- Hardened supplied containers with read-only roots, bounded tmpfs, all Linux
  capabilities dropped, non-root execution, and no-new-privileges, with CI
  assertions for those controls.
- Completed a production dependency audit with zero known vulnerabilities and
  added focused security and bounded-response regression coverage.

## 0.63.0

- Fully retired the standalone Power Tool, Search, Match Editor, and Content
  Studio routes, views, and UI-only modules now covered by Promotions.
- Made every legacy URL, including old POST actions, safely redirect to
  Promotions without executing mutations.
- Retained the content store and promotion override data layers so existing
  manual events, editorial decisions, aliases, and exclusions survive upgrades
  and remain rollback-compatible.
- Removed the obsolete admin warm credentials and per-event candidate-search
  helper that were only used by Power Tool.

## 0.62.0

- Added mandatory read-only event diffs before per-promotion refreshes and
  metadata source changes, including added, updated, unchanged, and removed
  counts plus representative event titles.
- Reused the production refresh fetch and normalization path so previews match
  the catalog operation they guard, while keeping preview requests mutation-free.
- Preserved same-title/date doubleheaders as separate source events in diffs.
- Fixed editing embedded legacy MLB promotions incorrectly falling back to TSDB
  validation and demanding a numeric league ID; conflict cleanup can now save.

## 0.61.0

- Added read-only validation and normalized sample-event previews for saved and
  draft metadata sources without changing assignments or catalog data.
- Added a companion-independent release finder to Promotions using each
  account's native Newznab/NZBHydra or Prowlarr connection.
- Added bounded multi-query search plus include/exclude, quality, indexer, age,
  size, sorting, and result-limit controls.
- Added one-click transfer of discovered titles into promotion alias and search
  layout analysis while withholding NZB URLs and API credentials from the UI.

## 0.51.0

- Added native byte-range playback for stored, unencrypted videos inside
  single- and multi-volume RAR4/RAR5 releases without downloading the archive.
- Added bounded RAR volume grouping, header inspection, split-file fragment
  mapping, and exact cross-volume seek handling through the NNTP pool.
- Kept compressed, encrypted, damaged, incomplete, and 7z archives on the
  existing NZB DAV fallback path.
- Added archive volume, entry, header, media-size, and malformed-range limits
  plus end-to-end RAR range playback coverage.

## 0.50.0

- Reorganized the Account page's DIY settings into a clear Discover, Match,
  and Play pipeline without changing existing stored configuration fields.
- Grouped shared native/UU search controls into one discovery stage and moved
  NZB DAV and native NNTP into independently toggled playback cards.
- Added responsive pipeline guidance, backend status labels, and clearer test
  actions while preserving all existing playback services alongside DIY.

## 0.49.1

- Wired the native NNTP maximum-connections setting into a bounded global
  provider pool instead of leaving it as configuration-only metadata.
- Reused authenticated NNTP sockets across probes and range requests, and
  added ordered parallel segment prefetch for faster startup and seeking.
- Cancelled in-flight prefetch when the player abandons a speculative range,
  while retaining the configured connection ceiling across concurrent probes.

## 0.49.0

- Added opt-in native NNTP preview rows alongside the existing NZB DAV rows.
- Added bounded deferred NZB parsing, largest direct-video selection, binary
  NNTP BODY retrieval, dot unstuffing, and multipart yEnc decoding.
- Added native HTTP HEAD and single-range playback with exact content headers,
  client-cancellation handling, and cached/deduplicated play-time inspection.
- Kept archive-contained releases on NZB DAV with an explicit fallback message;
  native RAR/7z virtual streaming remains the next engine stage.

## 0.48.0

- Added the first SSS-native NNTP foundation: encrypted per-account host,
  port, TLS, username, password, and connection-limit settings in DIY providers.
- Added a live NNTP test that verifies greeting, authentication, and the DATE
  command without exposing credentials in errors.
- Routed NNTP connections through the configured HTTP/HTTPS outbound proxy via
  CONNECT, while retaining `NO_PROXY` handling for explicitly bypassed hosts.
- Kept native NNTP playback rows disabled until NZB parsing and range assembly
  are complete; existing NZB DAV and other pipelines remain unchanged.

## 0.47.1

- Fixed DIY NZB DAV playback probes by ending HEAD requests without attempting
  to pipe a nonexistent response body.
- Preserved byte-range streaming while treating player-cancelled speculative
  requests as normal cancellation instead of proxy failures.
- Added safe media MIME and filename fallbacks for WebDAV servers that expose
  video files as generic binary downloads.

## 0.47.0

- Added native event-title Usenet discovery for direct Newznab/NZBHydra
  endpoints and Prowlarr's aggregate API.
- Added encrypted per-account native-search configuration, a live test-query
  action, and independent native/UU DIY discovery switches.
- Removed UU as a mandatory dependency for DIY NZB DAV playback while keeping
  UU search available as an optional parallel source and UU playback unchanged.
- Bounded native-search response sizes, request duration, query count, and
  returned results before storing candidates in the encrypted candidate store.

## 0.46.4

- Fixed DIY NZB DAV playback when PROPFIND responses advertise an internal or
  reverse-proxy hostname by safely rebasing resource paths onto the configured
  WebDAV origin.
- Derived the mounted WebDAV folder from the completed job's authoritative
  `storage` and `category` fields.
- Added stage-specific NZB DAV resolve logs without exposing URLs or secrets.

## 0.46.3

- Added account-level toggles for TorBox, Usenet Ultimate stream rows, and
  Easynews so each existing playback pipeline can be isolated during testing
  without deleting credentials.
- Kept UU text search available to DIY NZB DAV when UU's own stream rows are
  disabled.

## 0.46.2

- Kept active NZB DAV request deadlines referenced so stalled requests reliably
  abort under Node.js 20 and Linux CI.

## 0.46.1

- Fixed the Linux CI unit-test command so the shell expands the scoped test
  files correctly during container publication checks.

## 0.46.0

### Additive DIY NZB DAV playback

- Added an opt-in DIY provider section to the signed-in account page without
  changing TorBox, Easynews, or legacy Usenet Ultimate configuration.
- Reused UU title-search candidates while resolving selected NZBs directly in
  SSS through NZB DAV only after Play is clicked.
- Added encrypted, expiring, user/event-bound candidate references so indexer
  URLs and NZB DAV credentials never enter stream rows.
- Added bounded SAB-compatible submission and polling, deterministic WebDAV
  media discovery, authenticated HTTP range proxying, and connection testing.
- Added provider regression tests for authentication, timeouts, failed jobs,
  WebDAV traversal, encrypted candidates, and byte ranges.

## 0.45.7

### Public distribution hardening

- Changed standalone and Dockge host-port defaults to loopback-only so direct
  SSS and unauthenticated scraper-GUI access cannot bypass the intended proxy.
- Updated Express and its locked transitive dependencies to patched releases.
- Added production dependency auditing and a loopback-binding assertion to CI,
  and made the same audit gate container publication.

## 0.45.6

### One-page account configuration

- Rebuilt Account as a single signed-in configuration page for TorBox,
  Easynews, Usenet Ultimate, catalogs, playback settings, and client exports.
- Removed the separate TorBox Unified diagnostic and its private endpoint.
- Kept the manifest URL install-only: account login is the sole authority for
  editing configuration, while URL rotation remains available if it is shared.
- Added an authenticated route and persistence test that also gates container
  publication.

## 0.45.5

### TorBox Unified discovery probe

- Added a read-only account diagnostic for TorBox Voyager torrent and Usenet
  searches with cache, ownership, and the user's configured BYOI sources.
- Sanitised the diagnostic response so API keys and full NZB/download URLs are
  never returned to the browser or written to the report.
- Kept the existing companion, UU, and playback pipelines unchanged while the
  current TorBox Search API contract is verified against real sports queries.

## 0.45.4

### Prowlarr torrent hash recovery

- Authenticated Prowlarr download-proxy hydration requests and safely followed
  redirects without forwarding the API key to external indexer hosts.
- Added info-hash recovery from ordinary `.torrent` response bodies so raw
  Prowlarr hits are no longer discarded when no magnet redirect is available.

## 0.45.3

### Manchester United torrent discovery

- Made the companion and direct Prowlarr use one precise Manchester United
  fixture query in scene order: `competition + date + teams`.
- Removed HCAFC, nickname, `@`, date-last, and undated variants from the
  Manchester United torrent path while retaining UU's optimized fallbacks.

## 0.45.2

### Manchester United UU search latency

- Prioritised football scene-style `competition + date + teams` searches for
  Manchester United fixtures.
- Reduced Manchester United's UU direct-search fan-out from twelve parallel
  queries to four precise variants to avoid local index-manager timeouts.

## 0.45.1

### New-catalog account migration

- Automatically enabled the two Manchester United catalogs once for accounts
  that saved an explicit catalog list before version 0.45.0.
- Preserved the ability to disable either catalog after the migrated account
  settings are saved.

## 0.45.0

### Manchester United catalogs

- Added built-in `Man United Upcoming` and `Man United Recent` catalogs.
- Added team-scoped football-data.org refreshes so Manchester United fixtures
  are combined across every competition available to the configured API key.
- Added domestic and European opponent aliases, exact-date release matching,
  and both catalogs to the generated Nuvio Football collection folder.

## 0.44.4

### Collection copy compatibility

- Made Copy JSON work on plain-HTTP account pages and older browsers by
  embedding the generated payload and falling back to selection-based copy.
- Added a Nuvio Desktop-compatible collections-only manifest mode alongside
  the `showInHome` hint, while keeping every collection source resolvable.

## 0.44.3

### Collections-only manifest fix

- Kept collection-backed catalogs registered in the manifest when home rows
  are disabled, and now mark them with Nuvio's `showInHome: false` hint.
- Fixed imported collection folders becoming empty in collections-only mode.

## 0.44.2

### Catalog home-row visibility

- Added a per-account option to hide enabled catalog rows from the generated
  manifest while keeping their endpoints available to imported Nuvio
  collections.
- Existing accounts continue showing home rows unless they explicitly switch
  to a collections-only layout.

## 0.44.1

### Nuvio collection artwork

- Renamed the generated collection from SSS to SeriousSportSync.
- Added matching orange-and-black folder artwork for Combat Sports,
  Wrestling, Football, and Motorsport instead of using promotion artwork.

## 0.44.0

### Nuvio collections export

- Added an account download that generates Nuvio's native collections JSON
  schema for the user's enabled SSS catalogs and saved ordering.
- Added Combat Sports (UFC, ONE, Boxing), Wrestling (WWE, AEW), Football
  (Match of the Day), and Motorsport (Formula 1, MotoGP) folders.
- Added Download JSON and Copy JSON actions for Nuvio website and app imports,
  using public SSS artwork URLs and stable collection/folder identifiers.
- Removed the retired stream-cache module from CI's module-load list.

## 0.43.9

### Catalog ordering UI fix

- Changed promotion groups from a three-column grid to one top-down sequence
  matching the order shown by Nuvio.
- Replaced unreliable native button dragging with direct mouse, touch, and pen
  pointer movement so grabbing a handle moves its promotion or catalog row.

## 0.43.8

### Per-user catalog ordering

- Added drag handles for reordering promotion blocks and the catalogs inside
  each promotion on the account Catalogs screen.
- Added touch/pen dragging and keyboard arrow controls to the same handles.
- Persisted each account's order and applied it directly to the generated
  manifest, so Nuvio and Stremio receive catalogs in the chosen sequence.
- Kept existing accounts compatible and append newly introduced promotions or
  catalogs without discarding saved ordering.

## 0.43.7

### Scene-title keyword matching

- Fixed UU results such as `Match.Of.The.Day.2026.08.23` being rejected as
  `no-keyword-match` when promotion keywords contained spaces.
- Phrase matching now treats dots, underscores, and hyphens as word separators
  while preserving date-strict event validation.

## 0.43.6

### Remove proactive stream warming

- Removed the scheduled and boot-time all-event stream-candidate warmer.
- Removed the manual global warm route, persistent candidate database, warmer
  status files, configuration variables, and health-page controls.
- Companion and direct Prowlarr discovery are now strictly request-only for
  the single event a user opens.
- Kept explicit per-event admin tools using short-lived in-memory candidates;
  they never launch a catalog-wide search.

## 0.43.5

### Match of the Day catalog lifecycle

- Split Match of the Day into Upcoming and Recent catalogs, following the
  same air-date transition and sort behavior as other SSS promotions.
- Limited retained and displayed episodes to the active July-June football
  season so old weekly episodes are pruned at refresh time.
- Added branded Match of the Day fallback artwork for episodes whose TMDB
  metadata has no still image.

## 0.43.4

### Refresh failure reporting

- Targeted TMDB promotion refreshes now return `ok: false` with an explicit
  error when `TMDB_API_KEY` is missing or the TMDB source is unavailable.
- Admin logs now label unsuccessful per-promotion results as `failed` instead
  of reporting them as complete with zero updates.

## 0.43.3

### Match of the Day catalog

- Added one combined Match of the Day catalog backed by the TMDB entries for
  Match of the Day and Match of the Day 2.
- Normalised both shows to `Match of the Day DD MM YYYY` for catalog display,
  indexer searches, and date-strict stream matching.
- Added show-aware TMDB episode IDs so episodes from the two series cannot
  overwrite one another when season and episode numbers coincide.

### Provider-owned Usenet Ultimate discovery

- Replaced SSS's server-wide Newznab search with manifest-scoped direct title
  search through each user's Usenet Ultimate instance.
- UU now owns its indexer credentials and discovery; SSS supplies promotion-
  aware event titles, applies sports relevance filtering, and returns NzbDAV
  playback rows to Nuvio/Stremio.
- Documented the temporary `ghcr.io/monkfish1337/usenet-ultimate:sss-direct`
  compatibility image while the upstream UU endpoint is under review.
- Removed obsolete `NEWSNAB_*` configuration, scripts, and admin wording.
- Renamed the per-promotion `newsnab` pipeline toggle to `uu`, with backward
  compatibility for existing saved promotions.

## 0.43.2

### Guided promotion setup

- Reworked Content Studio's promotion creator into a two-step source wizard.
- Automatically infers the short ID, safe search templates, recognition terms,
  date matching, and known football team/league alias presets.
- Previews real recent/upcoming source events and imports available source
  artwork before creation, making an incorrect source easy to spot.
- Starts the promotion's first event import automatically after creation.

### Matchup stream matching

- Added reversed and `@` search variants for generic matchup promotions such
  as NBA, NHL, and MLB, including exact ISO/DMY date variants.
- Treats both canonical team names plus an exact fixture date as authoritative,
  regardless of home/away order or overly narrow promotion keywords.
- Added full `YYYY-YYYY` season-token support alongside `YYYY-YY`.
- Fixed completed/skipped pipelines emitting phantom timeout logs later because
  their timeout timers were not cancelled.
- Stream requests now use the composed Content Studio event store, so saved
  event aliases and overrides affect playback searches.

## 0.43.1

### TheSportsDB source discovery

- Fixed Content Studio throwing `slice(...).map is not a function` when a
  TheSportsDB name search returned its string error payload.
- Replaced the unsupported v1 league-name query with the free API's exact
  league-name team lookup and deduplicated its league results.
- Added direct numeric league-ID lookup and clearer free-API search guidance.
- Updated the default public v1 API key from the legacy `3` key to TheSportsDB's
  documented `123` key, raising season results from 5 to the free limit of 15.
- Existing deployments that still set `TSDB_API_KEY=3` are migrated to `123`
  automatically; premium/user keys remain untouched.
- Added automatic split-season detection so NBA/EPL-style leagues query
  `2025-2026` and `2026-2027` rather than empty calendar-year seasons.
- Added refresh logging when a response reaches the free 15-event schedule cap.

## 0.43.0

### Content Studio

- Added a promotion overview with visible, manual, and review-pending counts.
- Added refresh-safe manual events, source-event overrides, disabling,
  restoring, resetting, and deletion controls.
- Added a missing-event inbox for promotion-filter rejections and possible
  duplicates, with accept, merge, and ignore decisions.
- Added previewed ICS, CSV, and JSON event imports.
- Added guided matching suggestions that turn good and bad release examples
  into per-event search aliases and exclusion patterns.
- Added searchable TheSportsDB, football-data.org, and TMDB source discovery
  to a simplified promotion wizard, while keeping the advanced editor.
- Stored editorial content separately from the refreshed source cache so
  catalog refreshes cannot overwrite manual work.

## 0.42.17

### Broader direct Prowlarr discovery

- Removed the forced Movies, TV, and Other category filters from direct Prowlarr searches.
- Prowlarr indexers such as Bitmagnet can now return results from their full text-search index.
- SeriousSportSync still applies its promotion relevance filtering before showing streams.

## 0.42.16

### Direct Prowlarr request boundary

- Fixed direct Prowlarr being queried by the scheduled stream-cache warmer.
- Direct Prowlarr now runs only for user event stream requests and explicit
  admin live searches.
- The warmer exits immediately when no companion scraper is configured,
  preventing event-window fan-out and empty cache rewrites.

## 0.42.15

### Direct Prowlarr

- Restored optional direct Prowlarr configuration in the SeriousSportSync
  admin panel and through `PROWLARR_URL` / `PROWLARR_API_KEY`.
- Direct Prowlarr and companion-scraper candidates now merge by info hash
  before relevance filtering and per-user TorBox cache checks.
- Restored Prowlarr hash extraction and bounded download-proxy hydration
  without returning raw torrent rows to clients.
- Added Prowlarr status to `/health` and stream availability detection to
  the addon manifest.

## 0.42.14

Catch-up release covering the unpublished work since GitHub version 0.33.0.

### Streaming and providers

- Added direct Easynews search and deferred authenticated playback.
- Added TorBox cache checks, signed resolve-on-play URLs, and optional
  warm-to-cache rows for uncached releases.
- Restored per-NZB Usenet Ultimate rows with multi-Newznab endpoint support,
  indexer attribution, subtitle hints, and stronger deduplication.
- Added per-promotion pipeline controls and an eight-second pipeline budget so
  slow providers do not hold the entire stream response open.
- Expanded filtering for sports noise, foreign-language results, release year,
  exact event dates, team aliases, and duplicate titles.

### Catalogs and matching

- Added custom promotion creation and editing from the admin interface.
- Added promotion-specific alias/noise overrides and an interactive match test
  bench.
- Added football-data.org competitions with bidirectional team aliases and
  date-strict fixture matching.
- Added TMDB episode sources for dated sports programmes.
- Added per-promotion refreshes and hot-reloaded catalog definitions.
- Improved UFC, WWE, AEW, Formula 1, boxing, MotoGP, and football title
  generation and relevance matching.

### Administration and operations

- Reworked the account and administration interface with shared Tabler page
  chrome.
- Added general search and grab tools for qBittorrent, SABnzbd, and TorBox.
- Added cache warming controls, health/log views, source validation, and
  safer secret handling.
- Added backup scripts and systemd timer/service examples for runtime state.

### Companion scraper

- Bundled the SeriousSportSync scraper source, including Prowlarr, Torznab,
  Zilean, Knaben, TheRARBG, and Bitsearch adapters.
- Added scraper history, statistics, source configuration, logs, general
  search, and downloader management.

### Compatibility and fixes

- Improved Nuvio/Stremio presentation, manifest stream advertisement, artwork
  fallbacks, result metadata, request timeouts, proxy handling, and redaction.
- Includes all maintenance fixes through 0.42.14.
