# Changelog

## Unreleased — Champions League stops throwing away forty queries

`championsLeague.torrentSearchTitles` built three focused scene queries and
then `slice(0, 3)`'d the rest of the list away. The same shape as the MLB bug
fixed earlier: the torrent sources saw only three full-name queries, each
carrying a league prefix *and* a date — the form measured to be the weakest
everywhere else — so no short pair and no DMY form ever reached Bitmagnet or
rutracker.

The three focused forms were right and stay first. UCL releases genuinely are
named `UEFA.Champions.League.<date>.<matchup>`, the same fixture also appears
under `Champions League` and `UCL`, and `Vs` is the scene capitalisation. What
changes is what sits behind them: the full generated list, deduplicated, rather
than nothing. 3 queries became 46, with the measured three still leading.

Two tests pinned the old `length === 3` and were rewritten rather than
weakened — a slice that discarded forty usable queries was never the
specification.

## Unreleased — the review inbox is gone

It recorded two things: candidates the promotion filter had excluded, and
candidates that looked like duplicates of an event already stored, capped at
500 items.

Nothing ever read them. `updateInbox` had zero callers, no page rendered the
list, no export included it. It had been accumulating records nobody could see
or act on since it was written — and the duplicate half was not free: it walked
every stored event for every candidate of every refresh, an O(n) scan per
record, to produce a note nobody would read.

Deleted rather than surfaced, deliberately. A reviewer queue is only worth
having if someone reviews it, and a promotion filter that excludes an event is
usually doing its job. An existing `content-studio.json` with an `inbox` key
still loads; the key is read and dropped, so the next save of that store writes
it out.

503 unit tests, plus both standalone verification scripts, passing.

## Unreleased — the first-run walkthrough, at last

The top item on the 1.0 list was the one path nobody had ever walked: a brand
new account through all five Configure steps. Done properly this time — a clean
instance booted against an empty data directory, an admin account created
through `/setup`, every step read as a new operator reads it, the save round
tripped, the manifest fetched and a catalog requested as an installed client.
Three defects, all on paths only a new install takes, which is exactly why none
of them had been seen.

**The setup page told the first user they would not be an admin.** It said the
account "will be auto-promoted to `admin` if it matches the `ADMIN_USER` env var
(currently `(unset)`)". Every operator who has not set that variable — the
default — was told on the very first screen of the product that their account
would not be an administrator. It always is: `POST /setup` passes
`role: 'admin'` and `createUser` takes `role === 'admin' || matchesAdminEnv`.
`ADMIN_USER` only prefills the field and promotes a *later* user of that name.

**The team picker pointed at a page that does not exist.** With no
football-data key — which is every new operator — the Premier League chooser
says where to add one: "Admin → Sources". There is no Admin nav item and there
has never been a Sources page; the sidebar says **Server**. Renamed to match.

**A new install looked broken while it filled.** Measured: a clean instance was
still on the first of 29 promotions several minutes after boot, because the
refresh is sequential and the TheSportsDB adapter waits between requests. The
Install step handed over a manifest that produces empty rows and said nothing
about it, and "Check it works" then reported it had no fixture to try — a
working install presenting exactly as a broken one. The step now says so while
the catalogue is empty, and says the manifest is fine to install meanwhile.

Confirmed working on a clean install, for the record: `/setup` → account →
Configure renders all five steps, save round-trips (only the selected catalogs
come back served), the personal manifest returns the right two catalogs, and the
team pickers for NFL, NBA and MLB all populate.

500 unit tests, plus both standalone verification scripts, passing.

## Unreleased — fix the two CI checks the new collection folders broke

Both workflow runs for the Big 3 / Unmatched commit failed, and neither failure
was in the unit suite — they were in `scripts/test-nuvio-collections.js`, which
CI runs and `npm run test:unit` does not. Two separate assumptions:

**A letters-only asset name.** Folder artwork was asserted against
`/^…\/collection-[a-z-]+\.png$/`, and the new file is `collection-big-3.png`.
The digit was the whole failure. That pattern was incidental to the four
original names rather than a rule about asset filenames, so it now allows
digits.

**A fixture that was quietly exercising the defaults-upgrade path.** The
"omits folders with no enabled catalogs" case built a personalised selection of
three catalogs at `catalogDefaultsVersion: 1`. The current version is 2, and the
upgrade path switches on every catalog added since — which for that fixture
means `mlb-upcoming` and `mlb-recent`. So the moment MLB had a folder, the
folder correctly appeared and the assertion read as a failure. The subject there
is which folders get omitted for a given selection, not the upgrade path, so the
fixture now states the current version and says what it means.

Worth noting what was **not** wrong: the two PNGs committed cleanly. They are
larger on GitHub than on disk (283,346 vs 277,576 bytes) because a provenance
chunk is added in transit, and every PNG chunk CRC verifies on the committed
copy — so that difference is not the corruption it looks like.

496 unit tests, plus both standalone verification scripts, passing.

## Unreleased — a Big 3 folder, and the discovered catalogs gathered as Unmatched

Two new default collection folders, and the artwork to go with them.

**Big 3** — NFL, NBA and MLB had no folder at all, so three of the busiest
promotions sat loose among the ungrouped catalogs.

**Unmatched** — the seven `discovered-*` catalogs exist for events pulled out of
release listings that matched no promotion. Loose on the home screen they read
as seven more leagues with full schedules, which is the opposite of what they
are. Gathered into one folder they read as what they are: the unmatched pile.

**Artwork.** `scripts/make-collection-art.py` draws both tiles at 1672×941, the
same canvas as the four existing ones, and to the same construction: matte-black
subjects, an orange rim light, a glowing hexagon behind, bloom, floor reflection
and a vignette. Drawn rather than photographed, but built to sit in that row
without looking like a different product. Both are offered in the artwork picker
on the Configure step and the admin Collections page, so they can be used for
any folder.

**Reaching an install that already saved.** A saved collections file replaces
the defaults outright — that is what makes the editor work — so a new default
folder would otherwise appear for nobody, since everyone has saved at least
once. Collections version 2 adds missing default folders by id, once, then
stamps the version: folders the operator already has are untouched, renames
survive, and a folder they delete afterwards stays deleted rather than returning
on every load.

496 tests passing.

## Unreleased — square badges were being cropped into widescreen tiles

Reported on the Nuvio home rows for NFL, MLB, NBA, Premier League and Champions
League — which is precisely the set of promotions whose artwork is a team badge.

ESPN, the MLB schedule and football-data supply a team logo and nothing else,
and a logo is square. Declared as `landscape`, the client scaled it to fill a
16:9 tile and cropped the top and bottom off every crest. The promotions that
keep landscape — UFC, WWE, AEW, ONE, F1, MotoGP, Match of the Day — have real
widescreen artwork to put in it, which is why none of them were affected.

Those fourteen league promotions now declare `square`.

**And `'regular'` was never a poster shape.** The Stremio spec has `square`,
`poster` and `landscape`; every catalogue and detail response was sending
`'regular'` whenever an event had no stored shape, leaving the client to fall
back to its own default. That is the mechanism by which a square badge ended up
in a 16:9 tile in the first place.

The shape now resolves from the **promotion** rather than the value stamped on
the event at ingest. A stored event keeps its old shape until the next full
refresh, so reading the live definition means this change takes effect on the
next catalogue read instead — no refresh needed for the tiles, only for the MLB
images added in the previous commit.

490 tests passing.

## Unreleased — MLB had no artwork at all

Reported as missing images, and it was missing at both levels.

**Per-event.** `lib/sources/mlb.js` set `poster`, `thumb`, `fanart` and
`banner` to `null` outright, so every MLB event rendered with nothing behind it
while the ESPN-backed promotions showed team logos. The schedule feed already
carries team ids, and MLB serves logos from a public CDN keyed by exactly that
id, so the fix costs no extra request and no API key: the away team's logo
becomes the poster and the home team's the thumb, the same shape ESPN supplies.

The PNG `spots` endpoint rather than `/team-logos/<id>.svg` — both return 200,
but a client that will not render SVG would show nothing, which is the bug being
fixed. A team id that is missing or not numeric yields no URL rather than a
broken one, for the same reason. Checked against a real day of the schedule:
15 games, 0 without a poster.

**Catalog-level.** MLB shipped with no `poster`, `fanart` or `logo` while every
TSDB-backed promotion had all three, so its tile and meta backdrop were empty.
Filled from TheSportsDB's MLB league record, each URL checked to return 200 with
an image content type first.

One trap worth recording: `createGenericPromotion` builds `defaults` from
`spec.poster` / `.fanart` / `.logo`. A `defaults: {…}` block written into the
spec is silently ignored — it looks set in the source and renders nothing. The
first attempt here did exactly that, and there is now a test against it.

486 tests passing.

## Unreleased — the log buffer was being flushed by the thing filling it

Asked to check Prowlarr and Bitmagnet in the live logs for an MLB event. The
logs could not answer, and that is its own bug: `/admin/logs` held 4000 entries
spanning **thirty-seven seconds**, every one from the availability build, with
zero entries in the `stream` category.

The background build logs one line per query per event. At 379 events and 54
variants that is roughly twenty thousand lines a run against a five-thousand
line buffer, so a run pushes every stream request out of the window — the
diagnostic tool made unusable by the routine job, precisely when a stream
request was the thing that needed reading.

The build's per-query lines are now suppressed by default; its progress and
summary lines still log. The distinction is indentation: the sources indent
their per-query output and the run's own lines are not indented. **Logs →
Verbose index build** turns the detail back on, and the panel says what that
costs.

What the logs did show, before this landed: MLB's queries are now the right
shape — `Orioles Red Sox 2026.09.05`, `MLB 05.09.2026 Orioles Red Sox`,
nickname pairs in both date formats — and Bitmagnet returns **0 results** for
them. Prowlarr does not appear at all, because the index build is Bitmagnet-only
by design. Whether the live path reaches Prowlarr for these fixtures could not
be determined from a buffer holding no live requests, which is exactly what this
change fixes.

482 tests passing.

## Unreleased — MLB was handing the torrent pipeline four bad queries

Reported after NFL started working: MLB still pulls nothing from Bitmagnet or
rutracker, verified by manual search.

MLB was the last promotion carrying a `torrentSearchTitles` override, and it cut
the list to **four** — the four hand-written full-name forms that also led it:

    MLB 2026 RS 20.08.2026 San Diego Padres @ Los Angeles Dodgers
    MLB 2026 20.08.2026 San Diego Padres @ Los Angeles Dodgers
    MLB 2026.08.20 San Diego Padres vs Los Angeles Dodgers
    MLB San Diego Padres @ Los Angeles Dodgers 20.08.2026

Every one carries a league prefix *and* a date, the shape measured to be
weakest, and the slice meant Bitmagnet and Prowlarr saw only these — never a
single nickname pair. NFL, which has no override at all, worked. The override
existed to keep a slow fan-out short back when neither source had a budget of
its own; both do now, so it only removed the good queries before either could
choose.

The observed forms are kept — they came from real releases — spliced in behind
the first block of pair queries rather than in front of it. Appending them
outright was the first attempt and dropped them entirely, since the generated
list fills the 60-query cap on its own.

**Two-word nicknames.** The pair queries only accepted single-word forms, so
Toronto Blue Jays against Boston Red Sox produced `Boston Toronto <date>` — a
pair of cities that cannot match `MLB.2026.07.25.Blue.Jays.Vs.Red.Sox`. Red Sox,
Blue Jays, White Sox and Trail Blazers are nicknames like any other; they just
carry a space. Allowing them then let the canonical "City Nickname" back in at
the head (`Carolina Panthers Houston Texans …`, the full-name template again),
so the canonical form is now dropped whenever a shorter one exists.

477 tests passing.

## Unreleased — the cut-offs are adjustable from the Server page

Asked for after four rounds of tuning these numbers by redeploy: somewhere to
fine-tune the cost of time against results without editing environment
variables and rebuilding.

**Server → Discovery timing** now carries five numbers:

| Field | Default | What it decides |
|---|---|---|
| Stream request budget | 9500ms | The whole request. Pipelines still running when it expires are abandoned. |
| Discovery budget | 5000ms | Searching only, held at least 1s below the request budget so filtering and the TorBox cache check still fit. |
| Prowlarr queries per request | 6 | How many are offered; the budget decides how many finish. |
| Prowlarr per-query timeout | 15000ms | One HTTP search. |
| Index build budget | 25000ms | The background build, which nobody waits on. |

These are the most consequential numbers in the stream path and they were the
hardest ones to try. Prowlarr answers in roughly two seconds per query, so the
5000ms discovery budget is the difference between two queries and six — and
that, this evening, decided whether the query that reaches rutracker was ever
sent at all.

Saved values win over environment variables, which still win over the defaults,
so an existing deployment keeps whatever it had and a cleared field means "use
this deployment's configured value" rather than zero. Out-of-range entries are
clamped rather than refused. The request budget can be pushed past Nuvio's
~10s client deadline if an operator wants to — the form says plainly that doing
so turns a partial answer into no answer.

The Prowlarr query cap previously borrowed the promotion's `uuMaxQueries`, which
was the nearest existing number rather than the right one: how many queries fit
is a property of how slow this deployment's Prowlarr is, not of the promotion
being searched.

474 tests passing.

## Unreleased — the rutracker query was being generated and never sent

Reported bluntly and correctly: rutracker results still are not being captured.
They were not, and the previous entry's claim that both catalogues were "now
reachable inside the first six queries" was the wrong measurement.

Six is not the number that matters. Prowlarr — the only configured source that
reaches rutracker — is given six queries but completes about **two** before its
deadline, so index 0 and 1 are in practice everything it asks. With the date
formats grouped by type, both of those were dotted ISO and the DMY form sat at
index 4. Bitmagnet, which sends all sixty, found the content and the row was
labelled Bitmagnet; Prowlarr was never handed the one query that can match a
rutracker title. The fix generated the right query and then never sent it.

The four date tokens now alternate format instead of grouping, and every
prefix-free form goes out before any prefixed one — a prefixed date is
measurably weaker than the bare one, so it must not displace a format that has
not been tried at all. For Texans at Panthers:

    0  Panthers Texans 2026.08.29     dotted ISO, stored day
    1  Panthers Texans 28.08.2026     DMY, day before   -> rutracker
    2  Panthers Texans 2026.08.28     dotted ISO        -> the usenet release
    3  Panthers Texans 29.08.2026     DMY, stored day

The test now pins index <= 1 rather than < 6, because the margin that was
"comfortable" was the entire bug.

468 tests passing.

## Unreleased — a row now names every source that found it

Reported as: the Bitmagnet rows don't match the name and claim Bitmagnet rather
than Prowlarr.

Three separate things, and only one was a defect.

**The label was accurate.** `lib/sources/bitmagnet.js` hard-codes
`indexer: 'Bitmagnet'`; Prowlarr results carry the real per-indexer name, so
"RuTracker.org" is what a Prowlarr row says. Bitmagnet is a DHT crawler and
rutracker torrents are public, so it genuinely has them — finding the same
content is not the same as being the same source.

**The title was the torrent's own name**, as the index reports it — not the
rutracker listing's title. A single-file torrent is usually named after its
file, which is why the row reads `Houston Texans at Carolina Panthers 28.08.2026
Ad Free.mkv` rather than the slash-delimited listing.

**The defect:** deduplication by info hash kept the first source's attribution
and discarded the rest. A torrent returned by *both* Prowlarr and Bitmagnet was
labelled with whichever list came first in the fan-out, and the row then
asserted a single origin that was only half true — which is exactly the question
these labels exist to answer. Every source that returned a hash is now named,
`Bitmagnet, RuTracker.org`. That also makes the single-source case mean
something: a row saying only Bitmagnet now tells you Prowlarr did not return it.

466 tests passing.

## Unreleased — rutracker's catalogue was never being asked for

rutracker has by far the deepest NFL coverage — every week of 2025-26 and
2026-27, playoffs included — and not one query SSS emitted could return any of
it. Its titles are slash-delimited with a DMY date:

    NFL 2026-2027 / Preseason / Week 03 / 28.08.2026 /
      Houston Texans @ Carolina Panthers [Американский футбол, WEB-DL HD/1080p/30fps, MKV/H.264, EN]

The matcher already accepted that string, Cyrillic and all. The queries were the
problem, and in a familiar way: every dated one carried dotted ISO, so on an
ANDing index none of them could match a title dated `28.08.2026`. The same
failure as the nickname releases, one date format along.

Nickname pairs now carry four date tokens — the stored day and the day before
it, each in dotted ISO and in DMY. The DMY form for the day before comes first
of the two, because rutracker names by the American local date, which is the day
the UTC timestamp has already rolled past. Both catalogues are now reachable
inside the first six queries, which is what a bounded provider list can actually
send.

**Also removed: code pairs from leagues that never use them.** The three-letter
form was measured on EPL 2160p releases. Emitted from ESPN's abbreviations
instead it is pure noise — a college football fixture opened with `DUQ AFA`,
`DUQ-AFA`, `DUQ-AFA 20260905`, three of its first queries, all empty, on every
event of every ESPN promotion without a preset. It now requires the curated
preset it was built for.

463 tests passing.

## Unreleased — building the index is Bitmagnet-only

Reported as: the index build is getting Prowlarr's indexers disabled for
over-use.

It runs over every upcoming event of every enabled promotion, unattended, so
its cost is measured in whole catalogues rather than single requests. Prowlarr
answers by fanning each query out to remote trackers, and at that volume the
trackers do what they always do — the indexers get disabled, which takes
Prowlarr out of the **live** path too, the one a person is actually waiting on.
The background job was starving the foreground one.

Bitmagnet has no such ceiling: a local Postgres index with no remote party to
annoy, and 65ms against Prowlarr's 20,086ms on the same fixture. It is the only
source that can sensibly be asked this many times, so it is now the only one the
index build asks.

Prowlarr is untouched for live requests, where the volume is one event at a time
and somebody is waiting. The restriction is per-call rather than a settings
change, so nothing has to be re-entered to get it back. If Bitmagnet is not
configured, the build says so and skips rather than quietly falling back to the
source this exists to protect; `AVAILABILITY_WARM_ALL_TORRENT_SOURCES=1` restores
the old fan-out.

461 tests passing.

## Unreleased — query order decides whether a slow provider finds anything

Measured against the live Prowlarr/usenet stack. Same terms, same fixture, same
provider, only the order different:

    NFL 2026.08.28 Cardinals Packers  -> 0 results
    Cardinals Packers 2026.08.28      -> 1, the real release
    NFL 2021.10.28 Cardinals Packers  -> 3 results

The 2026 release is `NFL.Pre.Season.2026.08.28.Arizona.Cardinals...`, so the
league name is not adjacent to the date and a query that puts them together
matches nothing. The 2021 releases *are* named `NFL.2021.10.28.` and the
prefixed form works there — the same rule seen from the other side.

The prefix-free `<teams> <date>` form is the robust one, and it now goes out
first. That matters out of all proportion to its size: a slow provider is given
a bounded list and may reach only its first query before the budget expires, so
this ordering decides whether it finds anything at all. In the last log Prowlarr
managed exactly one query — the prefixed one.

Also confirmed while measuring, and **not** a defect: a game played the previous
day has no release yet. `NFL Seahawks Patriots` returns 21 results — Super Bowl
LX and a 2024 meeting — and nothing for the 2026-09-10 fixture. An empty result
for a fresh fixture is the scene, not the matcher.

457 tests passing.

## Unreleased — a half-finished search was being cached as the answer

Reported as "stuck on no sources, doesn't actually initiate a search", which is
exactly what the log showed — every provider answering from the index with no
query going out at all:

    torrent: availability-index hit ... cache=hit candidates=5 durationMs=1
    uu:      availability-index hit ... cache=hit candidates=0 durationMs=0

An earlier request had timed Prowlarr out and kept Bitmagnet's five irrelevant
candidates. A non-empty search is cached for six hours (an empty one for
thirty minutes), so that half-answer became the event's answer for the rest of
the evening — and every query fix shipped that day sat invisible behind it.

A failed search (`ok: false`) was already kept out of the index. The case that
was not is a fan-out that *answered*, but only because some of its sources did:
one source timed out, another errored, and the remainder was written down as
complete. That is now marked partial, used for the request that produced it,
and cached by nobody, so the next request asks again.

If an event is already stuck, **Clear source cache** on its promotion row drops
the stored searches and the next request starts fresh.

456 tests passing.

## Unreleased — the queries were right and the pipeline still returned nothing

A second stream log, taken after the query shapes were fixed, showed every
query correct and every pipeline empty. The fault had moved.

    prowlarr: searching 60 title variant(s)
      prowlarr: query "NFL 2026.08.29 Packers Cardinals"
    torrent discovery: prowlarr did not answer within 5000ms — continuing without it

One query issued out of sixty, the budget gone, the answer discarded. Prowlarr
is a sequential fan-out to remote trackers — 20,086ms measured on a fixture
where Bitmagnet answered in 65ms — so the variant count multiplies straight into
wall-clock, and it was being handed every variant the promotion could generate.
The other 59 then ran on into a result nobody would ever read.

It matters because Prowlarr is the source that *has* these releases. The same
queries through the same Prowlarr returned them when the Matching Lab gave it
five queries and twelve seconds.

Prowlarr now takes the head of the list — the priority block, which is the most
precise queries the promotion can make — capped at the promotion's existing
`uuMaxQueries`, and stops short of the caller's deadline to return what it
collected instead of being raced away with everything thrown out. Bitmagnet
keeps the full list; at 65ms it can afford it.

Also visible in the same log, and left alone deliberately: Bitmagnet has no NFL
preseason games. Its five candidates were Super Bowl compilations and
720pier's week-in-40 recaps, all correctly rejected. That is a coverage fact
about a DHT index, not a matching bug.

453 tests passing.

## Unreleased — three faults a stream log showed that no unit test could

A live stream log for two NFL events exposed three problems, none of which
appeared in a test built from a hand-written event, because all three needed
the structured team names a real ESPN event carries.

**Each side's alias list held both teams.** ESPN names an event "&lt;away&gt; at
&lt;home&gt;" *and* ships `teamNames.home` / `.away`. splitMatchup reads the string
left to right, so its home is ESPN's away. The two were merged without checking,
so every alias list contained the curated forms of one team and the supplied
forms of the other, and the cross product produced fixtures against themselves:

    -> "ARI-ARI" 0 result(s)
    -> "NFL 2026.08.29 Arizona Cardinals vs Arizona Cardinals" 0 result(s)

The event name wins now, because it is the string that was split; a supplied
list sharing no form with it belongs to the other side.

**"ARI GNB" was the first query sent.** On a substring index that matches every
title containing "ari", so the torrent pipeline came back full of *Tai-Ari
deshita* and *Ari Aster* — thirty-odd candidates, every one rejected as
`no-home-team-alias`, with the real release nowhere near the cut. Three-letter
code pairs are an EPL 2160p convention and stay there.

**The stored date can be a day ahead of the release.** ESPN timestamps are UTC
and an American night game kicks off after midnight UTC: Arizona at Green Bay is
stored as 2026-08-29 while every release of it is named 2026.08.28. Every dated
query for that fixture missed; the single result came from the undated fallback.
The day before is now asked for as well — only backwards, since a local date is
never ahead of the UTC one. Moving the stored date is a separate decision, and
the matcher already tolerated the shift; only the queries did not.

450 tests passing.

## Unreleased — NFL, NBA and MLB: measured, then fixed

The American big three were reported as "very hit and miss", with an open
question attached: is there simply nothing on the indexers, or is SSS failing to
recognise what is there?

Measured rather than guessed. One NFL fixture, searched against the live
Prowlarr/Usenet stack, returned among others:

    NFL.Pre.Season.2026.08.28.Arizona.Cardinals.Vs.Green.Bay.Packers.720p...
    NFL.2021.10.28.Cardinals.Vs.Packers.1080p.WEB.h264-SPORTSNET
    NFL.2021.10.28.Packers.at.Cardinals.720p.HDTV.AAC2.0.H264-720pier

The coverage was never the problem. SSS matched the first of those and rejected
the other two with `no-home-team`. It knew only the full "City Nickname" form
that ESPN and the MLB schedule supply, while two of the most prolific groups
name their releases by nickname alone — and because every query it emitted
carried the full name, an ANDing index could not have returned them either. The
fault was on both halves of the round trip.

**Alias tables for all 92 franchises.** Nickname, city and abbreviation for
every NFL, NBA and MLB team, using the same preset mechanism the football
leagues already use. Where a bare name is ambiguous *within its own league* it is
left out on purpose: "Chicago" is both the Cubs and the White Sox, "New York"
both the Mets and the Yankees. The same word is kept where only one team carries
it.

**Nickname-pair queries.** `NFL 2021.10.28 Packers Cardinals`, with no separator
— the same fixture ships as `.Vs.` from one group and `.at.` from another, so an
AND term for the separator halves the reach and buys nothing — and always with
the date, or a nickname pair matches every meeting of those two teams in the
index's history. Verified live: that query returns all three releases above.

**One trap closed on the way.** The list of nicknames deliberately kept out of
search queries was written for football fans' names — nobody searches for
"Gunners vs Toffees". Four of its entries collide with American teams: Eagles,
Saints, Reds and Tigers are Crystal Palace, Southampton, Liverpool and Hull, but
equally Philadelphia, New Orleans, Cincinnati and Detroit, where the nickname IS
the release name. Applied globally it would have silently removed exactly the
queries these tables were added to produce. It is now scoped to the presets it
was written for, and the football behaviour is pinned by a test.

Combining a league prefix with a date stays off everywhere it was measured to
lose (169 such queries returned nothing between them in the last full football
run) and is enabled only for these three leagues, whose releases begin with
precisely that pair.

447 tests passing.

## 0.95.0 — Bitmagnet becomes a first-class source, and the queries finally ask for what releases are called

**Direct Bitmagnet discovery.** Bitmagnet is a self-hosted DHT crawler with its
own Postgres index. Unlike Prowlarr it is not a fan-out to remote trackers, and
the difference is not subtle. Measured against the same 10.1M-row database on
the same fixture: Bitmagnet returned 1,837 results in 65ms; the Torznab endpoint
in front of it returned 100, and Prowlarr 175, in 20,086ms. The Torznab path was
showing 5.4% of what was already indexed locally.

Two properties are why it is worth talking to directly. Info hashes come back in
the search response, so none of the `/download` hydration Prowlarr needs applies.
And results can be ordered server-side, which is the difference between a
truncated result set that is useful and one that is not: whatever the limit is,
a bare term like `EPL` will hit it, and ordering by seeders means the cut falls
on the tail rather than an arbitrary slice.

It talks GraphQL rather than Postgres deliberately — the operator supplies one
URL, exactly like Prowlarr and Zilean, rather than database credentials. The
source does no relevance filtering of its own; `isRelevantStreamTitle` is the
matcher and is far better at this than a query string can be.

One trap worth recording: Bitmagnet reports GraphQL errors with HTTP 200. A
mistyped field name is indistinguishable from an empty index unless the errors
array is checked, so it is.

**Enable toggles on every discovery source.** Comparing sources means switching
them on and off repeatedly, and the only way to do that was to delete the URL and
credentials and type them back in. Companion, direct Prowlarr and direct
Bitmagnet each have a toggle now. A config saved before the toggles existed is
treated as enabled, a save that does not mention the flag leaves it alone, and
disabling a source changes the discovery cache fingerprint — otherwise a search
cached while a source was enabled would keep being served after it was turned
off, and the comparison the toggle exists for would be meaningless.

**The Prowlarr API key had been cut from its own section.** Restored.

## Query shapes: asking for what the release is actually called

Bitmagnet ANDs every term of a query. Every word must appear in the release name,
so each extra word is one more thing that has to be spelled the same way. Against
the live index:

| Query | Results |
| --- | --- |
| `MCI COV` | 2 |
| `EPL MCI COV` | 2 |
| `MCI COV 20260905` | 2 |
| `Premier League MCI COV` | **0** |
| `MCI COV 2026-09-05` | **0** |
| `Man City vs Coventry City` | **0** |

And from a real discovery log of 832 queries: 9.4% productive overall,
league-prefixed 2.0%, dated 2.8%, and the 169 queries carrying **both** a league
prefix and a date returned nothing at all between them.

Four things follow.

**The club alias table was never wired into the Premier League promotion.** Every
code-pair query in `searchTitles` is gated on it. So the code form the EPL scene
actually names its releases with — the form 0.94.0 was written specifically to
handle — had never once been emitted for an EPL fixture. This was the largest
single cause of missed events, and it is the whole of the improvement seen on the
first fixture tested: an event that returned zero results now returns four.

**Compact dates are now emitted.** rgfootball and most of the football scene name
files `20260823_EPL_26.27.R.01_MCI_vs_BOU_[rgfootball.net]_1080i.ts`. Of those 832
queries, 340 were dotted, 279 spaced, 26 short day-month-year, 22 ISO — and none
compact. The one form that works was the one form never sent.

**Bare code pairs are now emitted.** `ARS-CHE` is more specific than
`Arsenal vs Chelsea`, not less: only a fixture between those two clubs contains
both codes, and it adds no word a release might spell differently. They are also
generated last in `searchTitles`, which meant the 60-query-per-event cap discarded
them first; they now go out ahead of the template output.

**League prefix and date are no longer stacked.** Each is productive alone. Only
the combination was dead, and the football leagues no longer emit it.

Narrowing league prefixes to single tokens inside dated templates generally was
tried and reverted. Champions League releases genuinely are named
`UEFA.Champions.League.<date>.<matchup>`, and the UCL overlay reorders on that
exact string. Where a prefix-plus-date combination is unproductive the fix is to
drop that template, not to silently rewrite what a promotion asked for. The
narrowing that remains applies only where a prefix is bolted onto an
already-constrained matchup, and falls back to the full list for leagues with no
single-token form — "Serie A" and "Ligue 1" really are named that way.

`scripts/mine-query-shapes.js` is the tool this came from: it classifies emitted
queries by shape, measures unique hash contribution rather than hit rate, and
tests mechanical transforms against a live index.

## Switching every catalog off now stays off

Reported as: turn them all off one by one, save, and they all come back on.

An empty `catalogs` array has always meant "all" — the right default for a new
account and for a user who ticks everything — and it was also exactly what
unticking everything produced. "None" was the one selection the interface could
not express, so the save round-tripped straight back to "everything".

It now has a flag of its own rather than a new meaning for `[]`, because every
existing install has `[]` on disk meaning "all" and reinterpreting it would
empty every catalog on upgrade. The Configure form marks that it carried the
catalog step, so zero catalogs posted is a real choice rather than a form that
had no catalog fields in it.

**Enable all / Disable all** on the Catalogs step, since twenty-nine promotions
is a lot of clicking to reach "just the two I watch" and the same again to undo
it. With nothing selected the step says what will happen rather than showing a
silent zero.

## "Check it works" stops picking a fixture designed to fail

The feature whose entire job is telling a new user whether their setup works.
Pressed on a fully working install, it chose **ONE Friday Fights 169 & The Inner
Circle 29** — a seven-day-old card from about the least-covered promotion in the
catalog — found nothing, and reported No streams. The copy underneath then spent
a paragraph explaining that the red result might not mean what it says, which is
a design admitting its own answer is unreliable.

The cause was the selection. It took the newest settled fixture and nothing
else, and recency is uncorrelated with whether a release exists.

There is no reliable way to predict which fixture has one, so this stops trying.
It now takes the newest settled fixture from each of three different promotions
and checks them in turn, stopping at the first that returns something. One hit
proves the pipeline end to end; three misses across three promotions is real
evidence, which one miss never was. Later attempts get a shorter deadline, so
three full-length misses cannot sit on the page for a minute and a half.

A failure now lists every fixture it tried and what each returned, and says the
result points at the configuration — because across three promotions it does.
The hedge is gone with the reason for it.

**And it says which torrent sources were asked.** Every torrent source is folded
into the TorBox row, so "TorBox: nothing found" never revealed whether
Bitmagnet — the primary discovery source now — had even been consulted. A
switched-off source and an empty index read identically.

## Three places the interface disagreed with itself

**The Server page called itself Admin.** The nav rail says Server; the page
heading said Admin, and its subtitle said "manage users for this
SeriousSportSync instance" — which is about a quarter of what is on it. The
heading matches the rail now and the subtitle says what the page is actually
for: the things that apply to the whole instance rather than to one account.

**The Event Editor printed the same two words twice.** Every untouched row read

    Source date
    Source date
    2027-03-07

because the chip that says whether an event has been touched and the field that
says what the source gave were both labelled "Source date". They are different
facts. The chip now reads Unchanged or Overridden.

**Match of the Day could not be configured at all.** It is the only shipped
promotion whose key had no field anywhere: it needs a TMDB key, the Server page
offered football-data.org and API-Football and nothing else, and an install
without `TMDB_API_KEY` in its environment simply showed no events with no way to
discover why. There is a TMDB field now, and — as with the other two keys — a
value saved there wins over the environment variable, which needed the refresh
to be told about it as well as the field to exist.

## Promotions and Collections: things that did not line up

**The Promotions table.** Reported as a text alignment issue, and it was one. A
table cell inherits `vertical-align: middle` from its table, so every row's
one-line cells — the kind badge, the poster shape, the catalog count — floated
to the vertical centre of rows whose other cells ran to two or three lines.
Nothing shared a baseline, and a badge was worse still: an inline-block sits its
bottom margin edge on the text baseline, so it hung visibly below the name
beside it. The new Events column made it worse by adding a third line.

Fixed by top-aligning the table — which needed saying twice, because dropping
Tabler's `.table-vcenter` leaves the inherited `middle` in place. The rule the
markup now asks for is defined alongside it.

**The Collections folder cards.** `ratio` sizes a box from its aspect ratio
using a padding-top pseudo-element; `h-100` forced `height: 100%` onto the same
element. Inside `row g-0` the column is a stretched flex item, so the two rules
disagreed about the height and the artwork stretched or collapsed depending on
how much text the card carried beside it — which is why the body text never sat
level with the top of the image.

Also on those cards: the included-promotion names lived inside the `<summary>`,
where a long comma list wraps under the disclosure marker and indents every line
but the first. The count stays in the summary; the names moved to a line of
their own beneath it.

## Served and shown on the home screen are now different choices

Reported as: push collections to Nuvio with home rows disabled and the folders
open empty; enable everything and they work, but every catalog is duplicated as
a home row underneath. Which left one usable procedure — enable everything in
SSS, then switch each row off inside Nuvio by hand.

There was only one switch. Turning it off removed the catalog from the manifest
entirely, and a Nuvio collection folder whose source is a catalog the manifest
no longer declares has nothing to show. `showCatalogsOnHome` was a single
boolean for all of them, so "keep this but not on my home screen" could not be
said at all.

The Catalogs step now has two switches per promotion. **Served** decides whether
the catalog exists for your client; **Home row** decides whether it also gets a
row on the home screen. Filing a catalog into a folder and hiding its home row
is now the ordinary thing it should always have been, and the step says so
rather than leaving the trap to be discovered.

Stored as a list of hidden ids rather than shown ids, so a catalog added in a
later version appears by default instead of silently not existing for everyone
who saved before it shipped. **All home rows** and **No home rows** sit beside
the existing enable-all pair.

## Torrent rows say where they came from

Nuvio already identified Usenet Ultimate, the DIY pipeline, Easynews and
Sport-Video rows. Torrents were the exception: Bitmagnet, Prowlarr and the
companion all arrived labelled "TorBox" and were indistinguishable, so "is
Bitmagnet finding this, or Prowlarr?" could only be answered by reading server
logs — which is the question most worth answering in the client, especially now
that the two run together.

Every torrent source already recorded an indexer on the candidate: Bitmagnet a
literal `Bitmagnet`, Prowlarr the tracker's own name, the companion its origins.
Both the playable row and the warm row now show it.

## Named TheSportsDB lookups no longer blow the refresh deadline

The AEW fix from earlier in this release was charged to everything. Named
lookups are one request per name with `config.tsdb.requestDelayMs` between them
to stay inside the free key's 30 a minute, and at the shipped 3000ms that is 42
seconds for fourteen names — on top of the existing calls, and against an
interactive source preview with a 60 second deadline. A preview that times out
is worse than the empty Upcoming row this was built to fix.

Two gates. They run only when the list endpoints failed to reach a single future
event, which is the exact condition they exist for, so a league whose own
schedule comes through pays nothing. And never during a preview, which is
interactive and writes nothing.

## Bitmagnet and Prowlarr now work together

Reported as: each works alone, both together return nothing.

`Promise.all` waits for the slowest, and these are nowhere near each other.
Measured on the same fixture: Bitmagnet answered in **65ms**, Prowlarr in
**20,086ms**. Alone, Bitmagnet finished inside any budget and Prowlarr had the
whole budget to itself. Together, the combined call inherited Prowlarr's
latency, blew the stream deadline, and threw away Bitmagnet's results — which
had been sitting there since the first 65ms — along with it.

Only the companion was ever given a budget; `prowlarr.multiSearch` and
`bitmagnet.multiSearch` were awaited with no deadline at all. Each source is now
raced against the discovery budget, and whatever has arrived when it expires is
what gets used. A source still running is dropped for that request rather than
waited on, and the log says which. One source answering is enough for the
fan-out to count as a success — otherwise a Prowlarr timeout would still discard
a good Bitmagnet search, which is the bug.

## Two regressions from the previous commits

**Every promotion reported "No events".** The Events column read
`contentStore.load().events`, which is `undefined` — the catalog lives in the
event store, `contentStore` holds the overlay of manual events, date overrides
and the inbox. So the column that was added to show which promotions are broken
reported that all of them were, including the ones measured at 84 and 74 events.
It reads `store.loadFromDisk().events` now, the same accessor the Event Editor
uses, and a test pins it.

**The Promotions table ran off the right of the page.** It sits in
`.table-responsive`, which sets `overflow-x: auto` — but a scroll container only
scrolls if something stops it growing, and nothing did. Eight columns and a row
of buttons always exceed a narrow viewport, so the card was pushed sideways
instead of scrolling inside itself.

## The Promotions table can tell you a promotion is broken

AEW sat in that list with zero upcoming events and nothing on the page said so.
It was found because somebody happened to know that All Out exists. At 34
promotions, "notice it by eye" is not a process.

The table showed a **Catalogs** count — 2, 4, 6 — a property of the promotion's
definition that never changes and cannot answer the question anyone actually
brings to this page. There is now an **Events** column, and it distinguishes
three states rather than printing a number that has to be interpreted:

* **No events** — the refresh has never returned anything. A hard fault.
* **Nothing upcoming** — events are stored and every one is in the past, with
  the count and the newest date. This was AEW's shape: 32 events, newest
  2026-08-30, feed working but not reaching the future. A different fault with
  a different fix, so the page does not merge it with the one above.
* **N upcoming** — the number that matters first, the stored total second.

A zero in a column of numbers reads as a value. These read as faults.

## Every metadata source is named

"Embedded source" appeared on 16 of 34 rows — every promotion whose source is
not in the metadata registry — above a sub-line like `espn` or `competition PD`,
while the minority named theirs properly as `TheSportsDB · UFC`. The same
concept had two presentations on one screen and the vaguer one was the
majority. Each adapter now gives its own name, and the ESPN, Sport-Video and
MLB sources gained the sub-line they never had.

## The discovery pipelines are one card, four collapsible blocks

Reported as "the Sport-Video pipeline has no disable toggle". It always had
one — but only on its own page, so the Server page listed enable toggles for the
companion, Prowlarr and Bitmagnet and silently omitted the fourth source. From
the only screen where a user compares sources, Sport-Video looked like the one
that could not be switched off.

Sport-Video now sits on that card with the other three, and what runs the
pipeline came with it: the switch, the scan schedule, the per-scan limits and
the sports to scan. What it does with a matched release — team filters,
auto-warm, the per-release TorBox actions — stays on its own page, because
those are drawn from the promotion list rather than being properties of the
pipeline.

That needed a setter that patches rather than replaces. `setSportVideo` rejects
a submission with no categories, correctly, and replaces the whole object; a
save from the Server card would therefore have blanked the fields that card
never showed. `updateSportVideo` merges a patch over what is stored and
validates the result. The switch keeps a setter of its own that validates
nothing, because "turn this off" must not depend on the validity of some other
field — or, now, on a field inside a collapsed block.

**Four pipelines, four collapsible blocks.** Flat, with a switch, credentials
and an explanation each, this had become the longest card on the page, and the
question an operator usually comes here to answer — which sources are on — was
buried in the middle of it. Each block's summary carries its name and its
state, so that question is answered without opening anything. A pipeline that
is enabled but has no URL reads as off, because it is, and opens by default
since that is the case someone is most likely here to fix.

One deliberate asymmetry, now stated on the card: the companion, Prowlarr and
Bitmagnet are enabled unless a flag says otherwise, because they predate the
toggles and an install upgrading into them has to keep working. Sport-Video
reaches a third-party site on a schedule, so it stays off until turned on.

The two metadata API keys moved to the bottom under a heading that says what
they are — they fetch fixtures, not releases, and sitting them among the
discovery sources implied they were one.

## AEW's upcoming events were missing

Reported as: All Out on 27 September 2026 is not in Upcoming. It was not a
matching bug. The instance's own store held 32 AEW events and every one of them
was in the past, newest 2026-08-30.

Measured against the live API on 2026-09-11:

    eventsnextleague.php?id=4563     -> 1 event  ("Collision #161", weekly TV)
    eventsseason.php?id=4563&s=2026  -> 15 events, ending 2026-02-19
    searchevents.php?e=All_Out       -> idEvent 2579127, 2026-09-27, AEW

TheSportsDB's free key caps its list endpoints. AEW runs roughly three weekly
TV tapings a week, so the 15 slots of a season response are spent before
February, and the single event `eventsnextleague` returns is a weekly show
which `includeEvent` correctly discards. What is left is past cards only — an
Upcoming row with nothing in it, indistinguishable from a broken feed.

The last line above is the fix: the event is in the database, it just cannot be
reached by listing. A league whose cards have stable recurring names can ask
for them by name, which is also a better fit for what this promotion wants —
the named cards, not the weekly filler it throws away. Fourteen names for AEW.

**AEW is the only shipped league that needs this**, and the first version of
this change got that wrong. A WWE list was added on the assumption that Raw and
SmackDown would crowd out the PLEs the same way, and then checked against the
running instance, where WWE had 74 events with future dates out to 2026-12-12.
It never needed it, so the list was removed rather than kept as a hedge —
fifteen HTTP requests per refresh is not free. Also checked on the same day:
UFC 84 events out to 2026-12-12, Boxing 100+ out to 2026-10-31, Formula 1 100+
out to 2026-12-06.

The names are keyed by league id in `lib/tsdb-known-events.js` rather than
carried on the source object, because a promotion's source resolves from one of
three places — its own fallback in `lib/promotions.js`, the system
metadata-source registry, or a user-created entry — and only the league id is
common to all three. Putting them on the promotion literal was tried first and
had no effect at all, since the registry definition wins.

## Nuvio collections: the step that could not edit collections

Reported from the Configure wizard, and all four turned out to be real.

**The push mode could not be chosen.** Merge, Add only and Replace all were
radios inside `.sw` labels — but that class styles an `<i>` element the radios
did not have, and it hides the input itself:

    .sw input { position: absolute; opacity: 0; width: 0; height: 0 }

So the three modes rendered as plain text with nothing to click, and every push
silently used whichever was `checked` in the HTML. Merge was the only mode that
had ever run. It is a `<select>` now, with the explanation for the selected mode
below it.

**Enter did not sign in to Nuvio.** The email and password inputs sit inside the
Configure form, so pressing Enter either did nothing or submitted the whole
five-step form and navigated away from a half-finished sign-in. Enter now
submits the sign-in and nothing else.

**A rejected folder save reported "Saved".** The folder endpoints answer with a
302 to the admin page. The wizard posts by `fetch` with `redirect: 'follow'`, so
a rejection was chased to a page that returns 200 and read as success, with the
reason left in a query string nobody read. Those endpoints now return JSON to a
client that asks for it, and the step reports what actually happened. This is
why folder edits appeared to save and then had no effect.

**`hideTitle` was reset by every save from the step.** The client never sent the
field, and a missing checkbox reads as false, so "hide the title over the
artwork" was switched off every time a folder was saved from Configure.

## The collections step is now the collections editor

The step was a read-only list with one Save button per folder. Renaming a
folder, changing its artwork or tile shape, creating one, deleting one, and the
collection's own title, backdrop, pin and All-tab settings all lived on
`/admin/nuvio-collections` — a page still in the old Tabler markup that 0.92.0
replaced everywhere else. So the step *about* Nuvio folders could not edit them,
and the two screens disagreed about what a folder was.

All of it is on the step now, against the same endpoints, in the current design
system. The standalone admin page still works and still redirects as it did.

Three smaller things fell out of doing it:

* The member list is capped in height with its own scroll. Unbounded, a
  29-promotion list grew past its grid cell and rendered down across the
  folders beside it.
* A folder holding a promotion that no longer exists says so. The live instance
  showed a chip reading "1" above the words "Empty — not exported": the count
  included an id whose promotion had gone and the name list did not.
* Catalogs in no folder are named rather than counted, and the folder editor
  says out loud that a promotion belongs to one folder, so moving it here takes
  it out of another. That rule was already enforced and entirely invisible,
  which is the most likely way a folder ends up empty without anyone emptying
  it.

## The test suite passes on Windows

`rmSync` failed with EPERM in teardown. Not a Windows quirk to work around — a
real handle leak, an un-awaited `server.close()` and an unclosed SQLite index.
Linux tolerates unlinking open files, which is why CI never saw it and a
contributor on Windows saw it every time.

## 0.94.0 — EPL releases named with three-letter codes are no longer discarded

Found by eye, in a Bitmagnet listing: the 2160p EPL releases are all named
`EPL.26-27.5th.round.ARS-CHE_06.09.26_2160.mkv`. Bare three-letter codes, joined
by a separator. SSS was finding these and throwing them away.

Two independent causes, both silent.

**A club's code preceded by the opponent's code.** `teamPresent` inspects the
word before a match to stop "Inter Milan" being read as an AC Milan fixture. In
`ARS-CHE` the word before `CHE` is `ars` — not a word Chelsea owns, not a
competition word, not a number — so the release was rejected as belonging to a
different club. The opponent in the same fixture is the strongest evidence
there is, and it was the one case the guard did not allow. Now it does, and
only for the actual opponent: a different pairing, or the right pairing on the
wrong date, is still rejected.

**Compact dates.** Football sets `requireDateInTitle`, and the date extractor
required separators, so rgfootball.net's leading `20260905` read as no date at
all. Every release from that group was rejected as `no-date-in-title` even when
the teams matched perfectly. `YYYYMMDD` is now recognised, anchored tightly
enough that other eight-digit runs are not mistaken for dates.

**And the searches never asked for the format.** `rankForSearch` drops
three-letter codes, correctly — `ARS` alone is a hopeless query. But dropping
them individually dropped the pair too, so not one of the 37 queries generated
for an EPL fixture contained `ARS` and `CHE` together. A pair is the opposite of
ambiguous: only a fixture between those two clubs contains both. Code-pair
queries are now emitted with the date, and two of the four query slots for an
EPL fixture go to them.

F1 was checked against the same listing and does not share the problem — round
numbers and `Round 10` forms already match, and the practice/qualifying/sprint
rejections are the deliberate session filter working. The one gap there is
non-Latin titles (a Bulgarian Chinese GP release), which is a separate piece of
work.

## 0.93.3 — Easynews rows no longer vanish when Usenet Ultimate catches up

Reported as: refresh so UU can catch up, and the Easynews links that were there
a moment ago disappear. It was the dedupe, and the numbers from the log are
unambiguous — 3 TorBox + 10 UU + 3 Easynews rows arrived, 11 went out. Five were
silently removed, all of them Easynews rows whose release title UU had also
produced.

The dedupe scope was shared across pipelines, so the first pipeline to produce a
release title took the slot and every other copy was dropped. Results appeared to
get *worse* the more the addon found.

Two rows with the same release title from different pipelines are not
duplicates. They are different ways to play the same file — Easynews streams it
directly, UU hands an NZB to your debrid, TorBox resolves a torrent. They fail
differently, perform differently, and are labelled differently in the client, so
dropping one removes a working fallback for a release you can already see.

Deduping within a pipeline is still right: one provider returning the same
release twice is a duplicate. `nzbdav` and `nntp` already set their own scopes
for exactly this reason — this generalises what they were doing rather than
inventing a new rule, and their scopes still win where present.

The merge moved out of `handleStream` into a function the tests call directly,
so the behaviour is covered by exercising the shipped code rather than a copy of
its logic.

## 0.93.2 — more room for a slow provider

### The live budget: 8s to 9.5s

Usenet Ultimate fans out across several indexers and some sports take it past
the old ceiling. At an 8000ms pipeline budget it got 7500ms and timed out
repeatedly; it now gets 9000ms.

**Not 10000ms, and the reason matters.** The ceiling is the client's patience,
not ours: Nuvio gives up at about ten seconds, and the response still has to
merge, dedupe and serialise after the slowest pipeline returns. A 10s budget
answers at roughly 10.1s — which turns "some rows" into no rows at all, for
every pipeline, not just the slow one. 9500ms leaves that headroom.
`STREAM_PIPELINE_TIMEOUT_MS` still overrides it, and a test now asserts the
default sits under the client deadline so nobody quietly walks it past.

For a provider that is *consistently* slower than the live budget, the fix is
still the demand-driven backfill from 0.90.3: a search that runs out of time
schedules one at the 25s background budget, and the next request is served from
the availability index in milliseconds. Raising the live budget buys a little
room; the backfill is what makes a slow provider work at all.

### The install check no longer uses a stream-sized budget

The check on Configure is not a stream request — nothing waits on it but the
page — so racing it against Nuvio's patience was wrong. It now gets 30s
(`ACCOUNT_VERIFY_TIMEOUT_MS`).

A pipeline that needs fifteen seconds is exactly what the check exists to tell
you about. Reporting it as "nothing found" because the check hung up at 9.5s
was the check manufacturing the confusion it was built to remove.

## 0.93.1 — why only Sport-Video was pulling

Reported as "TorBox, Usenet Ultimate and Easynews return nothing, only
Sport-Video works". The configuration was fine. Every indexer query for a
football fixture was going out with the wrong club name.

### football-data supplies three names and the useful one was being discarded

For a Premier League fixture the provider gives `shortName` "Man United",
`name` "Manchester United FC" and `tla` "MUN" — and nothing else. Search-title
generation deliberately drops FC-suffixed forms, because no release group writes
"Manchester United FC", so the only long form in the list was filtered out and
every query went out as **"Man United vs Ipswich Town"**.

Releases are named "Manchester United". A literal text search for the short name
matched nothing, so Usenet Ultimate and Easynews returned zero for fixtures that
plainly had releases. Sport-Video kept working because it matches against titles
it has already stored rather than issuing a search — which is exactly why it was
the only pipeline still producing rows.

The fix is one function: the affix-stripped form is now supplied alongside the
others, so every football-data league gets its full club name — EPL, Serie A,
Ligue 1, the Championship — rather than needing a curated alias table each.

### The query budget was buying punctuation instead of spellings

Even with the long form generated, it never reached a provider. The planner
scores for brevity and token overlap, and every shape of the short name scores
alike, so all four slots went to "Man United vs Ipswich Town" with the date
moved around — one query, sent four times.

A provider search is a text match: coverage comes from spelling the club a
different way, not from swapping a dot for a dash. The planner now allows two
shapes per spelling and spends the rest of the budget on spellings not yet
tried. Both "Man United" and "Manchester United" now go out.

### The install check was guessing where rows came from

It attributed each row to a pipeline by pattern-matching the row's display
label, so a pipeline that answered could be reported as finding nothing.
`handleStream` already knows exactly which pipeline produced each row, so it now
returns that, and the check reports the real total.

A fixture with genuinely no release is also no longer described as a
configuration problem — the wording now says so.

## 0.93.0 — push collections straight into Nuvio

Getting a collection into Nuvio meant copying a JSON blob out of SSS and
importing it by hand, every time anything changed. Nuvio's backend is a Supabase
instance at `api.nuvio.tv` whose sync RPCs sit behind an ordinary account login,
so the Collections step can now sign in, list your profiles, and write the
collection into the one you pick — optionally installing the addon at the same
time.

### It runs in your browser, and that is the point

The page talks to `api.nuvio.tv` directly. Your Nuvio password and access token
never reach this server, are never written to `users.json`, and never appear in
a log; the token lives in a JavaScript variable for the life of the tab and is
deliberately kept out of `localStorage` too.

The cost is honest: SSS holds no token, so it cannot push on a schedule. That is
the right trade for a self-hosted box — an addon that stores your streaming
account password is an addon whose backup file is a credential dump. A test
asserts that every request the shipped code makes goes to Nuvio or to SSS's own
export, and that nothing persists the token.

### Both push RPCs are a full replace

This is the fact everything else follows from. `sync_push_collections` replaces
the entire collection list, and `sync_push_addons` replaces the entire addon
list — so sending only the SSS collection would delete every other collection on
the profile, and installing the addon naively would delete every other addon.

Every write pulls first, merges, and pushes the whole list back:

- **Merge** (default) updates the SSS collection and leaves everything else
  exactly as it is, in the profile's own order.
- **Add only** adds it if the profile has never seen it and otherwise changes
  nothing, so edits you made inside Nuvio survive.
- **Replace all** does what it says, behind a typed confirmation rather than a
  click — it is unrecoverable from this end.

Installing the addon re-enables a switched-off copy rather than duplicating it,
appends rather than reordering your addons, and leaves a disabled addon of yours
disabled.

### Content-Security-Policy

`connect-src` now permits `https://api.nuvio.tv` and nothing else, so the page
can do the push and could not exfiltrate those credentials anywhere else if it
were ever compromised. jsdelivr came out of `script-src`, `style-src` and
`font-src` in the same pass — it was there for the Tabler CDN build, which
0.90.0 vendored and 0.92.0 deleted.

## 0.92.1

### Catalog rows show a colour, not a broken poster

The rows on the Catalogs step rendered each promotion's poster. Those posters
are wide landscape banners meant to fill a Stremio row, and several promotions
have none at all, so a 62x35 slot showed a squashed crop, the wrong crest, or
nothing. The artwork was not doing the job the list needs — telling one row from
another at a glance — so it is a coloured initial tile instead, with the hue
derived from the promotion id so it is stable and neighbours differ.

### The install check now uses a settled fixture

It picked the most recently played fixture, which is the one guaranteed to fail:
a match that finished hours ago has nothing posted for it, so every pipeline
reports no streams and the result looks exactly like the broken configuration
the check exists to rule out.

It now takes the newest fixture that is at least a week old — long enough for
indexers to catch up, recent enough that TorBox's cache and normal retention
still cover it — and caps the search at sixty days. If nothing qualifies it says
so plainly instead of running a check that cannot pass. The result names the
fixture's age so it is obvious what was tested.

## 0.92.0 — everything on the new design system

Tabler is gone: the dependency, the stylesheet, the JavaScript and the static
mount. Every page in SSS now renders through `lib/ui`.

Nine pages of admin markup are written in Tabler's vocabulary — `.card`,
`.form-control`, `.btn-primary`, `.row`/`.col-md-6`. Rewriting all of it at once
would be a diff nobody could review, and leaving it would mean half the product
looked new and half did not, which is worse than either. So `lib/ui/compat.js`
maps those class names onto the new tokens: every page gets the new palette,
type, spacing and controls with its own markup untouched, and pages can be
rewritten in the native vocabulary one at a time with no visible jump when each
lands. The file is a bridge and it is meant to shrink.

`lib/tabler-chrome.js` is now a thin adapter over `lib/ui/shell` — thirteen call
sites unchanged, one file to review.

### What the self-review caught

**Two admin pages had no way to reach them.** The new rail shipped in 0.91.0
with six operator destinations; the sidebar it replaced had eight. Metadata and
Backup still had routes and no link — findable only by typing the URL. Both are
back, and a test now asserts that every admin route has a rail destination,
because "a page with a route and no destination is a page nobody can find" is
not something to rediscover by hand.

**Seventy classes were about to render unstyled.** Diffing every class used in
`lib/` and `addon.js` against everything the stylesheets define turned up
progress bars, select groups, status dots, `.display-6` stat figures and a pile
of utilities that had been coming from `tabler.min.css`. All now mapped.

**Dead scenery removed.** `buildSidebar` and `buildTopbar` emitted navbar markup
nothing styles any more. Deleted rather than left behind.

### Also

Logout stays POST-only and a non-admin is shown no operator destinations —
both now asserted against the rail rather than the retired sidebar.

## 0.91.0 — Configure, rebuilt

The first release of the new design system, and the first page moved onto it.
Everything else still renders through Tabler; the two are deliberately easy to
tell apart while the migration runs, and the previous Configure page is still
served at `/account/classic` so a regression here is one word to undo.

### The flow, which was the actual problem

`/account` was one long scroll on which playback services, catalogs,
collections and the install URL all carried the same weight. Nothing told a new
user what to do first, nothing ever told them they were finished, and the
install URL — the entire point of the page — sat in the middle of it.

Five steps now, in an order that argues for itself: **Services → Your teams →
Catalogs → Collections → Install**. Services first because a team you follow
with nothing to search it with is a catalog that plays nothing.

Two flows over one set of steps. A first run is a sequence with a permanent
"Skip to install" — a wizard you cannot leave is worse than no wizard. A
returning visit is not a sequence at all: every step is equally reachable and
the button says Save changes, because you came back to fix one API key, not to
be marched through five screens. Saving returns you to the step you were on.

### Check it works

Until now the first evidence that any of the setup worked was opening Stremio
and finding an empty row — and a pipeline returning nothing looked exactly like
one that was never configured. The Install step now runs one real fixture from
your own catalogs through your own pipelines and reports what each one did, so
a credentials problem is distinguishable from a matching problem without
reading a log.

### Deselecting a team now means something

A team catalog, once created, stayed in the catalog list for good: you
deselected the team, and then had to go and switch the catalog off by hand. The
team pick is the single source of truth now — deselect and the catalog leaves
your manifest by itself.

Leaving is not deleting. The promotion is switched off rather than removed, so
its stored fixtures stay on disk and re-picking the team is instant and costs
no provider calls. That also keeps the events out of the orphan prune added in
0.90.1, which keys on known promotions rather than served ones — deleting
outright is what left a store full of unreachable `manutd:` events in 0.89.1.

### Folders no longer hide rows

Being in a Nuvio collection and being on the home screen are separate things,
and the old page conflated them. Each catalog row now carries its own home-row
switch, and folder membership is shown on the row rather than implied by its
absence.

### The design system

`lib/ui/tokens.js`, `lib/ui/css.js` and `lib/ui/shell.js`: a token set, two
themes, and a slim icon rail of destinations. No framework and no build step —
the admin renders as strings of HTML from Node, and a design system that needed
a bundler would be the wrong answer to "SSS looks very 90s".

No webfonts. Vendoring Tabler in 0.90.0 was so a self-hosted addon renders on a
network that cannot reach a CDN; opening the new system with a Google Fonts
request would undo that on day one. The 0.90.8 skins survive as accent sets.

Nothing in Configure is ever `disabled` and no form is ever nested — the two
traps that have each cost this project a bug. A test asserts both.

## 0.90.8

### Skins

Tabler is themed through CSS custom properties, not swappable stylesheets, so a
skin here is a small variable block layered over the one vendored
tabler.min.css. No second download, no build step, and a new skin costs a dozen
lines.

Admin → Appearance picks from eight: **Sportsroom** (the current red),
**Floodlight** (blue), **Pitch** (green), **Amber**, **Terrace** (violet, soft
corners), **Broadcast** (red, sharp corners), **Daylight** (light, red) and
**Newsprint** (light, indigo, soft corners). The choice belongs to the
installation rather than the account — there is one admin console, not one per
user — so it is admin-only and applies everywhere on the next page load,
including the sign-in page.

Three things vary and no more: light or dark (Tabler's own `data-bs-theme`),
the accent, and the corner radius. Everything Tabler derives for itself is left
alone; only what it cannot derive is set — which is why the accent is written
as both hex and RGB, since the tints behind `.bg-primary-lt` come from the RGB
triple and would otherwise have stayed red.

**No font picker, deliberately.** Every font Tabler's own theme builder offers
is a Google Fonts request. Vendoring Tabler in 0.90.0 was specifically so a
self-hosted addon renders on a network that cannot reach a CDN; a skin that
quietly reintroduced a webfont would undo that, and would look fine to whoever
added it. A test asserts no skin emits a remote asset.

The sidebar stays dark in every skin, light modes included. Tabler's own
layouts do the same, a dark rail reads as chrome rather than content, and it
keeps the brand mark and white sidebar text correct without a second rule set.

An unknown skin — a hand-posted form value, a settings file edited by hand —
falls back to the default rather than reaching a `<style>` block, and an
unreadable settings file still renders the page, since that page is the one an
operator would use to fix it.

### The admin copy buttons had the same bug as the manifest one

Invite-link Copy used the same unguarded `navigator.clipboard` fixed in 0.90.6,
so on a plain-http LAN address it announced "Copied!" and copied nothing. Same
fallback now, and it says "Press Ctrl+C" rather than claiming success.

## 0.90.7

### The Sport-Video control wall

Fifteen inputs sat in one flat column, so the four that decide whether
Sport-Video does anything at all — the master switch, automatic scanning, which
sports, how often — were drawn exactly like the startup delay.

Those four stay in the open. Everything else folds into three named sections:
**Automatic warming** (it submits torrents to your TorBox account, so it is its
own section rather than buried in "advanced"), **Team limits**, and **Advanced
tuning**.

`<details>`, not a disabled fieldset: a closed `<details>` still submits its
inputs, where a disabled input submits nothing and would silently clear the
setting on the next save. That trap has cost this project two bugs already.

A folded section still says what it holds — "2 promotions · up to 5 per scan ·
last 14 days", or "Off — every release stays a manual click" — because a
section you cannot see that does not report its own state is just hidden state.
Anything switched on opens by default, so a setting that is actually doing
something is never behind a fold you have not seen. Sections you open or close
yourself are remembered.

### Latest scan

Eleven equal-weight rows, so "Last error" carried the same visual weight as
"Archive pages read" and the panel had to be read top to bottom to answer "did
the scan work?".

Now: the current state and last completion on one line, errors as an alert (or
a plain "No errors on the last run"), and the four counts that explain a
release you expected and did not get — unmatched, filtered out, outside window,
team filter — as a compact grid with a line each on what they mean. Discovery
source, index entries, archive pages and last re-match fold into Scan details.

## 0.90.6

### The discovered catalogs had artwork the client could never fetch

0.90.1 gave each of the seven `discovered-*` catalogs its own tile and set it
as `/assets/discovered-rugby.png`. That is a root-relative path, and a Stremio
meta is fetched by the CLIENT, not by a browser sitting on an SSS page — so it
resolved against the client's own origin and 404'd. Every tile stayed blank,
exactly as before, and reinstalling the manifest could not help.

It reads as correct in the code and looks right in an admin page, which is why
it survived a review. Every other piece of bundled art goes through
`brandedPoster`, which prefixes `PUBLIC_URL` and checks the file actually
ships — that is why nothing else has ever had this problem. The discovered
tiles go through it now too, and the test asserts an absolute URL rather than
just "some path".

If `PUBLIC_URL` is unset the poster is empty, as with all bundled art. Set it
to the address your clients reach SSS on or the tiles stay blank.

### The manifest Copy button said "Copied!" and copied nothing

`navigator.clipboard` only exists in a secure context. A self-hosted addon is
usually reached over plain http on a LAN address, where it is undefined — so
`if (navigator.clipboard)` skipped the copy and the very next line set the
label to "Copied!" anyway. The button reported success and the clipboard was
untouched, which is worse than an error.

It now uses the same fallback the Nuvio JSON copy already had: the async API
only where it exists, a detached textarea and `execCommand` otherwise, and if
both fail it selects the URL and says "Press Ctrl+C" instead of claiming to
have done something. The success label sits behind a copy that actually
succeeded.

## 0.90.5

### The log names accepted usenet releases, not only rejected ones

The filter summary said `discovered=4 afterNoise=4 matched=4`, and the
rejection log printed every refused title. So a log could prove exactly which
releases SSS threw away and could not prove which four it kept — which made
"is it finding the release I can see on my own indexer?" unanswerable without
guessing.

Accepted usenet candidates are now logged by title, with the indexer that
supplied them.

## 0.90.4

### The background search budget was too tight for the sources it exists for

0.90.3 works — from the log:

    16:07:05  uu: network timeout (7526ms) -> rows=2, backfill scheduled
    16:07:20  backfill: uu: 4 unique candidate(s)
    16:07:25  stream request complete durationMs=51 rows=3 usenetUltimate=4

Five seconds later the same fixture answered in 51 milliseconds with four
usenet rows. But the backfill before that one had itself timed out, at exactly
15000ms; the successful run took 14.8s. The retry built to rescue slow usenet
sources was losing to its own ceiling by 600 milliseconds.

The background budget is now 25s (`AVAILABILITY_WARM_PROVIDER_TIMEOUT_MS`).
Nothing waits on that path — it runs after the stream response has gone out, or
on the warmer's own schedule — so its job is to be the slow, thorough
counterpart to the live budget, and 15s was borrowed timidity from the live one.

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
