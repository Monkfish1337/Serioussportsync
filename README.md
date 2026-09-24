<p align="center">
  <img src="public/logo-banner.png" alt="SeriousSportSync" width="820">
</p>

<p align="center">
  A self-hosted sports calendar and stream orchestrator for Nuvio, Stremio,
  and other Stremio-compatible clients.
</p>

<p align="center">
  <a href="https://github.com/Monkfish1337/Serioussportsync/releases"><img src="https://img.shields.io/badge/version-1.1.0-blue.svg" alt="Version 1.1.0"></a>
  <a href="https://github.com/Monkfish1337/Serioussportsync/actions/workflows/ci.yml"><img src="https://github.com/Monkfish1337/Serioussportsync/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Monkfish1337/Serioussportsync/pkgs/container/serioussportsync"><img src="https://img.shields.io/badge/GHCR-container-2496ED?logo=docker&logoColor=white" alt="Container image"></a>
  <a href="https://github.com/Monkfish1337/Serioussportsync/discussions"><img src="https://img.shields.io/github/discussions/Monkfish1337/Serioussportsync?logo=github&label=discussions" alt="GitHub Discussions"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT license"></a>
</p>

SeriousSportSync turns sports events into proper catalog items with dates,
artwork, metadata, and optional playback results. It is primarily designed for
[Nuvio](https://github.com/zaarrak/Nuvio), and also works with Stremio and
compatible clients.

It hosts no media. Every playback connector is optional, self-hosted or
user-supplied, and remains under the operator's control.

## Community

Questions, ideas and setups belong in
[GitHub Discussions](https://github.com/Monkfish1337/Serioussportsync/discussions):

- **[Q&A](https://github.com/Monkfish1337/Serioussportsync/discussions/categories/q-a)**
  for installation, reverse proxies, TorBox, Usenet, Prowlarr and client help
- **[Ideas](https://github.com/Monkfish1337/Serioussportsync/discussions/categories/ideas)**
  for feature requests
- **[Show and tell](https://github.com/Monkfish1337/Serioussportsync/discussions/categories/show-and-tell)**
  for your setup, custom promotions and collections

[Issues](https://github.com/Monkfish1337/Serioussportsync/issues) are for
reproducible bugs. Before posting logs or screenshots anywhere, remove your
manifest URL (it contains your private token) and any API keys or passwords.
Please don't share links to copyrighted content, magnets, NZBs or streams.

## Start here

For a fresh server, follow the [installation and recovery guide](docs/INSTALLATION.md).
It covers Docker installation files, secret generation, LAN access, first
login, verification, updates, backups, rebuilding, and common failures.

The shortest path is:

1. Download `docker-compose.yml` and `.env.example` into a new directory.
2. Copy `.env.example` to `.env` and set one value: `SESSION_SECRET`.
3. Set `SSS_BIND_ADDRESS` only if another device must reach the server directly.
4. Run `docker compose up -d`, create the admin account, then work through
   **Configure**, which ends with the manifest URL to paste into your client.

The [minimal environment example](.env.example) contains only first-install
choices. Advanced overrides are kept in the [configuration reference](docs/CONFIGURATION.md).

## Why SeriousSportSync?

- Browse upcoming and recent events as first-class catalog entries.
- Cover sports that general movie and television metadata providers handle poorly.
- Search each event using promotion-aware names, dates, rounds, sessions, and matchups.
- Reject interviews, countdown shows, wrong years, wrong rounds, and unrelated releases.
- Give every account its own private install URL, drag-ordered catalogs, and playback credentials.
- Add provider-backed sports and tune matching rules from the admin interface.
- Reuse encrypted provider searches and account-scoped availability observations
  instead of repeating the same work whenever an event is opened.
- Deploy and update with Docker Compose while preserving state in a named volume.

## Supported sports

Twenty-five promotions ship built in. Most need no API key; the exceptions are
noted below. Each account can also add team catalogs from **Your teams** without
exposing every available club as a normal catalog.

**Combat sports and entertainment**

| Promotion | Coverage |
| --- | --- |
| UFC | PPVs, Fight Nights, UFC on ABC/ESPN, DWCS |
| ONE Championship | Numbered events, Fight Night, Friday Fights |
| WWE | PLEs, named NXT events, Saturday Night's Main Event |
| WWE Raw, SmackDown and NXT | Weekly television episodes with exact local air dates |
| AEW | PPVs and special events from the official AEW schedule |
| AEW Dynamite and Collision | Weekly television episodes, including targeted recovery for gaps in TheSportsDB's free feeds |
| Boxing | Cards from major promoters |

**Motorsport**

| Promotion | Coverage |
| --- | --- |
| Formula 1 | Race, qualifying, sprint, sprint qualifying, and practice sessions; Formula 2 and Formula 3 are excluded |
| MotoGP | Race, qualifying, sprint, and per-round sessions, including combined full-weekend releases |

**Football**

| Promotion | Source | Coverage |
| --- | --- | --- |
| UEFA Champions League | Official UEFA feed | Fixtures with full club identities and release-aware searches |
| Premier League | football-data.org | Fixtures, club alias table, three-letter code matching |
| Match of the Day | TMDB | Episodes; needs a free TMDB key |

Premier League needs a free football-data.org key and Match of the Day needs a
TMDB key. Both are set on **Metadata**, where a saved key overrides the matching
environment variable. A provider failure affects only assigned promotions and
leaves the rest working.

**North American sport**

| Promotion | Source | Coverage |
| --- | --- | --- |
| NFL | ESPN | Fixtures, `Away at Home` naming |
| NBA | ESPN | Fixtures |
| MLB | Official MLB schedule | Regular-season date and `Away @ Home` searches |

**Discovered sports**

Seven further promotions — Rugby, Football, Basketball, Baseball, American
Football, Hockey and Other Sport — are built the other way round. A Sport-Video
release that matches no fixture from any feed becomes an event of its own, so
content that would otherwise be found and discarded still reaches a catalog.
Metadata is weak by construction: the name is parsed from the release title and
the date is when the site published it. Where a real feed claims the fixture,
the feed always wins and the release never reaches ingestion.

**Custom promotions**

Anything else can be created from the admin UI on top of official UEFA,
API-Football, the official MLB schedule, TheSportsDB, football-data.org, TMDB,
ONE, or a custom JSON/API catalog.

## Discovery and playback

Playback is optional. SeriousSportSync can combine multiple pipelines and
returns only the rows that finish within the configured request budget.

Discovery and playback are separate jobs. A discovery source answers "what
releases exist for this event"; a playback service answers "can this account
actually play it". Sources are deliberately allowed to over-fetch, because the
promotion matcher is far better at rejecting a wrong release than any query
string is.

### Torrent discovery

| Source | How it works |
| --- | --- |
| Direct Bitmagnet | Queries a self-hosted [Bitmagnet](https://bitmagnet.io) index over GraphQL. One local database rather than a fan-out to remote trackers, so a query costs tens of milliseconds; results are ordered by seeders server-side, and info hashes arrive directly with no hydration pass |
| Direct Prowlarr | A measured background queue searches selected promotions slowly, saves seeded matches locally, tracks per-indexer budgets and cooldowns, and serves the saved database during playback. Live playback search has a separate switch; Improve Matching can still search Prowlarr when that switch is off |
| Companion scraper | Combines Prowlarr, Zilean, Torznab, and other sources configured in the separate [companion service](https://github.com/Monkfish1337/SeriousSportSync-Scraper) |
| Sport-Video | Reads the public RSS and bounded sport category catalogues, matches releases against existing events before downloading any torrent metadata, then validates same-origin detail pages and bounded bencoded torrent files |

The four source connections sit under **Server → Discovery pipelines** and keep
their settings when disabled. Their automatic work is controlled from the
source tabs in **Discovery**: Prowlarr, Sport-Video and Bitmagnet each have their
own promotion selection. Sport-Video is off on a fresh install because it polls
a third-party site on a schedule.

Torrent results are checked against each user's TorBox account and resolved on
play. Discovery never adds content to TorBox automatically; an uncached release
is submitted only when a user selects **Warm to TorBox**.

### How a stream request is answered

Discovery runs in the background, so opening an event is usually a database
lookup rather than a search:

1. **Database first.** Every release the background jobs have matched to the
   event is served straight away: Bitmagnet preparation, the Prowlarr queue,
   Sport-Video and earlier live answers all count. Bitmagnet is also asked,
   because a local index answers in milliseconds.
2. **Live Prowlarr only when needed.** If the database holds nothing for the
   event, and live search is enabled under **Server → Direct Prowlarr**, SSS
   searches Prowlarr live within the discovery budget. Promotions in the
   Prowlarr queue rely on the queue instead.
3. **Refresh searches live.** Pressing Refresh in Nuvio or Stremio within
   `LIVE_REFRESH_WINDOW_SECONDS` (default 30) of a database answer runs one
   live search, even for queued promotions. The refreshed list starts with a
   summary such as `🔄 Live search: 2 new releases` or `no new releases`, and
   marks new rows with 🆕.
4. **Everything found is kept.** Live results are saved to the database, even
   ones that arrive after the response has gone. The next request, from any
   account, serves them without searching again.

With live search disabled, requests are answered from the database and
Bitmagnet only, and Refresh does not search.

### Usenet and Easynews

| Source | Playback | How it works |
| --- | --- | --- |
| Native Newznab, NZBHydra, or Prowlarr | Built-in Usenet (native NNTP) | SSS searches the indexer directly, filters candidates once, and streams the matched release straight from your NNTP provider — no helper container |
| Easynews | Easynews | Searches and plays with credentials stored on the user's account |

Built-in Usenet is one pipeline: a native indexer connection for discovery and
a direct NNTP provider connection for playback. The admin **Usenet** page
presents this as two stages — search and candidate discovery, then native NNTP
playback. It owns the indexer and NNTP credentials, native performance
profiles, connection state, first-byte timing, throughput, retries and recent
playback results; Configure keeps the master pipeline switch. A usable
pipeline requires a ready indexer and a ready NNTP provider. New NNTP
configurations default to 20 connections, pre-authenticate their pool after
resolution, fetch one segment for startup and then pipeline a bounded
read-ahead window. The page offers Balanced, Low latency and Resilient
profiles plus bounded advanced controls. Native NNTP serves direct videos and
stored, unencrypted RAR4/RAR5 videos with HTTP byte ranges.

### The availability index

The local Smart Availability Index stores encrypted, normalized discoveries in
SQLite. Fresh torrent, native indexer, and Easynews searches are reused;
TorBox cache observations stay isolated by account credentials. The bounded
general preparation job is Bitmagnet-only. Prowlarr has its measured queue and
Sport-Video has its own sequential preparation worker. Built-in Usenet and
Easynews remain fast live responders and create no background indexer
traffic.

### Credentials

Provider credentials, admin source keys, and private install tokens are
encrypted at rest and are never included in the stream list returned to the
client; existing plaintext settings are migrated automatically. TorBox,
Easynews, and Built-in Usenet use signed, short-lived resolve URLs. A private
manifest URL grants use, not editing access, and can be rotated.

## Updating

~~~bash
docker compose pull
docker compose up -d --remove-orphans
~~~

The default Compose port is bound to <code>127.0.0.1</code>. Set
<code>SSS_BIND_ADDRESS</code> to the server's LAN IP for trusted LAN access, or
put a tunnel or authenticated reverse proxy in front. Do not expose port 7000
directly to the Internet. Preserve <code>SESSION_SECRET</code> across updates.

The named volume preserves accounts, event data, settings, custom promotions,
Nuvio collection layouts, and matching overrides across container replacements.

## How it fits together

~~~text
Metadata sources -> event catalog -> promotion-aware matching -> stream rows
                                             |                  |
                                             |                  +-> per-user playback service
                                             +-> noise, year, date, round, and session filters
~~~

- Metadata refreshes populate the event calendar independently of playback.
- Opening an event creates short, release-friendly search variants.
- Discovery sources return candidates; SeriousSportSync applies promotion rules.
- The user's configured service resolves the selected result only when needed.

Bitmagnet answers live requests from its local index and is also prepared in
bounded background batches. Direct Prowlarr normally serves the matches its
measured queue saved; the operator can separately enable live playback search.
The companion remains request-driven and is useful when several private
discovery sources need to be combined behind one endpoint.

## Configure

**Configure** is the signed-in user's own page, and it is five steps over a
single form — nothing is saved until the whole form is saved, and a returning
user can jump straight to any step.

1. **Services** — TorBox, Easynews, and Built-in Usenet, plus the
   maximum number of streams per fixture and whether warm-to-cache rows appear.
2. **Your teams** — pick a Premier League club, NFL, NBA, or MLB team to follow.
   An administrator can create a promotion straight from a pick.
3. **Catalogs** — the rows this account sees, in the order it sees them.
4. **Collections** — Nuvio collection folders, and **Push to Nuvio**, which
   signs in to Nuvio from the browser and writes the collections into a chosen
   profile. The password never reaches the SSS server and the token is held only
   for the length of the visit, so there is no background sync; a full replace
   is available but needs a typed confirmation.
5. **Install** — the private manifest URL, and a check that it works.

## Administration

The web interface is designed so routine operation does not require editing
JSON or application code. Changes take effect without rebuilding the image.

- **Server:** instance time zone, appearance, discovery pipeline connections,
  provider timing and source enable switches. Eight
  skins ship (Sportsroom, Floodlight, Pitch, Amber, Terrace, Broadcast,
  Daylight, Newsprint); a skin sets mode, accent, and corner radius for the
  whole instance and loads nothing remotely.
- **Promotions:** a five-step wizard asks for the name, saved event provider,
  real release examples, and optional artwork, then shows a plain-language
  review. SSS can research a selected event through the companion's TorBox
  discovery sources, the configured native Usenet indexer, and Easynews,
  explain every match or rejection, and apply confirmed examples without
  exposing credentials or download links. Detailed filters, pipeline controls,
  and source tools stay under **Advanced**. Conflicting reject words are
  repaired rather than silently excluding valid results. Built-in promotions
  have the same **Improve matching** workspace, and the overrides persist
  separately from the shipped definitions so upgrades preserve tuning.
- **Event Editor:** correct a source's date without changing the source. The
  override is reapplied after every refresh until it is removed.
- **Discovery:** seven-day torrent coverage, missing events and reasons, the
  measured Prowlarr queue, Sport-Video ingestion, Bitmagnet preparation and
  manual torrent-resource matching. Usenet and Easynews do not inflate these
  torrent coverage totals.
- **User Management:** access requests, approvals, users, roles and invitations.
- **Sport-Video:** its Discovery tab contains source status, scan controls,
  filters, preparation state, diagnostics and per-release TorBox actions.
- **Collections:** group promotions into collection folders, choose bundled,
  promotion-derived, or custom artwork, and download the current JSON. Newly
  created promotions are handed directly into this workflow.
- **Metadata:** save metadata API keys, force refreshes, and create or test reusable event providers independently of
  promotions. Use a ready-made adapter or connect a public JSON/API schedule by
  mapping its event-list, name, date, ID, venue, and artwork fields, without
  writing code. Preview normalized events without changing assignments or
  stored catalogs. See the [metadata source guide](docs/METADATA_SOURCES.md).
- **Database:** inspect stored searches and confirmed availability, then choose
  which services should prepare selected recent events automatically.
- **Logs:** a structured live operations console for discovery, filtering,
  rejection reasons, cache checks, playback resolution and timings. Every stream
  request receives a traceable request ID; expand a row to inspect counts, query
  variants and decisions. Pause without losing your place, use regular or regex
  search, filter multiple levels, copy individual or visible entries, and export
  readable `.log` or structured `.ndjson` output.
- **Backup:** download the whole data directory as a gzipped tar. Restoring is
  a manual host-side step, described in the [installation guide](docs/INSTALLATION.md).

Source refreshes can replace their event cache without overwriting saved
promotions, aliases, exclusions, disabled-event decisions, or matching rules.

## Configuration highlights

Start with the short [.env.example](./.env.example). The annotated
[configuration reference](docs/CONFIGURATION.md) contains advanced variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| <code>SESSION_SECRET</code> | required | Signs login cookies; use at least 32 random characters |
| <code>ADMIN_USER</code> | none | Username promoted to administrator during initial signup |
| <code>PUBLIC_URL</code> | auto-detected | Public origin used for private install and resolve URLs. Set it behind an HTTPS reverse proxy, or playback links are generated as <code>http://</code> |
| <code>TRUST_PROXY</code> | <code>false</code> | Set to <code>1</code> only when SSS is exclusively behind your trusted reverse proxy/tunnel; enables forwarded client IP, host, protocol, and secure-cookie handling |
| <code>REFRESH_INTERVAL_HOURS</code> | <code>6</code> | Metadata refresh interval |
| <code>AVAILABILITY_DB_FILE</code> | <code>./data/availability.sqlite</code> | Encrypted reusable provider searches, event/release matches, card-part classification, and scoped availability observations |
| <code>AVAILABILITY_WARM_ENABLED</code> | <code>true</code> | Proactively populate selected recent events from Bitmagnet in the background |
| <code>AVAILABILITY_SERVE_CONFIRMED</code> | <code>true</code> | Reuse fresh, account-scoped confirmed results before repeating provider discovery |
| <code>BITMAGNET_URL</code> | none | Optional direct Bitmagnet discovery; <code>/graphql</code> is appended automatically |
| <code>BITMAGNET_LIMIT</code> | <code>300</code> | Results per Bitmagnet query |
| <code>COMPANION_URL</code> | none | Optional SeriousSportSync-Scraper companion endpoint |
| <code>PROWLARR_URL</code> / <code>PROWLARR_API_KEY</code> | none | Optional direct Prowlarr discovery |

Server-wide discovery credentials belong in **Server** or the root environment;
companion-managed sources belong in the companion's own settings. Each playback
pipeline has an independent enable switch, so it can be excluded without
deleting credentials. Disabling UU stream rows does not disable the optional UU
text search used by the DIY pipeline.

Running from source requires Node.js 22 or newer. The supplied container builds
and runs on Node.js 24.

## Development

Build the local checkout with the development override:

~~~bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
~~~

Run the unit suite with `npm run test:unit`. It uses the Node test runner and
needs no services; the suite is expected to pass on Windows as well as Linux.

For a bespoke built-in promotion, add a self-contained definition to
<code>lib/promotions.js</code>. Simple metadata-backed sports should normally be
added from the Promotions creator instead.

Pull requests run JavaScript/module-load validation and a Docker Compose smoke
deployment. Merges to <code>main</code> publish the public container image to
GHCR and test that image through Compose.

The deployment threat model, trusted-proxy guidance, encrypted data inventory,
and reporting process are documented in [Security](docs/SECURITY.md). Planned
work is listed in the [roadmap](docs/ROADMAP.md), and the
[changelog](CHANGELOG.md) records why each release changed what it did.

## Responsible use

SeriousSportSync is a metadata catalog and stream orchestrator published for
educational and personal self-hosting use. It hosts no content, includes no
third-party credentials, and is not affiliated with any sport, league,
broadcaster, indexer, debrid provider, or media service. Operators are
responsible for complying with applicable laws and service terms.

## License

[MIT](./LICENSE)
