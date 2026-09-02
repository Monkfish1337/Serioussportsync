<p align="center">
  <img src="public/logo-banner.png" alt="SeriousSportSync" width="820">
</p>

<p align="center">
  A self-hosted sports calendar and stream orchestrator for Nuvio, Stremio,
  and other Stremio-compatible clients.
</p>

<p align="center">
  <a href="https://github.com/Monkfish1337/Serioussportsync/releases"><img src="https://img.shields.io/badge/version-0.76.0-blue.svg" alt="Version 0.76.0"></a>
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
4. Run `docker compose up -d`, create the admin account, then configure optional
   playback services from **Account**.

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

| Sport | Coverage |
| --- | --- |
| UFC | PPVs, Fight Nights, UFC on ABC/ESPN, DWCS |
| ONE Championship | Numbered events, Fight Night, Friday Fights |
| WWE | PLEs, named NXT events, Saturday Night's Main Event |
| AEW | PPVs and Zero Hour pre-shows |
| Formula 1 | Race, qualifying, sprint, sprint qualifying, and practice sessions |
| MotoGP | Race, qualifying, sprint, and per-round sessions |
| Boxing | Cards from major promoters |
| Manchester United | Upcoming and recent fixtures across all football-data.org competitions |
| UEFA Champions League | API-Football fixtures with UCL team identities and release-aware searches |
| Custom promotions | API-Football, official MLB, TSDB, football-data.org, TMDB, ONE, or custom JSON/API catalogs created in the admin UI |

## Playback integrations

Playback is optional. SeriousSportSync can combine multiple pipelines and
returns only the rows that finish within the configured request budget.

The local Smart Availability Index stores encrypted, normalized discoveries in
SQLite. Fresh Torrent, UU, native indexer, and Easynews searches are reused;
TorBox cache observations remain isolated by account credentials. A bounded
background job prepares Torrent/TorBox results for selected catalogs aired in
the last three days, so likely playable links are ready before a user opens an
event. Usenet and Easynews continue to benefit from on-demand search reuse but
do no background work unless an administrator opts in from **Database**.

| Discovery | Per-user playback | How it works |
| --- | --- | --- |
| Direct Prowlarr | TorBox | Searches when an event is opened, checks the user's cache, and resolves on play |
| Companion scraper | TorBox | Combines Prowlarr, Zilean, Torznab, and other configured companion sources |
| Usenet Ultimate | Usenet Ultimate / NzbDAV | Sends event title variants to the user's UU instance; UU searches its configured indexers and handles playback |
| Usenet Ultimate search | DIY Usenet pipeline | Optional additive discovery path shared by the enabled NZB DAV and native NNTP playback backends |
| Native Newznab, NZBHydra, or Prowlarr search | DIY Usenet pipeline | SSS searches the configured endpoint directly, filters candidates once, and exposes independently toggled playback rows |
| Native Newznab, NZBHydra, or Prowlarr search | Native NNTP preview | SSS serves direct videos and stored, unencrypted RAR4/RAR5 videos with HTTP byte ranges; unsupported archives retain an adjacent NZB DAV fallback row |
| Easynews | Easynews | Searches and plays with credentials stored on the user's account |

> **Usenet Ultimate compatibility:** direct sports-title search requires the
> endpoint proposed in [Usenet Ultimate PR #46](https://github.com/DSmart33/Usenet-Ultimate/pull/46).
> Until it is included upstream, use
> `ghcr.io/monkfish1337/usenet-ultimate:sss-direct` for the UU service. The
> normal UU configuration, manifest URL, indexers, and NzbDAV setup are unchanged.

Native DIY search and UU search can be enabled independently or merged. UU is
no longer required for DIY playback when native search is configured. The
Account page presents this as a Discover → Match → Play pipeline, with a shared
search stage and separate NZB DAV and native NNTP playback cards.
The native NNTP preview stores provider credentials encrypted, tests
authentication, and emits separate native rows for direct files and stored,
unencrypted RAR4/RAR5 videos. Compressed or encrypted RAR files and 7z releases
continue through their existing NZB DAV row.
New NNTP configurations default to 20 connections, pre-authenticate their pool
after resolution, and pipeline bounded read windows to reduce startup and seek
latency. Set a lower account limit when required by the provider.
Provider credentials, admin source keys, and private install tokens are encrypted
at rest and are never included in the stream list returned to the client. Existing
plaintext settings are migrated automatically. TorBox, Easynews, and DIY NZB DAV use
signed, short-lived resolve URLs. Configure the experimental DIY path in the
open **DIY Usenet pipeline** section on the Account page; it does not disable or
replace any existing service.

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

Direct Prowlarr and the optional companion are both request-only: SSS contacts
them only for the event a user opens. The companion is useful when several
discovery sources need to be combined behind one endpoint.

## Administration

The web interface is designed so routine operation does not require editing
JSON or application code.

- **Admin:** refresh metadata, review catalog state, and configure direct
  Prowlarr or the optional companion scraper.
- **Database:** inspect stored searches and confirmed availability, then choose
  which services should prepare selected recent events automatically.
- **Users:** create invites and manage shared deployments.
- **Metadata:** create and test reusable event providers independently of
  promotions. Use a ready-made adapter or connect a public JSON/API schedule by
  mapping its event-list, name, date, ID, venue, and artwork fields—without
  writing code. Preview normalized events without changing assignments or
  stored catalogs. API-Football is the preferred football adapter and powers
  the shipped Champions League promotion; the official MLB schedule requires no API key.
- **Promotions:** a five-step wizard asks for the name, saved event provider,
  real release examples, and optional artwork, then shows a plain-language
  review. Create and test providers in Metadata, then select them here. SSS
  derives matching aliases and search patterns from examples; detailed filters,
  pipeline controls, and source tools remain available under **Advanced**. Conflicting reject words
  are repaired rather than silently excluding valid results. The built-in
  indexer finder can search Newznab/NZBHydra or Prowlarr directly, filter and
  sort titles, and add examples without the companion service.
- **Nuvio Collections:** group promotions into collection folders, choose
  bundled, promotion-derived, or custom artwork, and download the current JSON.
  Newly created promotions are handed directly into this workflow.
- **Missing event inbox:** accept, merge, or ignore source events rejected by
  promotion filters and possible duplicate detection.
- **Imports and matching assistant:** preview ICS, CSV, or JSON calendars, then
  derive event-specific search aliases and exclusions from good and bad titles.
- **Logs:** use the structured live operations console to inspect discovery,
  filtering, rejection reasons, cache checks, playback resolution and timings.
  Every stream request receives a traceable request ID; expand a row to inspect
  counts, query variants and decisions. Pause without losing your place, use
  regular or regex search, filter multiple levels, copy individual or visible
  entries, and export either readable `.log` or structured `.ndjson` output.

Source refreshes can replace their event cache without overwriting saved
promotions, aliases, exclusions, disabled-event decisions, or matching rules.
Changes take effect without rebuilding the image.

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
| <code>COMPANION_URL</code> | none | Optional SeriousSportScraper companion endpoint |
| <code>PROWLARR_URL</code> / <code>PROWLARR_API_KEY</code> | none | Optional direct Prowlarr discovery |

Users configure TorBox, Usenet Ultimate, the DIY Usenet pipeline, Easynews, catalog ordering, and client
exports together on the signed-in Account page. Each legacy playback pipeline has
an independent enable switch, so it can be excluded without deleting credentials.
Disabling UU stream rows does not disable the optional UU text search used by the DIY pipeline.
The private manifest URL grants
use, not editing access, and can be rotated from that page. Server-wide discovery
credentials belong in Admin or the root environment. Companion-managed sources
belong in the companion's own settings.

Running from source requires Node.js 22 or newer. The supplied container uses
Node.js 24 LTS.

## Development

Build the local checkout with the development override:

~~~bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
~~~

For a bespoke built-in promotion, add a self-contained definition to
<code>lib/promotions.js</code>. Simple metadata-backed sports should normally be
added from the Promotions creator instead.

Pull requests run JavaScript/module-load validation and a Docker Compose smoke
deployment. Merges to <code>main</code> publish the public container image to
GHCR and test that image through Compose.

The deployment threat model, trusted-proxy guidance, encrypted data inventory,
and reporting process are documented in [Security](docs/SECURITY.md).

## Responsible use

SeriousSportSync is a metadata catalog and stream orchestrator published for
educational and personal self-hosting use. It hosts no content, includes no
third-party credentials, and is not affiliated with any sport, league,
broadcaster, indexer, debrid provider, or media service. Operators are
responsible for complying with applicable laws and service terms.

## License

[MIT](./LICENSE)
