#!/usr/bin/env node
// Multi-promotion refresh.

const tsdb = require('../lib/sources/thesportsdb');
const tsdbKnownEvents = require('../lib/tsdb-known-events');
const transform = require('../lib/transform');
const store = require('../lib/store');
const promotions = require('../lib/promotions');
const config = require('../config');
const contentStore = require('../lib/content-store');

let wiki = null;
try { wiki = require('../lib/sources/wikipedia'); } catch (e) { wiki = null; }
let onefc = null;
try { onefc = require('../lib/sources/onefc'); } catch (e) { onefc = null; }
let mlb = null;
try { mlb = require('../lib/sources/mlb'); } catch (e) { mlb = null; }
let aew = null;
try { aew = require('../lib/sources/aew'); } catch (e) { aew = null; }
let espn = null;
try { espn = require('../lib/sources/espn'); } catch (e) { espn = null; }
let releaseIngest = null;
try { releaseIngest = require('../lib/sources/release-ingest'); } catch (e) { releaseIngest = null; }
let wikiList = null;
try { wikiList = require('../lib/sources/wikipedia-list'); } catch (e) { wikiList = null; }
// 0.38.0: football-data.org parallel source for custom promotions whose
// source.type === 'football-data'. Lazy-required so installs that never use
// it don't pay the require cost on cold start.
let footballData = null;
try { footballData = require('../lib/sources/football-data'); } catch (e) { footballData = null; }
let apiFootball = null;
try { apiFootball = require('../lib/sources/api-football'); } catch (e) { apiFootball = null; }
let uefa = null;
try { uefa = require('../lib/sources/uefa'); } catch (e) { uefa = null; }
// 0.42.13: TMDB parallel source for TV-style sports shows (Match of the Day,
// ITV highlights, boxing analysis shows) where football-data / TSDB don't
// apply. Same lazy-require pattern as football-data.
let tmdb = null;
try { tmdb = require('../lib/sources/tmdb'); } catch (e) { tmdb = null; }
let jsonFeed = null;
try { jsonFeed = require('../lib/sources/json-feed'); } catch (e) { jsonFeed = null; }

// Generic asymmetric window. Promotions can override by exposing
// .eventScope(ev) which returns true for events they want kept.
function withinWindow(ev) {
  if (!ev || !ev.date) return false;
  const back = Math.max(0, config.eventWindowDaysBack | 0);
  const ahead = Math.max(0, config.eventWindowDaysAhead | 0);
  if (back === 0 && ahead === 0) return true;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const evDate = new Date(ev.date + 'T00:00:00Z');
  const diffDays = (evDate - today) / (1000 * 60 * 60 * 24);
  if (diffDays >= 0) return diffDays <= ahead;
  return -diffDays <= back;
}

// Every promotion the installation KNOWS about, enabled or not.
// promotions.byPrefix holds only the enabled ones, so it is the wrong list for
// deciding whether an event has been orphaned — see the prune in runRefresh.
function knownPromotionPrefixes() {
  return new Set(promotions.all.map((p) => p.idPrefix).filter(Boolean));
}

function isOrphanEventId(eventId, knownPrefixes) {
  const id = String(eventId || '');
  const idx = id.indexOf(':');
  if (idx <= 0) return false;
  return !knownPrefixes.has(id.slice(0, idx));
}

function inScope(ev, promotion) {
  if (promotion && promotion.metadataStartDate && (!ev || !ev.date || ev.date < promotion.metadataStartDate)) {
    return false;
  }
  if (promotion && typeof promotion.eventScope === 'function') {
    return promotion.eventScope(ev);
  }
  return withinWindow(ev);
}

function activeSeasons(promotion) {
  if (Array.isArray(config.tsdb.seasons) && config.tsdb.seasons.length > 0) {
    const floorYear = Number(String((promotion && promotion.metadataStartDate) || '').slice(0, 4));
    return floorYear
      ? config.tsdb.seasons.filter((season) => Number(String(season).slice(-4)) >= floorYear)
      : config.tsdb.seasons;
  }
  // Earliest = max(today - EVENT_WINDOW_DAYS_BACK, EVENT_WINDOW_START_DATE).
  // 0.31.1: the daysBack window alone misses everything before
  // (today - daysBack) even when EVENT_WINDOW_START_DATE is older — which
  // meant the 2025-01-01 floor never actually pulled 2025 seasons. Now
  // both bounds participate.
  const back = Math.max(0, config.eventWindowDaysBack | 0);
  const ahead = Math.max(0, config.eventWindowDaysAhead | 0);
  const today = new Date();
  let earliest = new Date(today); earliest.setDate(earliest.getDate() - back);
  // 0.31.1: same default as lib/promotions.js so the env var being unset
  // doesn't silently fall back to a daysBack-only window. Both files should
  // agree on the catalog floor.
  const windowStart = process.env.EVENT_WINDOW_START_DATE || '2025-01-01';
  if (/^\d{4}-\d{2}-\d{2}$/.test(windowStart)) {
    const startDate = new Date(windowStart + 'T00:00:00Z');
    if (startDate < earliest) earliest = startDate;
  }
  if (promotion && promotion.metadataStartDate) {
    const floor = new Date(promotion.metadataStartDate + 'T00:00:00Z');
    earliest = floor;
  }
  const latest = new Date(today); latest.setDate(latest.getDate() + ahead);
  const years = new Set();
  for (let y = earliest.getUTCFullYear(); y <= latest.getUTCFullYear(); y++) years.add(String(y));
  return Array.from(years).sort();
}

// Compute an ISO date for "this many days from today" — used as a hint
// when the source supports it (e.g. wikipedia-list eventStartIso prune).
function isoDaysFromToday(days) {
  const d = new Date(); d.setUTCHours(0,0,0,0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sourceStartDate(promotion, dateFrom) {
  return promotion && promotion.metadataStartDate || dateFrom;
}

// AEW's schedule feeds three promotions (AEW, AEW Dynamite, AEW Collision).
// Fetch the two pages once per refresh, not once per promotion.
async function fetchAewSchedule(log, sourceCache) {
  const key = 'aew:schedule';
  if (sourceCache && sourceCache.has(key)) return sourceCache.get(key);
  const events = await aew.fetchAll({ log });
  if (sourceCache) sourceCache.set(key, events);
  return events;
}

// A weekly AEW catalogue holds TSDB episodes plus AEW-schedule episodes. Once
// an episode airs TheSportsDB usually lists it too, and the schedule copy —
// cached from before, when it was the only record — would sit beside it as a
// duplicate. TSDB's wins: it carries the episode number the searches use.
function dropSupplementalDuplicates(byId, promotion) {
  const primaryDates = new Set();
  for (const ev of byId.values()) {
    if (ev.promotion === promotion.id && (!ev.source || ev.source.type !== 'aew')) primaryDates.add(ev.date);
  }
  let dropped = 0;
  for (const [id, ev] of byId) {
    if (ev.promotion === promotion.id && ev.source && ev.source.type === 'aew' && primaryDates.has(ev.date)) {
      byId.delete(id);
      dropped++;
    }
  }
  return dropped;
}

async function refreshPromotion(promotion, log, opts) {
  opts = opts || {};
  log('==> refreshing ' + promotion.id + ' (' + promotion.name + ')');
  let raw = [];

  if (promotion.source.type === 'thesportsdb') {
    const seasons = activeSeasons(promotion);
    log('  TSDB seasons: ' + seasons.join(', '));
    const knownEvents = promotion.weeklyShow ? []
      : ((promotion.source.knownEvents && promotion.source.knownEvents.length)
        ? promotion.source.knownEvents
        : tsdbKnownEvents.knownEventsFor(promotion.source.leagueId));
    const weeklySeries = String(promotion.source.leagueId) === '4563'
      ? ['Dynamite', 'Collision']
      : (String(promotion.source.leagueId) === '4444' ? ['RAW', 'SmackDown', 'NXT'] : []);
    const fetchOptions = {
      leagueId: promotion.source.leagueId,
      seasons,
      // Recurring card names for leagues whose schedule is mostly weekly TV.
      // Keyed off the league id rather than carried on the source, because a
      // source definition can come from three places — the promotion's own
      // fallback, the system metadata-source registry, or a user-created entry
      // — and only the league id is common to all three. See
      // lib/tsdb-known-events.js for why the list endpoints cannot reach these.
      knownEvents,
      weeklySeries,
      startDate: promotion.metadataStartDate,
      dateOrderedRounds: ['4444', '4563'].includes(String(promotion.source.leagueId)),
      // A preview is interactive and has a 60s deadline. Both of these are
      // one rate-limited request at a time and either can spend all of it:
      // named lookups are one per card name, and the per-round walk is one
      // per round for as long as rounds keep returning events — which for a
      // weekly-TV league like WWE is well past two minutes.
      skipNamedLookups: opts.skipNamedLookups === true,
      skipRoundWalk: opts.skipRoundWalk === true,
      deadlineMs: Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : 0,
      log,
    };
    const cacheKey = JSON.stringify({ leagueId: fetchOptions.leagueId, seasons,
      knownEvents, weeklySeries, startDate: fetchOptions.startDate,
      dateOrderedRounds: fetchOptions.dateOrderedRounds,
      skipNamedLookups: fetchOptions.skipNamedLookups, skipRoundWalk: fetchOptions.skipRoundWalk });
    if (opts.sourceCache && opts.sourceCache.has(cacheKey)) {
      raw = opts.sourceCache.get(cacheKey);
      log('  reused TSDB league results for this refresh');
    } else {
      raw = await tsdb.fetchAll(fetchOptions);
      if (opts.sourceCache) opts.sourceCache.set(cacheKey, raw);
    }
    if (promotion.aewScheduleShow && aew && !opts.skipSupplement) {
      // Future AEW episodes TheSportsDB cannot see. Best effort: a failure
      // here keeps the TSDB episodes rather than failing the promotion.
      try {
        const schedule = await fetchAewSchedule(log, opts.sourceCache);
        const episodes = aew.weeklyEpisodes(schedule, promotion.aewScheduleShow);
        log('  aew schedule: +' + episodes.length + ' ' + promotion.aewScheduleShow + ' episode(s)');
        raw = raw.concat(episodes);
      } catch (err) {
        log('  aew schedule unavailable, TSDB episodes only: ' + err.message);
      }
    }
  } else if (promotion.source.type === 'wikipedia') {
    if (!wiki) { log('  wikipedia source unavailable — skipping'); return { ok: true }; }
    raw = await wiki.fetchAll({ pattern: promotion.source.yearPagePattern, promotion, log });
  } else if (promotion.source.type === 'onefc') {
    if (!onefc) { log('  onefc source unavailable — skipping'); return { ok: true }; }
    raw = await onefc.fetchAll({ log });
  } else if (promotion.source.type === 'aew') {
    // AEW publishes its own schedule; TheSportsDB's free key cannot reach the
    // upcoming cards at all. One request, no key, no date window — the page
    // lists everything announced, which is about eighteen events.
    if (!aew) { log('  aew source unavailable — skipping'); return { ok: true }; }
    raw = await fetchAewSchedule(log, opts.sourceCache);
  } else if (promotion.source.type === 'mlb') {
    if (!mlb) { log('  mlb source unavailable — skipping'); return { ok: true }; }
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const from = new Date(today); from.setUTCDate(from.getUTCDate() - Math.max(0, config.eventWindowDaysBack | 0));
    const to = new Date(today); to.setUTCDate(to.getUTCDate() + Math.max(0, config.eventWindowDaysAhead | 0));
    raw = await mlb.fetchAll({ dateFrom: sourceStartDate(promotion, from.toISOString().slice(0, 10)), dateTo: to.toISOString().slice(0, 10), log });
  } else if (promotion.source.type === 'espn') {
    if (!espn) { log('  espn source unavailable — skipping'); return { ok: true }; }
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const from = new Date(today); from.setUTCDate(from.getUTCDate() - Math.max(0, config.eventWindowDaysBack | 0));
    const to = new Date(today); to.setUTCDate(to.getUTCDate() + Math.max(0, config.eventWindowDaysAhead | 0));
    const fetchOptions = {
      league: promotion.source.league,
      dateFrom: sourceStartDate(promotion, from.toISOString().slice(0, 10)),
      dateTo: to.toISOString().slice(0, 10),
      log,
    };
    const cacheKey = 'espn:' + fetchOptions.league + ':' + fetchOptions.dateFrom + ':' + fetchOptions.dateTo;
    if (opts.sourceCache && opts.sourceCache.has(cacheKey)) raw = opts.sourceCache.get(cacheKey);
    else {
      raw = await espn.fetchAll(fetchOptions);
      if (opts.sourceCache) opts.sourceCache.set(cacheKey, raw);
    }
  } else if (promotion.source.type === 'sport-video') {
    // Release-first ingestion. No network call: this reads SSS's own record of
    // what Sport-Video published and no fixture feed claimed.
    if (!releaseIngest) { log('  release-ingest unavailable — skipping'); return { ok: true }; }
    raw = releaseIngest.fetchAll({
      sport: promotion.source.sport,
      ownPromotionIds: new Set(promotions.all
        .filter((item) => item.source && item.source.type === 'sport-video')
        .map((item) => item.id)),
      log,
    });
  } else if (promotion.source.type === 'wikipedia-list') {
    if (!wikiList) { log('  wikipedia-list source unavailable — skipping'); return { ok: true }; }
    // Tell the parser the earliest date we care about so it skips year
    // sections that lie entirely before scope.
    let eventStartIso = null;
    if (typeof promotion.eventScope === 'function') {
      // Simple heuristic — go back 1 year to be safe; the per-event filter
      // in the loop below applies the precise window.
      eventStartIso = isoDaysFromToday(-365);
      // If the eventScope is a Jan-1-of-year style filter, use that exactly.
      const yearStart = new Date().getUTCFullYear() + '-01-01';
      eventStartIso = yearStart;
    }
    if (promotion.metadataStartDate) {
      eventStartIso = promotion.metadataStartDate;
    }
    raw = await wikiList.fetchAll({
      pageTitle: promotion.source.pageTitle,
      promotion,
      eventStartIso,
      log,
    });
  } else if (promotion.source.type === 'football-data') {
    // 0.38.0: football-data.org parallel source for custom football promotions.
    // 0.38.1: API key now sourced via settings.js (admin-saved /admin field,
    // falls back to FOOTBALL_DATA_API_KEY env var).
    if (!footballData) { log('  football-data module unavailable — skipping'); return { ok: true }; }
    const settings = require('../lib/settings');
    const fd = settings.getFootballData();
    if (!fd.apiKey) {
      log('  football-data: no API key configured (set on /admin or via FOOTBALL_DATA_API_KEY env) — skipping ' + promotion.id);
      return { ok: true };
    }
    if (promotion.source.teamId) {
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const from = new Date(today); from.setUTCDate(from.getUTCDate() - Math.max(0, config.eventWindowDaysBack | 0));
      const to = new Date(today); to.setUTCDate(to.getUTCDate() + Math.max(0, config.eventWindowDaysAhead | 0));
      const dateFrom = sourceStartDate(promotion, from.toISOString().slice(0, 10));
      const dateTo = to.toISOString().slice(0, 10);
      log('  football-data team: ' + promotion.source.teamId + ' range: ' + dateFrom + ' to ' + dateTo);
      raw = await footballData.fetchTeamMatches({
        teamId: promotion.source.teamId,
        dateFrom,
        dateTo,
        apiKey: fd.apiKey,
        log,
      });
    } else {
      const seasons = activeSeasons(promotion);
      log('  football-data competition: ' + promotion.source.competitionId + ' seasons: ' + seasons.join(', '));
      raw = await footballData.fetchAll({
        competitionId: promotion.source.competitionId,
        seasons,
        apiKey: fd.apiKey,
        log,
      });
    }
  } else if (promotion.source.type === 'api-football') {
    if (!apiFootball) throw new Error('API-Football source module is unavailable; promotion was not refreshed');
    const settings = require('../lib/settings');
    const configured = settings.getApiFootball();
    if (!configured.apiKey) {
      log('  api-football: no API key configured (set in Admin or API_FOOTBALL_API_KEY) — skipping ' + promotion.id);
      return { ok: true };
    }
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const from = new Date(today); from.setUTCDate(from.getUTCDate() - Math.max(0, config.eventWindowDaysBack | 0));
    const to = new Date(today); to.setUTCDate(to.getUTCDate() + Math.max(0, config.eventWindowDaysAhead | 0));
    const dateFrom = sourceStartDate(promotion, from.toISOString().slice(0, 10));
    const dateTo = to.toISOString().slice(0, 10);
    const seasons = apiFootball.seasonsForRange(dateFrom, dateTo);
    log('  api-football competition: ' + promotion.source.leagueId + ' seasons: ' + seasons.join(', ')
      + ' range: ' + dateFrom + ' to ' + dateTo);
    raw = await apiFootball.fetchAll({
      leagueId: promotion.source.leagueId,
      seasons,
      dateFrom,
      dateTo,
      apiKey: configured.apiKey,
      log,
    });
  } else if (promotion.source.type === 'uefa') {
    if (!uefa) throw new Error('Official UEFA source module is unavailable; promotion was not refreshed');
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const from = new Date(today); from.setUTCDate(from.getUTCDate() - Math.max(0, config.eventWindowDaysBack | 0));
    const to = new Date(today); to.setUTCDate(to.getUTCDate() + Math.max(0, config.eventWindowDaysAhead | 0));
    const dateFrom = sourceStartDate(promotion, from.toISOString().slice(0, 10));
    const dateTo = to.toISOString().slice(0, 10);
    const seasons = uefa.seasonsForRange(dateFrom, dateTo);
    log('  uefa official competition: ' + promotion.source.competitionId + ' seasons: ' + seasons.join(', ')
      + ' range: ' + dateFrom + ' to ' + dateTo + ' (no API key required)');
    raw = await uefa.fetchAll({
      competitionId: promotion.source.competitionId,
      seasons,
      dateFrom,
      dateTo,
      log,
    });
  } else if (promotion.source.type === 'tmdb') {
    // 0.42.13: TMDB TV show. Fetches all episodes with air dates. Each becomes
    // an event whose date drives DARKSPORT-style search title generation.
    if (!tmdb) throw new Error('TMDB source module is unavailable; promotion was not refreshed');
    // An admin-saved key wins over the environment variable, the same way the
    // football-data.org and API-Football keys already do. Without this the
    // Server page's new TMDB field would save a value nothing ever read.
    const tk = require('../lib/settings').getTmdb().apiKey
      || (config && config.tmdb && config.tmdb.apiKey)
      || (process.env.TMDB_API_KEY || '');
    if (!tk) {
      throw new Error('TMDB_API_KEY is not configured; promotion "' + promotion.id + '" was not refreshed');
    }
    const tvIds = Array.isArray(promotion.source.tvIds) && promotion.source.tvIds.length
      ? promotion.source.tvIds
      : [promotion.source.tvId];
    const sourceRange = typeof promotion.sourceDateRange === 'function'
      ? promotion.sourceDateRange()
      : {};
    if (promotion.metadataStartDate) {
      sourceRange.dateFrom = sourceRange.dateFrom
        ? (promotion.metadataStartDate > sourceRange.dateFrom
          ? promotion.metadataStartDate : sourceRange.dateFrom)
        : promotion.metadataStartDate;
    }
    if (sourceRange.dateFrom || sourceRange.dateTo) {
      log('  tmdb episode range: ' + (sourceRange.dateFrom || 'open') + ' to ' + (sourceRange.dateTo || 'open'));
    }
    for (const tvId of tvIds) {
      log('  tmdb tvId: ' + tvId);
      const episodes = await tmdb.fetchAll({
        tvId,
        apiKey: tk,
        log,
        dateFrom: sourceRange.dateFrom,
        dateTo: sourceRange.dateTo,
      });
      raw.push(...episodes);
    }
  } else if (promotion.source.type === 'json-feed') {
    if (!jsonFeed) throw new Error('Custom JSON/API provider module is unavailable');
    raw = await jsonFeed.fetchAll(promotion.source, { log });
  } else {
    log('  unknown source type: ' + promotion.source.type);
    return { ok: false };
  }
  log('  fetched ' + raw.length + ' raw events from ' + promotion.source.type);
  return raw;
}

function normalizeRecord(raw, promotion) {
  if (!promotion || !promotion.source) return null;
  // AEW-schedule episodes mixed into a TSDB weekly catalogue.
  if (promotion.aewScheduleShow && raw && raw.source && raw.source.type === 'aew') {
    return transform.fromWiki(raw, promotion);
  }
  if (promotion.source.type === 'thesportsdb') return transform.fromTsdb(raw, promotion);
  if (promotion.source.type === 'football-data') return transform.fromFootballData(raw, promotion);
  if (promotion.source.type === 'api-football') return transform.fromApiFootball(raw, promotion);
  if (promotion.source.type === 'uefa') return transform.fromUefa(raw, promotion);
  if (promotion.source.type === 'tmdb') return transform.fromTmdb(raw, promotion);
  if (promotion.source.type === 'wikipedia' || promotion.source.type === 'onefc'
      || promotion.source.type === 'mlb' || promotion.source.type === 'espn'
      || promotion.source.type === 'aew'
      || promotion.source.type === 'wikipedia-list'
      || promotion.source.type === 'sport-video'
      || promotion.source.type === 'json-feed') {
    return transform.fromWiki(raw, promotion);
  }
  return null;
}

async function runRefresh(options) {
  const opts = options || {};
  const log = opts.log || ((m) => console.log(m));

  // 0.41.0 — optional per-promotion refresh. When `promotionId` is set:
  //   1. Events belonging to OTHER promotions are preserved verbatim (no
  //      pruning, no source-mismatch check). We're intentionally not
  //      touching them.
  //   2. Only the target promotion's source is fetched and normalised.
  // Speeds up iteration when tweaking a single promotion's aliases/keywords/
  // templates without paying the cost of refetching every source.
  const targetPromotionId = opts.promotionId ? String(opts.promotionId).trim() : null;

  const scopeLabel = targetPromotionId ? 'promotion "' + targetPromotionId + '"' : 'all promotions';
  log('[refresh] starting refresh (' + scopeLabel + ', window: -' + config.eventWindowDaysBack + ' / +' + config.eventWindowDaysAhead + ' days)');
  const start = Date.now();

  const existing = store.loadFromDisk();
  const byId = new Map();
  let prunedExisting = 0;
  let prunedExcluded = 0;
  let prunedStaleSource = 0;
  let preservedOther = 0;
  let prunedOrphans = 0;

  // 0.90.1 — events whose promotion no longer exists.
  //
  // Deleting a promotion left its events in the store forever: getByEventId
  // returns null for them, so no prune rule below ever reached them, no
  // catalog could render them, and lib/streams.js had no promotion to build a
  // search from — which is exactly the shape a user reads as "this fixture
  // used to pull links and now pulls none".
  //
  // KNOWN, not ENABLED, is the test. byPrefix holds only enabled promotions,
  // so keying off it would destroy every event of a promotion the user merely
  // switched off, and re-fetching those spends API budget they may not have.
  const knownPrefixes = knownPromotionPrefixes();
  const isOrphan = (eventId) => isOrphanEventId(eventId, knownPrefixes);

  // Prune existing events: drop anything outside scope OR tagged with a
  // source.type that no longer matches the promotion's current source.
  //
  // Two rules:
  //   • TSDB promotions: an event without explicit source.type is kept if
  //     its sourceId is numeric (looks like a TSDB idEvent). Otherwise
  //     it's a stale slug from an old Wikipedia/onefc source — drop.
  //   • Non-TSDB promotions (onefc, wikipedia-list, wikipedia): REQUIRE an
  //     explicit source.type match. Slug-shaped IDs from different
  //     sources can collide (e.g. old `one:one-fight-night-42` from the
  //     Wikipedia year-page parser vs new `one:onefightnight42` from the
  //     onefc API) so we can't tell them apart by ID format — only the
  //     explicit tag is reliable.
  for (const ev of existing.events || []) {
    const p = promotions.getByEventId(ev.id);

    // Orphans go first, before the targeted-refresh preserve below: a targeted
    // run must not be the thing that keeps them alive forever.
    if (!p && isOrphan(ev.id)) { prunedOrphans++; continue; }

    // 0.41.0 — per-promotion refresh: keep every event that ISN'T ours,
    // untouched. No prune, no source-mismatch check. Only the target
    // promotion's events flow through the normal refresh logic below.
    if (targetPromotionId && (!p || p.id !== targetPromotionId)) {
      byId.set(ev.id, ev);
      preservedOther++;
      continue;
    }

    // A promotion filter applies to stored events too. Otherwise changing a
    // rule only stops new weekly episodes; already cached ones stay forever.
    if (p && p.id === 'wwe' && typeof p.includeEvent === 'function' && !p.includeEvent(ev, config)) {
      prunedExcluded++;
      continue;
    }

    // Apply authoritative corrections to cached records even when the source
    // fetch is delayed. The next successful fetch will replace the full row.
    if (p && typeof p.correctDate === 'function') {
      const corrected = p.correctDate(ev.name, ev.date);
      if (corrected && corrected !== ev.date) {
        ev.date = corrected;
        ev.dateLocal = corrected;
        ev.time = null;
        ev.timestamp = null;
      }
    }
    if (p && p.id === 'wwe' && !ev.hasSourceImage && p.defaults && p.defaults.poster) {
      ev.poster = p.defaults.poster;
      ev.thumb = p.defaults.poster;
      ev.fanart = p.defaults.fanart || p.defaults.poster;
      ev.banner = p.defaults.fanart || p.defaults.poster;
    }

    const expectedSourceType = p && p.source && p.source.type;
    const cachedSourceType = ev.source && ev.source.type;

    if (expectedSourceType) {
      let mismatch = false;
      if (expectedSourceType === 'thesportsdb') {
        if (cachedSourceType && cachedSourceType !== 'thesportsdb'
            && !(p.aewScheduleShow && cachedSourceType === 'aew')) mismatch = true;
        if (!cachedSourceType) {
          const sourcePart = ev.id.slice(ev.id.indexOf(':') + 1);
          if (!/^\d+$/.test(sourcePart)) mismatch = true; // slug ID under a TSDB promotion = stale
        }
      } else {
        // Non-TSDB promotion: only keep if explicitly tagged with this exact source.
        if (cachedSourceType !== expectedSourceType) mismatch = true;
      }
      if (mismatch) { prunedStaleSource++; continue; }
    }

    if (inScope(ev, p)) byId.set(ev.id, ev);
    else prunedExisting++;
  }
  if (prunedOrphans > 0) log('[refresh] pruned ' + prunedOrphans + ' events whose promotion no longer exists');
  if (prunedExcluded > 0) log('[refresh] pruned ' + prunedExcluded + ' events excluded by promotion filters');
  if (prunedStaleSource > 0) log('[refresh] pruned ' + prunedStaleSource + ' events from previous source(s)');
  if (prunedExisting > 0) log('[refresh] pruned ' + prunedExisting + ' existing events outside scope');
  if (preservedOther > 0) log('[refresh] preserved ' + preservedOther + ' events from other promotions');

  // 0.41.0 — filter the fetch loop to the target promotion (if any). Missing
  // ID or disabled promotion is a soft-fail: we bail early rather than write
  // out a store that could clobber other promotions' data with nothing.
  const selectedTeamIds = new Set(require('../lib/users').listUsers()
    .flatMap((user) => Array.isArray(user.config && user.config.teamPromotions)
      ? user.config.teamPromotions : []));
  let toFetch = promotions.enabled.filter((p) => !p.autoTeam || selectedTeamIds.has(p.id));
  if (targetPromotionId) {
    toFetch = promotions.enabled.filter((p) => p.id === targetPromotionId);
    if (toFetch.length === 0) {
      log('[refresh] no enabled promotion with id "' + targetPromotionId + '" — nothing to do');
      return { ok: false, error: 'promotion "' + targetPromotionId + '" not found or not enabled', total: existing.events ? existing.events.length : 0 };
    }
  }

  let totalAdded = 0, totalUpdated = 0, totalSkipped = 0;
  const failures = [];
  // Per-promotion outcome for the Diagnosis page (lib/refresh-status.js). A
  // promotion that returns without events has logged why — a missing key, an
  // unavailable module — and that line is the reason it is recorded with.
  const outcomes = [];
  const sourceCache = opts.sourceCache || new Map();
  for (const p of toFetch) {
    let raw;
    const said = [];
    const promotionLog = (message) => { said.push(String(message)); log(message); };
    try {
      raw = await refreshPromotion(p, promotionLog, { sourceCache });
    } catch (err) {
      log('  ' + p.id + ' FATAL: ' + err.message);
      failures.push({ promotion: p.id, error: err.message });
      outcomes.push({ id: p.id, status: 'failed', reason: String(err.message).slice(0, 300) });
      continue;
    }
    if (!Array.isArray(raw)) {
      const why = said.slice().reverse().find((line) => /skipping|unavailable|not configured|no api key|unknown source/i.test(line))
        || said[said.length - 1] || 'returned no events';
      outcomes.push({ id: p.id, status: 'skipped', reason: why.trim().slice(0, 300) });
      continue;
    }

    const promotionEvents = [];
    let added = 0, updated = 0, skipped = 0;
    for (const r of raw) {
      let norm;
      norm = normalizeRecord(r, p);
      if (!norm) continue;
      // Promotion-level filter (e.g. drop WWE weekly TV, UFC Contender Series).
      if (typeof p.includeEvent === 'function' && !p.includeEvent(norm, config)) {
        skipped++; continue;
      }
      if (!inScope(norm, p)) { skipped++; continue; }
      // The duplicate scan and the promotion-filter note above both used to
      // write to a review inbox. Nothing ever read it — `updateInbox` had zero
      // callers and no page listed the items — so the scan was an O(n) walk of
      // every stored event, per candidate, per refresh, producing records
      // nobody could see. Removed rather than surfaced: see the note in
      // lib/content-store.js.
      if (byId.has(norm.id)) updated++;
      else added++;
      byId.set(norm.id, norm);
      promotionEvents.push(norm);
    }
    log('  ' + p.id + ': +' + added + ' new, ~' + updated + ' updated, -' + skipped + ' outside scope');
    outcomes.push({ id: p.id, status: 'ok', fetched: raw.length, added, updated, skipped });
    if (p.aewScheduleShow) {
      const dupes = dropSupplementalDuplicates(byId, p);
      if (dupes) {
        for (let i = promotionEvents.length - 1; i >= 0; i--) {
          if (!byId.has(promotionEvents[i].id)) promotionEvents.splice(i, 1);
        }
        log('  ' + p.id + ': -' + dupes + ' schedule episode(s) now listed by TheSportsDB');
      }
    }
    totalAdded += added;
    totalUpdated += updated;
    totalSkipped += skipped;

    // Promotion-level post-filter hook: catches bad upstream data that can
    // only be seen across the whole batch (e.g. WWE's same-date collision
    // between two distinctly-named events — see lib/promotions.js wwe
    // .sanitizeEvents). Runs before synthesis so expandEvents never derives
    // extras from a record this step is about to drop.
    if (typeof p.sanitizeEvents === 'function') {
      const beforeCount = promotionEvents.length;
      const kept = p.sanitizeEvents(promotionEvents, log) || [];
      const keptIds = new Set(kept.map((e) => e.id));
      const droppedCount = beforeCount - kept.length;
      if (droppedCount > 0) {
        for (const ev of promotionEvents) {
          if (!keptIds.has(ev.id)) byId.delete(ev.id);
        }
        promotionEvents.length = 0;
        promotionEvents.push(...kept);
        log('  ' + p.id + ': -' + droppedCount + ' dropped by sanity filter');
        totalSkipped += droppedCount;
      }
    }

    // 0.31.1: per-promotion synthesis hook. Lets a promotion add derived
    // events that aren't in the source's data — e.g. MotoGP Qualifying,
    // synthesised from Race events because TSDB doesn't catalogue separate
    // qualifying sessions. Synthesised events are skipped if their id
    // already exists (real events always win).
    if (typeof p.expandEvents === 'function') {
      const extras = p.expandEvents(promotionEvents) || [];
      let synth = 0;
      for (const ev of extras) {
        if (!ev || !ev.id || byId.has(ev.id)) continue;
        if (!inScope(ev, p)) continue;
        byId.set(ev.id, ev);
        promotionEvents.push(ev);
        synth++;
      }
      if (synth) log('  ' + p.id + ': +' + synth + ' synthesised event(s)');
      totalAdded += synth;
    }

    // Wikipedia poster backfill for events that lack imagery.
    // 0.31.1: removed the hasSourceDescription leg of the OR — descriptions
    // aren't rendered to clients anymore (see lib/transform.js), so fetching
    // them was pure waste. Halves Wikipedia traffic at minimum, and skips
    // the call entirely for image-complete events.
    // Also gated by WIKIPEDIA_ENRICH env (default on) — set to "off" for
    // fastest possible refresh when you don't care about per-event posters.
    const wikiEnrichOn = (process.env.WIKIPEDIA_ENRICH || 'on').toLowerCase() !== 'off';
    if (wikiEnrichOn && wiki && p.wikipediaTitle && (p.source.type === 'thesportsdb' || p.source.type === 'onefc' || p.source.type === 'wikipedia-list')) {
      const needsArt = promotionEvents.filter((ev) => !ev.hasSourceImage && ev.linkTarget);
      if (needsArt.length > 0) {
        const wikiStart = Date.now();
        log('  ' + p.id + ': backfilling ' + needsArt.length + ' image-less events from Wikipedia');
        try {
          await wiki.enrichWithSummaries(needsArt, log);
          for (const ev of needsArt) byId.set(ev.id, ev);
        } catch (err) {
          log('  ' + p.id + ' Wikipedia backfill failed: ' + err.message);
        }
        log('  ' + p.id + ': wiki took ' + ((Date.now() - wikiStart) / 1000).toFixed(1) + 's');
      }
    } else if (!wikiEnrichOn && p.wikipediaTitle) {
      log('  ' + p.id + ': Wikipedia enrichment disabled (WIKIPEDIA_ENRICH=off)');
    }
  }

  const merged = Array.from(byId.values()).sort((a, b) =>
    (b.date || '').localeCompare(a.date || '')
  );
  store.saveToDisk({ updatedAt: new Date().toISOString(), events: merged });

  const dur = ((Date.now() - start) / 1000).toFixed(1);
  const ok = failures.length === 0;
  log('[refresh] done in ' + dur + 's — ' + merged.length + ' total (' + totalAdded + ' new, ' + totalUpdated + ' updated, ' + totalSkipped + ' skipped'
    + (failures.length ? ', ' + failures.length + ' failed' : '') + ')');
  const result = { ok, total: merged.length, added: totalAdded, updated: totalUpdated,
    prunedOrphans };
  if (opts.recordStatus !== false) {
    require('../lib/refresh-status').record({
      finishedAt: new Date().toISOString(), ok, durationMs: Date.now() - start,
      scope: targetPromotionId ? targetPromotionId : 'all', total: merged.length, promotions: outcomes,
    });
  }
  if (failures.length) {
    result.error = failures.length === 1
      ? failures[0].error
      : failures.length + ' promotions failed to refresh';
    result.failures = failures;
  }
  return result;
}

if (require.main === module) {
  runRefresh().then((r) => process.exit(r.ok ? 0 : 1));
}

module.exports = { runRefresh, refreshPromotion, normalizeRecord, inScope, activeSeasons,
  knownPromotionPrefixes, isOrphanEventId, dropSupplementalDuplicates };
