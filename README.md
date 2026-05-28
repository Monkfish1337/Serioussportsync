# SeriousSportSync

A self-hosted [Stremio](https://www.stremio.com/) addon for combat-sports & pro-wrestling events. It adds searchable **metadata catalogs** (UFC, ONE Championship, WWE, AEW, Formula 1) **and** resolves **cached debrid streams** for them — so events that mainstream addons can't surface (PPVs, Fight Nights, regional cards) become first-class items in Stremio's Discover.

It's a "bring your own indexer" addon, like MediaFusion: you point it at **your own** Prowlarr, Zilean, and/or a drop-in HTML indexer client, plug in **your own** debrid keys, and it does the matching, caching, and stream resolution.

```
                            ┌─────────────────────────────────┐ ──search──► Prowlarr
   Stremio  ──catalog/meta──►         SeriousSportSync         │ ──search──► Zilean
  (any client)               │ metadata · cache · web UI · ... │ ──search──► HTML direct indexer (optional)
                ◄──rows──    │ proactive warmer · /resolve     │
                             └─────────────────────────────────┘
                                          │  click play  →  add + unrestrict
                                          ▼
                            Real-Debrid · TorBox · Premiumize  (per-user keys)
```

**Resolve-on-play (0.22.0+):** stream rows are advertised optimistically without touching any debrid. The debrid add + unrestrict happens only when you click play — so a search can never pollute your debrid account, and a single provider outage can't stall results from the others.

## Why it exists

Debrid services usually have these events cached, but Stremio's stock catalogs don't list them, and popular stream addons only accept IMDB/TMDB IDs — which sports events don't have. SeriousSportSync:

1. Exposes events as proper Stremio meta items (catalogs, posters, dates, cards).
2. Builds multiple search aliases per event (`UFC 300`, `UFC 300 Pereira vs Hill`, date-based variants for dated shows, etc.) so name-matching indexers find scene releases.
3. Resolves streams itself: searches your indexers, advertises rows that point back at the addon, and only adds + unrestricts on the chosen debrid when you press play — with a persistent candidate cache and a background warmer so the search side is instant.

## What's covered

| Promotion | Source | Notes |
|-----------|--------|-------|
| **UFC** | TheSportsDB | PPVs, Fight Nights, UFC on ABC/ESPN |
| **ONE Championship** | watch.onefc.com | Numbered, Fight Night, Friday Fights |
| **WWE** | TheSportsDB | PLEs + named NXT events (date-aware for Saturday Night's Main Event) |
| **AEW** | TheSportsDB | PPVs + Zero Hour pre-shows |
| **Formula 1** | TheSportsDB | Per-session items for each Grand Prix weekend (Practice, Qualifying, Sprint, Sprint Qualifying, Race), with session-precise stream matching |

Adding another promotion is a single self-contained entry in `lib/promotions.js` — see [Adding a promotion](#adding-a-promotion).

## Quick start (Docker)

```bash
git clone https://github.com/<your-user>/serioussportsync.git
cd serioussportsync
cp .env.example .env
# Minimum: set SESSION_SECRET (openssl rand -hex 32) and ADMIN_USER.
docker compose up -d --build
```

The container listens on `:7000`. First run:

1. Open `http://<your-server>:7000/` — you'll get a **login / first-run signup** page. Create an account; if its username matches `ADMIN_USER`, it's promoted to admin.
2. Go to **Admin → Indexer sources** and enter your **Prowlarr** URL + API key and/or your **Zilean** URL. (You can also set these via env; the GUI overrides env and applies live, no restart.) For any custom HTML scraper you want to plug in, drop a module at `lib/sources/extra.js` (or `lib/sources/local.js`) exporting `multiSearch(queries, opts)` — it's loaded automatically alongside Prowlarr + Zilean.
3. On your **account page**, paste your debrid key(s) — **Real-Debrid**, **TorBox**, and/or **Premiumize**. Each user manages their own.
4. Copy your personal **install URL** and add it in Stremio: **Addons → paste the URL**.

Metadata works with zero indexers configured; streams need at least one source **and** at least one debrid key.

## Configuration

Everything is env-driven with sensible defaults (see `.env.example` for the full annotated list). Indexer endpoints can also be set in the admin GUI, which overrides env.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SESSION_SECRET` | _(derived)_ | Signs login cookies — set a long random value in production |
| `ADMIN_USER` | — | Username auto-promoted to admin on signup |
| `PUBLIC_URL` | _(auto)_ | Public origin for install URLs (honours `X-Forwarded-*`) |
| `ADDON_TYPE` | `movie` | Stremio item type (`tv`/`series` for some clients) |
| `PROWLARR_URL` / `PROWLARR_API_KEY` | — | Prowlarr source (or set in GUI) |
| `ZILEAN_URL` | — | Zilean DMM-hashlist source (or set in GUI) |
| `TSDB_API_KEY` | `3` | TheSportsDB key (`3` = free; Patreon key = higher limits) |
| `EVENT_WINDOW_DAYS_BACK` / `_AHEAD` | `30` / `90` | Metadata window |
| `REFRESH_INTERVAL_HOURS` | `6` | Metadata refresh cadence (0 = off) |
| `STREAM_CACHE_TTL_HOURS` | `6` | Candidate-cache freshness |
| `STREAM_CACHE_REFRESH` / `_HOURS` | `on` / `3` | Proactive warmer (pre-fills the cache) |
| `RD_BLOCKED_KEYWORDS` | `AMZN,NF,CR,YTS,RARBG,WEBRip` | Skip the RD row for any candidate whose title contains one of these tags (see [Real-Debrid 451 filter](#real-debrid-451-filter)) |
| `RD_DENYLIST_TTL_DAYS` | `30` | How long an RD-451'd hash is excluded from future RD rows |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | — | Route public indexer traffic via a VPN (keep internal services in `NO_PROXY`) |

Debrid keys are **not** env vars — they're per-user, entered in the account page.

## Architecture

```
.
├── server.js               HTTP entry point + scheduled refresh & warmer
├── addon.js                Express routes (manifest/catalog/meta/stream + login/account/admin GUI)
├── config.js               env-driven config (defaults)
├── lib/
│   ├── promotions.js       PROMOTION REGISTRY — add new promotions here
│   ├── manifest.js         Stremio manifest (catalogs + version derive automatically)
│   ├── catalog.js          catalog handler (per-promotion filter/sort)
│   ├── meta.js             meta detail handler
│   ├── transform.js        normalize raw events → Stremio meta shape
│   ├── streams.js          source search → relevance filter → optimistic row build → /resolve URL
│   ├── streamcache.js      persistent candidate cache (data/stream-cache.json)
│   ├── rd-denylist.js      persistent RD 451 / infringing_file denylist (data/rd-denylist.json)
│   ├── settings.js         GUI-set runtime settings (indexer endpoints)
│   ├── users.js            multi-user accounts, invites, per-user config
│   ├── sessions.js         signed session cookies
│   ├── store.js            metadata JSON store (data/events.json)
│   └── sources/
│       ├── thesportsdb.js  metadata client
│       ├── prowlarr.js     Prowlarr search + hash hydration
│       ├── zilean.js       Zilean DMM-hashlist search
│       ├── extra.js        (optional, gitignored) drop-in HTML indexer client
│       ├── realdebrid.js   Real-Debrid client
│       ├── torbox.js       TorBox client (rate-limit aware)
│       └── premiumize.js   Premiumize client
├── scripts/
│   ├── refresh.js          pull events from each promotion's source
│   └── refresh-streams.js  proactive candidate-cache warmer
├── public/                 branded fallback artwork
└── docker-compose.yml
```

## Adding a promotion

Append an entry to `all` in `lib/promotions.js`. Each promotion is self-contained:

```js
{
  id: 'bellator',
  name: 'Bellator MMA',
  idPrefix: 'bellator',
  enabled: true,
  source: { type: 'thesportsdb', leagueId: 'XXXX' },
  posterShape: 'landscape',
  classify(name)    { /* → kind */ },
  buildAliases(name){ /* search aliases */ },
  isRelevantStreamTitle(title, event) { /* gate candidates */ },
  catalogs: [
    { id: 'bellator-recent',   name: 'Bellator Recent',   filter, sort },
    { id: 'bellator-upcoming', name: 'Bellator Upcoming', filter, sort },
  ],
  includeEvent(ev)  { return true; },
  genres(ev)        { return ['Sports','MMA','Bellator']; },
}
```

`manifest.js`, `catalog.js`, `streams.js`, and the refresh scripts all consume the registry — no other file needs editing. Restart and the new catalogs appear in Discover.

## Manual operations

```bash
# Force a metadata refresh now
docker compose exec serioussportsync npm run refresh

# Warm the stream-candidate cache now (or use Admin → "Warm stream cache now")
docker compose exec serioussportsync npm run refresh-streams

# Health
curl http://localhost:7000/health

# Debug a stream resolve (shows rejection reasons) — needs a user's token
curl "http://localhost:7000/u/<userId>/<token>/stream/movie/ufc:NNNNN.json?debug=1" | jq
```

## Troubleshooting

- **Catalog empty after install** — the first refresh runs in the background on boot if the cache is empty (~1–3 min). Watch `docker compose logs -f serioussportsync`.
- **No streams** — confirm a source is set (Admin → Indexer sources) and a debrid key is on your account. Use the `?debug=1` endpoint to see rejection counts.
- **Version not updating in Stremio** — clients cache the manifest; remove and re-add the addon to pick up a new version.
- **TheSportsDB 429s** — the refresh paces calls and retries; a Patreon key raises the limit.
- **Lots of dead RD rows** — see below.

### Real-Debrid 451 filter

Since ~May 2026, Real-Debrid has been returning HTTP 451 ("infringing_file") for cached torrents whose filenames contain release tags like `AMZN`, `NF`, `CR`, `YTS`, `RARBG`, `WEBRip`, `WEB-DL`. This is filename-keyword filtering, not per-hash DMCA, and it surfaces at both `addMagnet` and `unrestrict/link`. The addon defends in two layers:

1. **Pre-filter at row-build** — RD rows are skipped for any candidate whose title matches `RD_BLOCKED_KEYWORDS` (default `AMZN,NF,CR,YTS,RARBG,WEBRip`; deliberately omits `WEB-DL` because it's very common in legitimate sports rips). Free, no RD calls. Tunable via env when RD widens the list.
2. **Persistent 451 denylist** — when RD returns 451 at resolve time, the hash is recorded to `data/rd-denylist.json` (30-day TTL by default). Future stream rows skip RD for that hash, for every user on the instance. Self-healing — also catches blocks the keyword filter misses.

Other providers (TorBox, Premiumize) are unaffected and continue to show rows for the same candidates.

## Responsible use

This project provides metadata and resolves links from indexers and debrid services **you** configure and are responsible for. It hosts no content and ships with no indexers or keys. Comply with the terms of the services you use and the laws of your jurisdiction.

## Acknowledgements

- [TheSportsDB](https://www.thesportsdb.com/) — event metadata
- [Prowlarr](https://github.com/Prowlarr/Prowlarr) — indexer aggregation
- [Zilean](https://github.com/iPromKnight/zilean) — DMM hashlist index
- [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk) — protocol reference

## License

MIT — see [LICENSE](./LICENSE).
