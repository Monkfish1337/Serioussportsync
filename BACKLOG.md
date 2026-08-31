# Backlog

## Decouple Prowlarr from SeriousSportSync Companion

Make the companion the fast, sports-aware multi-source search service and
promote Prowlarr to an independent SeriousSportSync discovery option.

- Remove Prowlarr from the companion `/scrape` request path without breaking
  existing saved companion source configurations during migration.
- Add independent Prowlarr modes: **Background only** (recommended),
  **Interactive + background**, and **Disabled**.
- Never hold a fast companion response open while waiting for Prowlarr.
- Allow a longer asynchronous Prowlarr budget (initially 15–30 seconds) and
  store late results in Smart Availability for later requests.
- Let interactive requests immediately reuse stored Prowlarr results alongside
  fresh companion results.
- Expand companion source capability declarations, source-specific query
  controls, info-hash hydration, caching/stale refresh, language/category/seed
  filters, yield metrics, health suppression, and real-search smoke tests.

## AIOStreams external title-search integration

Deferred until AIOStreams exposes an authenticated external title-search API.

- Publish each event's promotion-generated queries as
  `meta.behaviorHints.searchTitles`.
- Add contract coverage for UFC, AEW, and unknown promotions.
- Add per-user AIOStreams connection settings to SeriousSportSync.
- Submit `type`, `titles[]`, and optional `year` to AIOStreams.
- Merge returned rows with the existing TorBox, Easynews, and Usenet
  pipelines.
- Prevent recursive requests back into SeriousSportSync.
