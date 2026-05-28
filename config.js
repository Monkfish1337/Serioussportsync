// Configuration. All values are env-driven so the same image runs in dev
// and prod with no code changes.

function num(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// TSDB_SEASONS handling: 'auto' (or unset/empty) -> derived from the event
// window at runtime so we only hit TSDB for years that actually overlap
// the cache. Explicit comma list (e.g. "2024,2025,2026") forces those.
const seasonsEnv = (process.env.TSDB_SEASONS || 'auto').trim();
const explicitSeasons = (seasonsEnv === '' || seasonsEnv.toLowerCase() === 'auto')
  ? null
  : seasonsEnv.split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  port: parseInt(process.env.PORT, 10) || 7000,
  host: process.env.HOST || '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL || '',

  addonType: process.env.ADDON_TYPE || 'movie',

  addonId: 'community.serioussportsync',
  addonName: 'SeriousSportSync',
  addonDescription:
    'Self-hosted sports event metadata for Stremio with built-in multi-debrid stream resolution (Real-Debrid, TorBox, Premiumize). Covers UFC, ONE Championship, WWE, AEW, and Formula 1.',

  idPrefix: 'ufc',

  logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/92/UFC_Logo.svg/1280px-UFC_Logo.svg.png',
  background: 'https://upload.wikimedia.org/wikipedia/commons/7/7a/UFC-Octagon-USMCPhoto.jpg',

  tsdb: {
    apiKey: process.env.TSDB_API_KEY || '3',
    leagueId: '4443',
    requestDelayMs: 3000,
    // null = derive from event window at refresh time. Set TSDB_SEASONS to a
    // comma list to force specific years.
    seasons: explicitSeasons,
    maxRoundsPerSeason: 250,
    emptyRoundStopAfter: 5,
  },

  includeContenderSeries: false,
  dataFile: process.env.DATA_FILE || './data/events.json',

  // Sliding window of events kept in cache. Asymmetric so users can see
  // multiple upcoming events (promotions like ONE list 6+ months ahead)
  // without bloating the cache with ancient events that have no streams.
  eventWindowDaysBack:  num(process.env.EVENT_WINDOW_DAYS_BACK,  num(process.env.EVENT_WINDOW_DAYS, 30)),
  eventWindowDaysAhead: num(process.env.EVENT_WINDOW_DAYS_AHEAD, num(process.env.EVENT_WINDOW_DAYS, 90)),

  refreshIntervalHours: parseFloat(process.env.REFRESH_INTERVAL_HOURS || '6'),
  refreshOnEmptyCache: (process.env.REFRESH_ON_EMPTY_CACHE || 'true') !== 'false',

  prowlarr: {
    url: process.env.PROWLARR_URL || '',
    apiKey: process.env.PROWLARR_API_KEY || '',
  },
  // Zilean — self-hosted DMM hashlist index. When set, queried as an extra
  // candidate source alongside Prowlarr. Reach it directly (NOT via the VPN
  // proxy): e.g. http://zilean:8181 on the same Docker network, or
  // http://<host>:8181 if cross-network.
  zilean: {
    url: process.env.ZILEAN_URL || '',
  },
  // Debrid providers — any combination of these can be configured.
  // streams.js queries each configured provider in series for every Prowlarr
  // candidate and returns one stream per provider per cache hit.
  // Legacy single-tenant env vars (REAL_DEBRID_API_TOKEN / TORBOX_API_TOKEN /
  // PREMIUMIZE_API_KEY / ACCESS_TOKENS) were removed in 0.14.0. All debrid
  // credentials now come from per-user /account settings. These struct keys
  // remain (as empty strings) so legacy references in lib/sources/*.js stay
  // safe at the call site without needing further edits.
  realDebrid: { token: '' },
  torbox: { token: '' },
  premiumize: { apiKey: '' },

  accessTokens: [],

  admin: {
    user: process.env.ADMIN_USER || '',
    password: process.env.ADMIN_PASSWORD || '',
  },

  // Multi-user accounts (Phase 2)
  usersFile: process.env.USERS_FILE || './data/users.json',
  sessionSecret: process.env.SESSION_SECRET || '',

  // When zero candidates are cached on any debrid, automatically queue the
  // top candidate on each provider the user has opted into (per-account
  // checkboxes). Opt-in: uses debrid storage quota.
  autoCacheOnMiss: (process.env.AUTO_CACHE_ON_MISS || '').toLowerCase() === 'on',

  // Persistent stream-candidate cache (0.16.0). The merged candidate
  // candidate list per event is cached to disk so repeat/concurrent stream
  // requests skip the live indexer search. Resolved debrid streams are NOT
  // stored here (they're per-user, in-memory). A background warmer
  // (scripts/refresh-streams.js) repopulates it on a timer.
  streamCache: {
    file: process.env.STREAM_CACHE_FILE || './data/stream-cache.json',
    // How long a cached candidate list stays usable. 0 = never expire.
    ttlHours: parseFloat(process.env.STREAM_CACHE_TTL_HOURS || '6'),
    // Proactive warmer: 'off' disables the timer (cache still works on demand).
    refresh: (process.env.STREAM_CACHE_REFRESH || 'on').toLowerCase() !== 'off',
    refreshHours: parseFloat(process.env.STREAM_CACHE_REFRESH_HOURS || '3'),
    // Which events the warmer walks, relative to today. Stream warming is
    // backward-looking: torrents only exist after an event airs, so there's
    // no point pre-searching far-future events. Default +1 covers today and
    // tomorrow; metadata's separate +180 window still lists upcoming events
    // in the catalog.
    windowDaysBack:  num(process.env.STREAM_CACHE_WINDOW_DAYS_BACK,  90),
    windowDaysAhead: num(process.env.STREAM_CACHE_WINDOW_DAYS_AHEAD, 1),
    // Empty candidate lists (event aired but nothing seeded yet, or no content
    // at all) get a much shorter TTL than the 6h above, so a recently-aired
    // event is re-checked soon instead of serving an empty result all day.
    emptyTtlMinutes: parseFloat(process.env.STREAM_CACHE_EMPTY_TTL_MINUTES || '30'),
  },

  // Real-Debrid keyword + 451 denylist (0.22.1). RD started keyword-filtering
  // cached torrents in May 2026 (HTTP 451 / infringing_file). Two-layer defence:
  //   (1) blockedKeywords — skip the RD row at /stream time for any candidate
  //       whose title contains a known-blocked tag. Free, no RD calls. Default
  //       list omits WEB-DL on purpose (too common in sports rips, denylist
  //       backstops it). Override with RD_BLOCKED_KEYWORDS=tag1,tag2,...
  //   (2) persistent denylist — when RD returns 451 at resolve time, record
  //       the hash to data/rd-denylist.json; future stream rows skip RD for
  //       that hash for `ttlDays`. Catches per-hash blocks + keywords we
  //       haven't pre-filtered. See lib/rd-denylist.js.
  rdDenylist: {
    file: process.env.RD_DENYLIST_FILE || './data/rd-denylist.json',
    ttlDays: parseFloat(process.env.RD_DENYLIST_TTL_DAYS || '30'),
    blockedKeywords: (process.env.RD_BLOCKED_KEYWORDS || 'AMZN,NF,CR,YTS,RARBG,WEBRip')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },
};