# Configuration reference

SeriousSportSync is intended to start with only `SESSION_SECRET`. Most
playback services and operational settings can then be managed in the web
interface. Environment variables are useful for deployment-wide defaults,
file locations, and advanced troubleshooting.

Copy [`.env.example`](../.env.example) to `.env` for a new Docker Compose
installation. Do not copy this entire reference into `.env`: unspecified
values use the maintained application defaults.

## Required and common settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | required | Signs sessions and encrypts stored credentials. Use at least 32 random characters and preserve it across updates and migrations. |
| `ADMIN_USER` | none | Username promoted to administrator when it signs up. The password is created in the browser. |
| `SSS_BIND_ADDRESS` | `127.0.0.1` | Host address published by the supplied Compose file. Use the server's LAN IP for trusted LAN access. This is a Compose setting, not an application setting. |
| `SSS_HOST_PORT` | `7000` | Host port published by the supplied Compose file. |
| `PUBLIC_URL` | request origin | Fixed public origin used in private install and resolve URLs. |
| `TRUST_PROXY` | `false` | Set to `1` only when SSS is reachable exclusively through a trusted reverse proxy or tunnel. |
| `ADDON_TYPE` | `movie` | Catalog item type. Some Nuvio clients may work better with `series`. |

`ALLOW_INSECURE_SECRET=1` permits a missing or short secret for local
development only. It must never be used for a real deployment.

## Metadata

| Variable | Default | Purpose |
| --- | --- | --- |
| `TSDB_API_KEY` | `123` | TheSportsDB API key. Replace with your own key when available. |
| `TSDB_SEASONS` | `auto` | Derive relevant seasons from the event window, or use a comma-separated list. |
| `FOOTBALL_DATA_API_KEY` | none | Optional football-data.org key for assigned metadata sources. |
| `TMDB_API_KEY` | none | Optional TMDB key for assigned television-style metadata sources. |
| `EVENT_WINDOW_DAYS_BACK` | `30` | Number of previous days retained in the catalog. |
| `EVENT_WINDOW_DAYS_AHEAD` | `90` | Number of future days retained in the catalog. |
| `EVENT_WINDOW_START_DATE` | `2025-01-01` | Hard lower date boundary used by built-in refresh logic. |
| `REFRESH_INTERVAL_HOURS` | `6` | Metadata refresh cadence. Set to `0` to disable scheduled refreshes. |
| `REFRESH_ON_EMPTY_CACHE` | `true` | Refresh automatically when the event cache is empty. |
| `WIKIPEDIA_ENRICH` | `on` | Add artwork to supported events when source artwork is missing. Set to `off` to skip it. |

Metadata providers, assignments, promotions, aliases, and Nuvio collections
should normally be managed from **Metadata**, **Promotions**, and
**Nuvio Collections** in the admin sidebar.

## Discovery and playback

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPANION_URL` | none | Optional SeriousSportSync Companion endpoint. |
| `COMPANION_AUTH_TOKEN` | none | Shared authentication token for the companion. |
| `COMPANION_TIMEOUT_MS` | `30000` | Hard client timeout for companion requests. The smaller per-request discovery budget still applies. |
| `PROWLARR_URL` / `PROWLARR_API_KEY` | none | Optional direct Prowlarr discovery bootstrap. These can be saved in Admin instead. |
| `ZILEAN_URL` | none | Optional direct Zilean endpoint for legacy/bootstrap discovery. |
| `STREAM_MAX_ROWS` | `20` | Maximum rows returned for an event. |
| `STREAM_PIPELINE_TIMEOUT_MS` | `8000` | Maximum duration of each interactive playback pipeline. |
| `STREAM_DISCOVERY_BUDGET_MS` | `5000` | Discovery portion of the pipeline deadline, reserving time for matching and provider checks. |
| `ALLOW_FOREIGN_LANG` | `false` | Set to `1` to retain foreign-language release candidates. |
| `LOG_EXCLUDED_TITLES` | `false` | Initial default for full rejection detail. It can be changed live and persisted from the Logs page. |
| `LOG_REJECTION_SAMPLE_LIMIT` | `4` | Rejected titles retained per exclusion reason when full detail is off. |
| `LOG_BUFFER_MAX_BYTES` | `5242880` | Maximum memory used by the live structured log buffer before its oldest entries are discarded. |

TorBox, Easynews, Usenet Ultimate, native indexer, NZB DAV, and NNTP settings
are account-scoped and belong on the signed-in **Account** page.

## Smart Availability

The **Database** page provides live status and lets an administrator choose
which services prepare recent events without recreating the container. Torrent
and TorBox preparation is enabled by default; Usenet and Easynews retain normal
on-demand database caching without background traffic unless opted in.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AVAILABILITY_DB_FILE` | `./data/availability.sqlite` | SQLite knowledge store. |
| `AVAILABILITY_WARM_ENABLED` | `true` | Warm recently aired events in the background. |
| `AVAILABILITY_SERVE_CONFIRMED` | `true` | Serve fresh confirmed results without repeating discovery. |
| `AVAILABILITY_PREPARE_TORRENT` | `true` | Prepare torrent discovery and account-scoped TorBox cache checks automatically. |
| `AVAILABILITY_PREPARE_USENET` | `false` | Opt UU and native indexer searches into automatic preparation. This never submits or downloads an NZB. |
| `AVAILABILITY_PREPARE_EASYNEWS` | `false` | Opt account-scoped Easynews searches into automatic preparation. |
| `AVAILABILITY_WARM_WINDOW_DAYS` | `3` | Recently aired event window considered for automatic preparation. |
| `AVAILABILITY_WARM_INTERVAL_HOURS` | `6` | Time between warmer runs. |
| `AVAILABILITY_WARM_MAX_EVENTS_PER_RUN` | `25` | Rotating event batch size. |
| `AVAILABILITY_WARM_START_DELAY_SECONDS` | `60` | Delay after application start. |
| `AVAILABILITY_WARM_PROVIDER_TIMEOUT_MS` | `15000` | Search budget supplied to supported background providers. |
| `AVAILABILITY_WARM_FAILURE_THRESHOLD` | `2` | Consecutive failures before a provider/account pair is skipped for the current run. |

Advanced retention defaults are 6 hours for torrent/TorBox observations, 12
hours for Usenet and Easynews searches, 30 minutes for negative observations,
and 30 days for retained records. They can be overridden with the corresponding
`AVAILABILITY_*_TTL_*` and `AVAILABILITY_RETENTION_DAYS` variables.

## Files and security tuning

All default files live below `/app/data`, which the supplied Compose stack
persists. File-path overrides include `DATA_FILE`, `USERS_FILE`,
`SETTINGS_FILE`, `METADATA_SOURCES_FILE`, `CUSTOM_PROMOTIONS_FILE`,
`NUVIO_COLLECTIONS_FILE`, `PLAYBACK_CANDIDATES_FILE`, and the provider
denylist files. Most deployments should not change them.

Other advanced controls include:

- `LOGIN_MAX_FAILS`, `LOGIN_WINDOW_MS`, and `LOGIN_LOCKOUT_MS` for login rate limits.
- `RESOLVE_URL_TTL_MINUTES` for signed playback URL lifetime (default 240; minimum 5).
- `NZBDAV_HEADER_TIMEOUT_MS` for NZB DAV header probes (default 15000).
- `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` for outbound routing, including native NNTP over HTTP CONNECT.
- `RD_BLOCKED_KEYWORDS` and provider denylist TTL variables for provider-specific suppression.

See [Security](SECURITY.md) before changing proxy trust, bind addresses, or
direct Internet exposure.
