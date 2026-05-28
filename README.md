# 🥊 SeriousSportSync — Sports Metadata Add-on for Stremio

> A self-hosted [Stremio](https://www.stremio.com/) add-on that turns combat-sports, pro-wrestling and motorsport events into proper meta items in Discover — with optional resolve-on-play of cached debrid links from your own indexers and debrid accounts.

[![Version](https://img.shields.io/badge/version-0.22.1-blue.svg)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Stremio Add-on](https://img.shields.io/badge/Stremio-Add--on-7b5bf5.svg)](https://www.stremio.com/)

---

## ⚠️ Disclaimer

> This project provides **event metadata** and **resolves links from third-party services that the operator chooses to configure**. It is published strictly for **educational and personal-use** purposes.
>
> SeriousSportSync **hosts no content**, ships **no indexers or keys**, and has **no affiliation** with any sport, league, broadcaster, indexer, debrid service, or other organisation mentioned in this repository. The user/operator brings their own Prowlarr, Zilean, optional HTML-indexer module, and debrid accounts, and is solely responsible for ensuring their use complies with the terms of those services and the laws of their jurisdiction.

---

## ✨ Why this exists

Debrid services usually have major sports events cached, but Stremio's stock catalogs don't list them and popular stream add-ons only accept IMDB/TMDB IDs — which sports events don't have. SeriousSportSync fills that gap:

- 🏷️ **Exposes events as proper Stremio meta items** with catalogs, posters, dates, descriptions.
- 🔎 **Generates smart per-event search aliases** (`UFC 300`, `UFC 300 Pereira vs Hill`, date variants for SNME / ONE FF / F1 sessions, etc.) so name-matching indexers actually find scene releases.
- 🎯 **Resolves on play, never on search** — stream rows are advertised optimistically without touching any debrid; the add + unrestrict happens only when you click play. A search can never pollute your debrid account, and a single provider outage can't stall results from the others.
- 🛡️ **Real-Debrid 451 defence** — automatic keyword pre-filter plus a self-learning denylist for hashes RD has flagged as `infringing_file`.

---

## 🏆 What's covered

| Promotion | Source | Notes |
|-----------|--------|-------|
| 🥋 **UFC** | TheSportsDB | PPVs, Fight Nights, UFC on ABC/ESPN — PPV vs Fight Night number disambiguation |
| 🥊 **ONE Championship** | watch.onefc.com | Numbered events, Fight Night, Friday Fights |
| 🎤 **WWE** | TheSportsDB | PLEs + named NXT events, edition-number aware, date-aware for Saturday Night's Main Event |
| 🤼 **AEW** | TheSportsDB | PPVs + Zero Hour pre-shows |
| 🏎️ **Formula 1** | TheSportsDB | Per-session items per Grand Prix weekend (Practice, Qualifying, Sprint, Sprint Qualifying, Race), with session-precise stream matching |

Adding another promotion is a single self-contained entry in `lib/promotions.js` — see [Adding a promotion](#-adding-a-promotion).

---

## 🔌 How it talks to your stack

```
                            ┌─────────────────────────────────┐ ──search──► Prowlarr
   Stremio  ──catalog/meta──►         SeriousSportSync         │ ──search──► Zilean
  (any client)               │ metadata · cache · web UI · ... │ ──search──► HTML direct indexer (optional drop-in)
                ◄──rows──    │ proactive warmer · /resolve     │
                             └─────────────────────────────────┘
                                          │  click play  →  add + unrestrict
                                          ▼
                            Real-Debrid · TorBox · Premiumize  (per-user keys)
```

**Bring your own indexer, bring your own debrid.** Point the add-on at any combination of Prowlarr, Zilean, and/or a drop-in HTML indexer module; plug in any combination of Real-Debrid / TorBox / Premiumize keys per user. Metadata works with zero indexers configured; streams need at least one source **and** at least one debrid key.

---

## 🚀 Quick start (Docker)

```bash
git clone https://github.com/<your-user>/serioussportsync.git
cd serioussportsync
cp .env.example .env
# Minimum: set SESSION_SECRET (openssl rand -hex 32) and ADMIN_USER.
docker compose up -d --build
```

The container listens on `:7000`. First-run setup:

1. 🔑 Open `http://<your-server>:7000/` — you'll get a **login / first-run signup** page. Create an account; if its username matches `ADMIN_USER`, it's auto-promoted to admin.
2. 🛠️ Go to **Admin → Indexer sources** and enter your **Prowlarr** URL + API key and/or your **Zilean** URL. (You can also set these via env; the GUI overrides env and applies live, no restart.)
3. 🧩 (Optional) Drop a custom HTML-scraping module at `lib/sources/extra.js` (or `lib/sources/local.js`) exporting `multiSearch(queries, opts)` — it's loaded automatically alongside Prowlarr + Zilean. Gitignored, never committed.
4. 🔐 On your **account page**, paste your debrid key(s) — **Real-Debrid**, **TorBox**, and/or **Premiumize**. Each user manages their own.
5. ✅ Copy your personal **install URL** from the account page and add it in Stremio: **Add-ons → paste the URL → Install**.

---

## ⚙️ Configuration

Everything is env-driven with sensible defaults (see [`.env.example`](./.env.example) for the full annotated list). Indexer endpoints can also be set in the admin GUI, which overrides env.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SESSION_SECRET` | _(required in prod)_ | Signs login cookies — set a long random value (`openssl rand -hex 32`) |
| `ADMIN_USER` | — | Username auto-promoted to admin on first signup |
| `PUBLIC_URL` | _(auto)_ | Public origin for install URLs (honours `X-Forwarded-*`) |
| `ADDON_TYPE` | `movie` | Stremio item type (`tv`/`series` for some clients) |
| `PROWLARR_URL` / `PROWLARR_API_KEY` | — | Prowlarr source (or set in GUI) |
| `ZILEAN_URL` | — | Zilean DMM-hashlist source (or set in GUI) |
| `TSDB_API_KEY` | `3` | TheSportsDB key (`3` = free; Patreon key = higher limits) |
| `EVENT_WINDOW_DAYS_BACK` / `_AHEAD` | `30` / `90` | Metadata sliding window |
| `REFRESH_INTERVAL_HOURS` | `6` | Metadata refresh cadence (0 = off) |
| `STREAM_CACHE_TTL_HOURS` | `6` | Candidate-cache freshness |
| `STREAM_CACHE_REFRESH` / `_HOURS` | `on` / `3` | Proactive candidate warmer |
| `RD_BLOCKED_KEYWORDS` | `AMZN,NF,CR,YTS,RARBG,WEBRip` | Skip RD row when candidate title contains a known-blocked tag — see [Real-Debrid 451 filter](#-real-debrid-451-filter) |
| `RD_DENYLIST_TTL_DAYS` | `30` | How long a 451'd hash stays out of RD rows |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | — | Route public indexer traffic via a VPN (keep internal services in `NO_PROXY`) |

🔐 Debrid keys are **never** env vars — they're per-user, entered on each user's own account page. Admins can rotate tokens but cannot see install URLs or debrid keys.

---

## 🛡️ Real-Debrid 451 filter

Since ~May 2026, Real-Debrid has been returning **HTTP 451 ("infringing_file")** for cached torrents whose filenames contain release tags like `AMZN`, `NF`, `CR`, `YTS`, `RARBG`, `WEBRip`, `WEB-DL`. It's filename-keyword filtering (not per-hash DMCA), surfaces at both `addMagnet` and `unrestrict/link`, and affects every RD-fronting stream add-on in the ecosystem.

SeriousSportSync defends in **two layers**:

1. 🚦 **Pre-filter at row-build** — `RD_BLOCKED_KEYWORDS` (default `AMZN,NF,CR,YTS,RARBG,WEBRip`) skips the RD row for any candidate whose title matches. Free, no RD calls. `WEB-DL` deliberately omitted — too common in sports rips; the denylist below catches the actual blocks instead.
2. 🧠 **Persistent 451 denylist** — when RD returns 451 at resolve time, the hash is recorded to `data/rd-denylist.json` (30-day TTL). Future stream rows skip RD for that hash for every user on the instance. Self-healing.

Other providers (TorBox, Premiumize) are unaffected and continue to show rows for the same candidates.

---

## 🏗️ Architecture

```
.
├── server.js                 HTTP entry point + scheduled refresh & warmer
├── addon.js                  Express routes (manifest/catalog/meta/stream/resolve + login/account/admin GUI)
├── config.js                 env-driven config (defaults)
├── lib/
│   ├── promotions.js         📂 PROMOTION REGISTRY — add new leagues here
│   ├── manifest.js           Stremio manifest (catalogs + version derive automatically)
│   ├── catalog.js            catalog handler (per-promotion filter/sort)
│   ├── meta.js               meta detail handler
│   ├── transform.js          normalize raw events → Stremio meta shape
│   ├── streams.js            source search → relevance filter → optimistic row build → /resolve URL
│   ├── streamcache.js        persistent candidate cache (data/stream-cache.json)
│   ├── rd-denylist.js        persistent RD 451 denylist (data/rd-denylist.json)
│   ├── settings.js           GUI-set runtime settings (indexer endpoints)
│   ├── users.js              multi-user accounts, invites, per-user config
│   ├── sessions.js           signed session cookies
│   ├── store.js              metadata JSON store (data/events.json)
│   └── sources/
│       ├── thesportsdb.js    metadata client
│       ├── onefc.js          watch.onefc.com metadata client
│       ├── wikipedia.js      enrichment (descriptions / posters)
│       ├── prowlarr.js       Prowlarr search + hash hydration
│       ├── zilean.js         Zilean DMM-hashlist search
│       ├── extra.js          (optional, gitignored) drop-in HTML indexer client
│       ├── realdebrid.js     Real-Debrid client (records 451s to rd-denylist)
│       ├── torbox.js         TorBox client (rate-limit aware, capped backoff)
│       └── premiumize.js     Premiumize client
├── scripts/
│   ├── refresh.js            pull events from each promotion's source
│   └── refresh-streams.js    proactive candidate-cache warmer
├── public/                   branded fallback artwork
└── docker-compose.yml
```

**Resolve-on-play flow:** `/stream` advertises one row per provider per top candidate, each row's URL pointing at `/u/<userId>/<token>/resolve/<provider>/<eventId>/<infoHash>`. Stremio's "play" click hits that endpoint; the addon then calls that provider's `resolveCached` (RD `addMagnet+select+unrestrict`, TB `checkcached+createtorrent+requestdl`, or PM `directdl`) and 302-redirects to the playable URL. The debrid is touched only on a real play.

**Background timing at a glance:**

- ⏱️ Metadata refresh: **every 6 h** (`REFRESH_INTERVAL_HOURS`)
- 📦 Candidate-cache TTL: **6 h** (empty entries **30 min**)
- 🔥 Candidate warmer: **every 3 h**, window –90 days to +1 day
- 🚫 RD denylist TTL: **30 days**

---

## 🧩 Adding a promotion

Append an entry to `all` in `lib/promotions.js`. Each promotion is fully self-contained:

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
  genres(ev)        { return ['Sports', 'MMA', 'Bellator']; },
}
```

`manifest.js`, `catalog.js`, `streams.js`, and the refresh scripts all consume the registry — no other file needs editing. Restart and the new catalogs appear in Stremio's Discover.

---

## 🔧 Manual operations

```bash
# Force a metadata refresh now
docker compose exec serioussportsync npm run refresh

# Warm the stream-candidate cache now (or use Admin → "Warm stream cache now")
docker compose exec serioussportsync npm run refresh-streams

# Health probe
curl http://localhost:7000/health

# Debug a stream resolve (shows rejection reasons) — needs a user's token
curl "http://localhost:7000/u/<userId>/<token>/stream/movie/ufc:NNNNN.json?debug=1" | jq

# Inspect the RD 451 denylist
cat data/rd-denylist.json
```

---

## 🆘 Troubleshooting

- 🕓 **Catalog empty after install** — the first refresh runs in the background on boot if the cache is empty (~1–3 min). Watch `docker compose logs -f serioussportsync`.
- 🚫 **No streams** — confirm a source is set (Admin → Indexer sources) and a debrid key is on your account. Use the `?debug=1` endpoint to see rejection counts.
- 🔄 **Version not updating in Stremio** — clients cache the manifest; remove and re-add the add-on to pick up a new version.
- ⏱️ **TheSportsDB 429s** — the refresh paces calls and retries; a Patreon key raises the limit.
- 🔴 **Lots of dead RD rows** — see [Real-Debrid 451 filter](#-real-debrid-451-filter); the keyword pre-filter and 451 denylist together should cull them within a few search cycles. If your set of dead rows shares a tag that isn't already blocked, add it to `RD_BLOCKED_KEYWORDS`.
- 🐛 **Stale candidate cache** — `data/stream-cache.json` is the persistent indexer-result cache; deleting it forces a full re-search on the next request. The proactive warmer will rebuild it in the background.

---

## 🛡️ Responsible use

This add-on is provided as a tool for **personal, educational use** with content you are entitled to access. It hosts no media. It ships no indexers, no debrid credentials, and no preconfigured sources. Every link returned originates from a source the operator has independently chosen to wire up.

- ✅ Use it to organise legitimate metadata and resolve content you are entitled to access via debrid services you legitimately subscribe to.
- ❌ Don't use it to facilitate copyright infringement.

You are solely responsible for ensuring your configuration and use comply with the terms of every third-party service involved and the laws of your jurisdiction. Contributors and the project itself accept no liability for misuse.

---

## 🙏 Acknowledgements

Built on the shoulders of the open ecosystem:

- [TheSportsDB](https://www.thesportsdb.com/) — event metadata
- [Prowlarr](https://github.com/Prowlarr/Prowlarr) — indexer aggregation
- [Zilean](https://github.com/iPromKnight/zilean) — DMM hashlist index
- [Stremio Add-on SDK](https://github.com/Stremio/stremio-addon-sdk) — protocol reference
- Inspiration from [MediaFusion](https://github.com/mhdzumair/MediaFusion), [AIOStreams](https://github.com/Viren070/AIOStreams), Torrentio, and Comet — pioneers of self-hosted, multi-debrid Stremio tooling.

---

## 📄 License

MIT — see [LICENSE](./LICENSE). The MIT licence is permissive but it is **not** a defence against operating the software in a way that violates the terms of the services you connect, or the laws of your jurisdiction. See [Responsible use](#%EF%B8%8F-responsible-use).
