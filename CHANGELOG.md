# Changelog

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
