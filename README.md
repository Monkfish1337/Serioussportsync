<p align="center">
  <img src="public/logo-banner.png" alt="SeriousSportSync" width="820">
</p>

<p align="center">
  A self-hosted sports calendar and stream orchestrator for Nuvio, Stremio,
  and other Stremio-compatible clients.
</p>

<p align="center">
  <a href="https://github.com/Monkfish1337/Serioussportsync/releases"><img src="https://img.shields.io/badge/version-0.43.2-blue.svg" alt="Version 0.43.2"></a>
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

## Why SeriousSportSync?

- Browse upcoming and recent events as first-class catalog entries.
- Cover sports that general movie and television metadata providers handle poorly.
- Search each event using promotion-aware names, dates, rounds, sessions, and matchups.
- Reject interviews, countdown shows, wrong years, wrong rounds, and unrelated releases.
- Give every account its own private install URL, catalogs, and playback credentials.
- Add simple TSDB-backed sports and tune matching rules from the admin interface.
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
| Custom promotions | TSDB, football-data.org, or TMDB-backed catalogs created in the admin UI |

## Playback integrations

Playback is optional. SeriousSportSync can combine multiple pipelines and
returns only the rows that finish within the configured request budget.

| Discovery | Per-user playback | How it works |
| --- | --- | --- |
| Direct Prowlarr | TorBox | Searches when an event is opened, checks the user's cache, and resolves on play |
| Companion scraper | TorBox | Combines Prowlarr, Zilean, Torznab, and other configured companion sources |
| Usenet Ultimate | Usenet Ultimate / NzbDAV | Sends event title variants to the user's UU instance; UU searches its configured indexers and handles playback |
| Easynews | Easynews | Searches and plays with credentials stored on the user's account |

> **Usenet Ultimate compatibility:** direct sports-title search requires the
> endpoint proposed in [Usenet Ultimate PR #46](https://github.com/DSmart33/Usenet-Ultimate/pull/46).
> Until it is included upstream, use
> `ghcr.io/monkfish1337/usenet-ultimate:sss-direct` for the UU service. The
> normal UU configuration, manifest URL, indexers, and NzbDAV setup are unchanged.

Credentials are encrypted at rest where applicable and are never included in
the stream list returned to the client. TorBox and Easynews playback use signed,
short-lived resolve URLs.

## Quick start with Docker Compose

Create a directory and save the following as <code>docker-compose.yml</code>:

~~~yaml
services:
  serioussportsync:
    image: ghcr.io/monkfish1337/serioussportsync:latest
    container_name: serioussportsync
    restart: unless-stopped
    env_file:
      - .env
    ports:
      - "7000:7000"
    volumes:
      - serioussportsync_data:/app/data

volumes:
  serioussportsync_data:
~~~

Create <code>.env</code> with a random session secret and your intended
administrator username:

~~~env
SESSION_SECRET=replace-with-at-least-32-random-characters
ADMIN_USER=admin
~~~

Generate a suitable secret with <code>openssl rand -hex 32</code>, then start
the stack:

~~~bash
docker compose up -d
~~~

Open <code>http://&lt;your-server&gt;:7000/</code>, create the account matching
<code>ADMIN_USER</code>, configure discovery services under Admin, then copy
your private install URL from Account into Nuvio or Stremio.

If port 7000 is occupied, change only the host side, for example
<code>"7010:7000"</code>.

The repository includes ready-to-use [docker-compose.yml](./docker-compose.yml)
and [.env.example](./.env.example) files with the complete configuration
surface.

## Updating

~~~bash
docker compose pull
docker compose up -d --remove-orphans
~~~

The named volume preserves accounts, event data, settings, custom promotions,
and matching overrides across container replacements.

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

Direct Prowlarr is request-only and is not searched by the scheduled cache
warmer. The optional companion is useful when several discovery sources need to
be combined behind one endpoint.

## Administration

The web interface is designed so routine operation does not require editing
JSON or application code.

- **Dashboard:** refresh metadata, inspect service health, and review state.
- **Services:** configure direct Prowlarr and the optional companion scraper.
- **Users:** create invites and manage shared deployments.
- **Match editor:** add aliases or noise rules and test a release before saving.
- **Guided promotions creator:** find a TSDB, football-data.org, or TMDB source,
  preview real events, auto-configure matching, then create and import in one step.
- **Content Studio:** search metadata sources, review promotion coverage, add or
  edit events, and disable unwanted entries without losing changes on refresh.
- **Missing event inbox:** accept, merge, or ignore source events rejected by
  promotion filters and possible duplicate detection.
- **Imports and matching assistant:** preview ICS, CSV, or JSON calendars, then
  derive event-specific search aliases and exclusions from good and bad titles.
- **Event power tool:** run an explicit event search and inspect matching results.
- **Logs:** inspect discovery, filtering, cache checks, and playback resolution.

Content Studio uses a separate editorial layer under <code>/app/data</code>.
Source refreshes can replace their event cache without overwriting manual
events, source-event edits, disabled-event decisions, or matching rules. Changes
take effect without rebuilding the image.

## Configuration highlights

See [.env.example](./.env.example) for the annotated full list.

| Variable | Default | Purpose |
| --- | --- | --- |
| <code>SESSION_SECRET</code> | required | Signs login cookies; use at least 32 random characters |
| <code>ADMIN_USER</code> | none | Username promoted to administrator during initial signup |
| <code>PUBLIC_URL</code> | auto-detected | Public origin used for private install and resolve URLs |
| <code>REFRESH_INTERVAL_HOURS</code> | <code>6</code> | Metadata refresh interval |
| <code>EVENT_WINDOW_START_DATE</code> | <code>2025-01-01</code> | Earliest catalog date |
| <code>CONTENT_STUDIO_FILE</code> | <code>./data/content-studio.json</code> | Refresh-safe manual content and editorial decisions |
| <code>COMPANION_URL</code> | none | Optional SeriousSportScraper companion endpoint |
| <code>PROWLARR_URL</code> / <code>PROWLARR_API_KEY</code> | none | Optional direct Prowlarr discovery |
| <code>STREAM_MAX_ROWS</code> | <code>20</code> | Maximum stream rows returned per request |
| <code>STREAM_PIPELINE_TIMEOUT_MS</code> | <code>8000</code> | Maximum time allowed for each playback pipeline |

Users configure their own TorBox, Usenet Ultimate, and Easynews credentials on
the Account page. Server-wide discovery credentials belong in Admin or the root
environment. Companion-managed sources belong in the companion's own settings.

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

## Responsible use

SeriousSportSync is a metadata catalog and stream orchestrator published for
educational and personal self-hosting use. It hosts no content, includes no
third-party credentials, and is not affiliated with any sport, league,
broadcaster, indexer, debrid provider, or media service. Operators are
responsible for complying with applicable laws and service terms.

## License

[MIT](./LICENSE)
