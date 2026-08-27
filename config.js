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
// Migrate existing Compose environments that copied the legacy public key.
// A real user/premium key is preserved verbatim.
const tsdbKeyEnv = String(process.env.TSDB_API_KEY || '123').trim();
const tsdbApiKey = tsdbKeyEnv === '3' ? '123' : tsdbKeyEnv;

module.exports = {
  port: parseInt(process.env.PORT, 10) || 7000,
  host: process.env.HOST || '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL || '',

  addonType: process.env.ADDON_TYPE || 'movie',

  addonId: 'community.serioussportsync',
  addonName: 'SeriousSportSync',
  addonDescription:
    'Self-hosted sports event metadata and calendar for Stremio/Nuvio, with optional TorBox, Usenet Ultimate, and Easynews playback pipelines.',

  idPrefix: 'ufc',

  logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/92/UFC_Logo.svg/1280px-UFC_Logo.svg.png',
  background: 'https://upload.wikimedia.org/wikipedia/commons/7/7a/UFC-Octagon-USMCPhoto.jpg',

  tsdb: {
    // TheSportsDB's current documented free v1 key. Older releases used the
    // legacy test key `3`, whose schedule endpoints have lower result caps.
    apiKey: tsdbApiKey,
    leagueId: '4443',
    requestDelayMs: 3000,
    // null = derive from event window at refresh time. Set TSDB_SEASONS to a
    // comma list to force specific years.
    seasons: explicitSeasons,
    maxRoundsPerSeason: 250,
    emptyRoundStopAfter: 5,
  },

  // 0.38.0: football-data.org parallel source for custom promotions whose
  // source.type === 'football-data'. Used to cover FIFA WC + EPL + Champions
  // League + most major football leagues where TSDB's free-tier coverage is
  // sparse. Free tier: 10 req/min, no payment. Get an API key at
  // football-data.org/client/register and set FOOTBALL_DATA_API_KEY in your
  // compose env. Empty key = football-data promotions skip refresh with a
  // clear log warning.
  footballData: {
    apiKey: process.env.FOOTBALL_DATA_API_KEY || '',
  },

  // 0.42.13 — TMDB source. For TV-style sports shows (Match of the Day, ITV
  // highlights, boxing analysis shows, etc.) where football-data / TSDB don't
  // apply. Each show is identified by its numeric TMDB TV show ID; refresh
  // fetches all episodes with air dates and treats each as an event whose
  // date drives DARKSPORT-style search title generation. Free API key at
  // https://developer.themoviedb.org.
  tmdb: {
    apiKey: process.env.TMDB_API_KEY || '',
  },

  includeContenderSeries: false,
  dataFile: process.env.DATA_FILE || './data/events.json',
  contentStudioFile: process.env.CONTENT_STUDIO_FILE || './data/content-studio.json',
  metadataSourcesFile: process.env.METADATA_SOURCES_FILE || './data/metadata-sources.json',

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
    // Hard TTL — 451 / DMCA blocks. RD doesn't reverse these quickly.
    ttlDays: parseFloat(process.env.RD_DENYLIST_TTL_DAYS || '30'),
    // Soft TTL (0.22.3) — non-451 "not cached / unresolvable" RD outcomes.
    // The hash may become cached later if another user adds it, so the entry
    // expires fast enough to give it another chance.
    softTtlHours: parseFloat(process.env.RD_SOFT_DENYLIST_HOURS || '24'),
    blockedKeywords: (process.env.RD_BLOCKED_KEYWORDS || 'AMZN,NF,CR,YTS,RARBG,WEBRip')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },
  // Per-provider failure denylists (0.23.1). Same dual-TTL model as
  // rdDenylist — see lib/provider-denylist.js. Each provider gets its own
  // file under data/ so a TB "not cached" doesn't pin RD or PM rows out.
  tbDenylist: {
    file: process.env.TB_DENYLIST_FILE || './data/tb-denylist.json',
    ttlDays: parseFloat(process.env.TB_DENYLIST_TTL_DAYS || '30'),
    softTtlHours: parseFloat(process.env.TB_SOFT_DENYLIST_HOURS || '24'),
  },
  pmDenylist: {
    file: process.env.PM_DENYLIST_FILE || './data/pm-denylist.json',
    ttlDays: parseFloat(process.env.PM_DENYLIST_TTL_DAYS || '30'),
    softTtlHours: parseFloat(process.env.PM_SOFT_DENYLIST_HOURS || '24'),
  },

  // Positive resolve cache (0.24.0). Records every successful play-time
  // resolve as (hash, provider) and surfaces them as authoritative-cached on
  positiveCache: {
    file: process.env.POSITIVE_CACHE_FILE || './data/positive-cache.json',
    ttlDays: parseFloat(process.env.POSITIVE_CACHE_TTL_DAYS || '7'),
  },

  // Optional admin power-tool credentials. These are used only for explicit
  // per-event verify/warm actions initiated by an administrator.
  adminPowerTool: {
    // WARMER_* fallbacks preserve existing deployments after removal of the
    // global warmer; both values are used only on explicit admin actions.
    tbToken:  process.env.ADMIN_TB_TOKEN || process.env.WARMER_TB_TOKEN || '',
    pmApiKey: process.env.ADMIN_PM_KEY   || process.env.WARMER_PM_KEY   || '',
  },
};
