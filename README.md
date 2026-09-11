<p align="center">
  <img src="public/logo-banner.png" alt="SeriousSportSync" width="820">
</p>

<p align="center">
  A self-hosted sports calendar and stream orchestrator for Nuvio, Stremio,
  and other Stremio-compatible clients.
</p>

<p align="center">
  <a href="https://github.com/Monkfish1337/Serioussportsync/releases"><img src="https://img.shields.io/badge/version-0.95.0-blue.svg" alt="Version 0.95.0"></a>
  <a href="https://github.com/Monkfish1337/Serioussportsync/actions/workflows/ci.yml"><img src="https://github.com/Monkfish1337/Serioussportsync/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Monkfish1337/Serioussportsync/pkgs/container/serioussportsync"><img src="https://img.shields.io/badge/GHCR-container-2496ED?logo=docker&logoColor=white" alt="Container image"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT license"></a>
</p>

SeriousSportSync turns sports events into proper catalog items with dates,
artwork, metadata, and optional playback results. It is primarily designed for
[Nuvio](https://github.com/zaarrak/Nuvio), and also works with Stremio and
compatible clients.

It hosts no media. Every playback connector is optional, self-hosted or
user-supplied, and remains under the operator's control.

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

Twenty-nine promotions ship built in. Most need no API key; the three
exceptions are noted in the tables below.

**Combat sports and entertainment**

| Promotion | Coverage |
| --- | --- |
| UFC | PPVs, Fight Nights, UFC on ABC/ESPN, DWCS |
| ONE Championship | Numbered events, Fight Night, Friday Fights |
| WWE | PLEs, named NXT events, Saturday Night's Main Event |
| AEW | PPVs and special events; weekly TV is excluded |
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
| EFL Championship | football-data.org | Fixtures and club alias table |
| La Liga | football-data.org | Fixtures |
| Serie A | football-data.org | Fixtures |
| Bundesliga | football-data.org | Fixtures |
| Ligue 1 | football-data.org | Fixtures |
| Eredivisie | football-data.org | Fixtures |
| Brasileirão | football-data.org | Fixtures |
| Match of the Day | TMDB | Episodes; needs a free TMDB key |

The eight football-data.org promotions need a free API key and Match of the Day
needs a TMDB one; both are set in **Server**, and a key saved there overrides
the matching environment variable. A football-data key without access to a given
competition fails only that promotion's refresh and leaves the rest working.

**North American sport**

| Promotion | Source | Coverage |
| --- | --- | --- |
| NFL | ESPN | Fixtures, `Away at Home` naming |
| NBA | ESPN | Fixtures |
| WNBA | ESPN | Fixtures |
| College Football | ESPN | Fixtures |
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
| Direct Prowlarr | Searches the configured Prowlarr instance when an event is opened |
| Companion scraper | Combines Prowlarr, Zilean, Torznab, and other sources configured in the separate [companion service](https://github.com/Monkfish1337/SeriousSportSync-Scraper) |
| Sport-Video | Reads the public RSS and bounded sport category catalogues, matches releases against existing events before downloading any torrent metadata, then validates same-origin detail pages and bounded bencoded torrent files |

All four sit on one card in **Server**, as collapsible blocks whose summaries
show which are on. Each has an enable toggle, so a source can be taken out of
the pipeline for comparison without deleting its URL and credentials. The first
three are on by default and a source saved before the toggles existed stays
enabled; Sport-Video is off until you turn it on, because it reaches a
third-party site on a schedule.

Torrent results are checked against each user's TorBox account and resolved on
play. Discovery never adds content to TorBox automatically; an uncached release
is submitted only when a user selects **Warm to TorBox**.

### Usenet and Easynews

| Source | Playback | How it works |
| --- | --- | --- |
| Usenet Ultimate | Usenet Ultimate / NzbDAV | Sends event title variants to the user's UU instance; UU searches its configured indexers and handles playback |
| Usenet Ultimate search | DIY Usenet pipeline | Optional additive discovery path shared by the NZB DAV and native NNTP backends |
| Native Newznab, NZBHydra, or Prowlarr | DIY Usenet pipeline | SSS searches the endpoint directly, filters candidates once, and exposes independently toggled playback rows |
| Native Newznab, NZBHydra, or Prowlarr | Native NNTP preview | Serves direct videos and stored, unencrypted RAR4/RAR5 videos with HTTP byte ranges; unsupported archives keep an adjacent NZB DAV fallback row |
| Easynews | Easynews | Searches and plays with credentials stored on the user's account |

Native DIY search and UU search can be enabled independently or merged, and UU
is no longer required for DIY playback when native search is configured. The
**DIY Usenet** page presents this as two stages: search and candidate
discovery, then playback backends. New NNTP configurations default to 20
connections, pre-authenticate their pool after resolution, and pipeline bounded
read windows to reduce startup and seek latency; set a lower limit when the
provider requires one. Compressed or encrypted RAR files and 7z releases
continue through the NZB DAV row.

> **Usenet Ultimate compatibility:** direct sports-title search requires the
> endpoint proposed in [Usenet Ultimate PR #46](https://github.com/DSmart33/Usenet-Ultimate/pull/46).
> Until it is included upstream, use
> `ghcr.io/monkfish1337/usenet-ultimate:sss-direct` for the UU service. The
> normal UU configuration, manifest URL, indexers, and NzbDAV setup are unchanged.

### The availability index

The local Smart Availability Index stores encrypted, normalized discoveries in
SQLite. Fresh torrent, UU, native indexer, and Easynews searches are reused;
TorBox cache observations stay isolated by account credentials. A bounded
background job prepares torrent and TorBox results for selected catalogs aired
in the last three days, so likely playable links are ready before a user opens
an event. Usenet and Easynews benefit from on-demand search reuse but do no
background work unless an administrator opts in from **Database**.

### Credentials

Provider credentials, admin source keys, and private install tokens are
encrypted at rest and are never included in the stream list returned to the
client; existing plaintext settings are migrated automatically. TorBox,
Easynews, and DIY NZB DAV use signed, short-lived resolve URLs. A private
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

Bitmagnet, direct Prowlarr and the optional companion are all request-only: SSS
contacts them for the event a user opens. The companion is useful when several
discovery sources need to be combined behind one endpoint.

## Configure

**Configure** is the signed-in user's own page, and it is five steps over a
single form — nothing is saved until the whole form is saved, and a returning
user can jump straight to any step.

1. **Services** — TorBox, Usenet Ultimate, Easynews, and DIY Usenet, plus the
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

- **Server:** appearance, invites, users, catalogs, and the torrent discovery
  and metadata source credentials — Bitmagnet, Prowlarr and the companion, each
  with its own enable toggle, plus API keys for football-data.org and
  API-Football. Eight
  skins ship (Sportsroom, Floodlight, Pitch, Amber, Terrace, Broadcast,
  Daylight, Newsprint); a skin sets mode, accent, and corner radius for the
  whole instance and loads nothing remotely.
- **Promotions:** a five-step wizard asks for the name, saved event provider,
  real release examples, and optional artwork, then shows a plain-language
  review. SSS can research a selected event through the companion's TorBox
  discovery sources, configured DIY indexers, Usenet Ultimate, and Easynews,
  explain every match or rejection, and apply confirmed examples without
  exposing credentials or download links. Detailed filters, pipeline controls,
  and source tools stay under **Advanced**. Conflicting reject words are
  repaired rather than silently excluding valid results. Built-in promotions
  have the same **Improve matching** workspace, and the overrides persist
  separately from the shipped definitions so upgrades preserve tuning.
- **Event Editor:** correct a source's date without changing the source. The
  override is reapplied after every refresh until it is removed.
- **Sport-Video:** source status, scan controls, category selection, search,
  filters, match visibility, preparation state, and per-release TorBox actions.
- **Collections:** group promotions into collection folders, choose bundled,
  promotion-derived, or custom artwork, and download the current JSON. Newly
  created promotions are handed directly into this workflow.
- **Metadata:** create and test reusable event providers independently of
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
| <code>PUBLIC_URL</code> | auto-detected | Public origin used for private install and resolve URLs |
| <code>TRUST_PROXY</code> | <code>false</code> | Set to <code>1</code> only when SSS is exclusively behind your trusted reverse proxy/tunnel; enables forwarded client IP, host, protocol, and secure-cookie handling |
| <code>REFRESH_INTERVAL_HOURS</code> | <code>6</code> | Metadata refresh interval |
| <code>AVAILABILITY_DB_FILE</code> | <code>./data/availability.sqlite</code> | Encrypted reusable provider searches, event/release matches, card-part classification, and scoped availability observations |
| <code>AVAILABILITY_WARM_ENABLED</code> | <code>true</code> | Proactively populate recent-event availability in the background |
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
