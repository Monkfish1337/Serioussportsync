# Changelog

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
