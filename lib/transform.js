const promotions = require('./promotions');
const config = require('../config');
const teamIdentities = require('./team-identities');

// Nuvio stamps the meta title text over the poster when a meta has no `logo`,
// which defaces our branded poster cards / labelled F1 thumbs. Supplying a
// transparent logo image suppresses that overlay (per Nuvio dev guidance).
// Served from /assets, so it needs PUBLIC_URL; undefined when unset, leaving
// other clients unchanged.
const _ASSET_BASE = (config.publicUrl || '').replace(/\/+$/, '');
const BLANK_LOGO = _ASSET_BASE ? (_ASSET_BASE + '/assets/blank.png') : undefined;

// Generic Stremio meta builders. Promotion-specific logic (classify,
// buildAliases, genres) lives in lib/promotions.js — this file just
// dispatches to whichever promotion the event belongs to.

// upload.wikimedia.org images 403 on some clients (Android-TV Nuvio), rendering
// broken. Prefer any non-Wikimedia source; fall back to the promotion's branded
// default. Handles both per-event Wikipedia-backfilled art and legacy defaults.
function nonWiki(url) {
  return (url && !/upload\.wikimedia\.org/i.test(url)) ? url : null;
}
function safePoster(ev) {
  const p = promotions.getByEventId(ev.id);
  const def = p && p.defaults ? p.defaults.poster : null;
  return nonWiki(ev.poster) || nonWiki(ev.thumb) || nonWiki(ev.fanart) || nonWiki(def) || undefined;
}
function safeBackground(ev) {
  const p = promotions.getByEventId(ev.id);
  const def = p && p.defaults ? p.defaults.fanart : null;
  return nonWiki(ev.fanart) || nonWiki(ev.banner) || nonWiki(def) || nonWiki(ev.poster) || undefined;
}

function toCatalogMeta(ev) {
  return {
    id: ev.id,
    type: config.addonType,
    name: ev.name,
    poster: safePoster(ev),
    posterShape: ev.posterShape || 'regular',
    background: safeBackground(ev),
    logo: BLANK_LOGO,
    // 0.31.1: descriptions stripped from rendered meta — source descriptions
    // (TSDB, Wikipedia, ONE FC) were inconsistent across promotions and
    // sometimes caused tile/detail cosmetic issues. Stored values stay in
    // the cache (for potential future use) but aren't surfaced to clients.
    description: undefined,
    releaseInfo: ev.dateLocal || ev.date || undefined,
    genres: ev.genres,
  };
}

function toDetailMeta(ev) {
  return {
    id: ev.id,
    type: config.addonType,
    name: ev.name,
    poster: safePoster(ev),
    posterShape: ev.posterShape || 'regular',
    background: safeBackground(ev),
    logo: BLANK_LOGO,
    // 0.31.1: descriptions stripped (see catalog toCatalogMeta above).
    description: undefined,
    releaseInfo: ev.dateLocal || ev.date || undefined,
    runtime: ev.kind === 'ppv' || ev.kind === 'numbered' ? '5h' : '4h',
    genres: ev.genres,
    country: ev.country || undefined,
    searchHints: ev.aliases,
    released: ev.date
      ? new Date(ev.date + 'T' + (ev.time || '00:00:00') + 'Z').toISOString()
      : undefined,
  };
}

// Convert a raw TheSportsDB event to our normalized internal form. Per-event
// imagery is preferred; falls back to promotion.defaults so events TSDB
// hasn't postered yet (typically upcoming events) still render with a
// branded placeholder. The post-refresh enrichment in scripts/refresh.js can
// later replace the fallback with a Wikipedia poster.
function fromTsdb(raw, promotion) {
  const rawName = (raw.strEvent || '').trim();
  if (!rawName) return null;
  // 0.38.1: optional promotion.normaliseName(rawName) hook lets a promotion
  // fix up upstream naming inconsistencies BEFORE the rest of the pipeline
  // sees the name. WWE uses this to force-prefix "WWE " on bare "Main Event
  // #N" entries (TSDB stored some of them without the WWE prefix, others
  // with it). Other promotions inherit the no-op default.
  const name = (typeof promotion.normaliseName === 'function')
    ? promotion.normaliseName(rawName) || rawName
    : rawName;
  const kind = promotion.classify(name);
  const aliases = promotion.buildAliases(name);
  const defaults = promotion.defaults || {};
  const description = raw.strDescriptionEN || null;
  const shortDescription = description ? description.slice(0, 280).trim() : null;

  const ev = {
    id: promotion.idPrefix + ':' + raw.idEvent,
    sourceId: raw.idEvent,
    promotion: promotion.id,
    name,
    kind,
    date: raw.dateEvent || null,
    dateLocal: raw.dateEventLocal || raw.dateEvent || null,
    time: raw.strTime || null,
    timestamp: raw.strTimestamp || null,
    season: raw.strSeason || null,
    round: raw.intRound || null,
    venue: raw.strVenue || null,
    city: raw.strCity || null,
    country: raw.strCountry || null,
    // Artwork. Three modes:
    //  - preferThumb: use TSDB's per-event strThumb (a clean 16:9 session card,
    //    e.g. F1's labelled circuit graphics) and fall back to the promotion's
    //    branded default when an event has no thumb yet. strFanart/strBanner are
    //    deliberately NOT used — for F1 those are wide name-banners that crop.
    //  - useDefaultArt: always the promotion's branded default.
    //  - default chain: landscape prefers strFanart/strBanner over strThumb
    //    (often a portrait poster Stremio would crop into a wide tile).
    poster: promotion.preferThumb
      ? (raw.strThumb || defaults.poster || null)
      : promotion.useDefaultArt
        ? (defaults.poster || null)
        : ((promotion.posterShape === 'landscape')
            ? (raw.strFanart || raw.strBanner || raw.strThumb || raw.strPoster || defaults.poster || null)
            : (raw.strPoster || raw.strThumb || defaults.poster || null)),
    thumb: promotion.preferThumb
      ? (raw.strThumb || defaults.poster || null)
      : promotion.useDefaultArt
        ? (defaults.poster || null)
        : (raw.strThumb || raw.strPoster || defaults.poster || null),
    // Backdrop (background). Not falling back to strBanner — TSDB banners are
    // wide strips with the logo pinned to one side (off-center backdrop).
    fanart: promotion.preferThumb
      ? (raw.strThumb || defaults.fanart || null)
      : promotion.useDefaultArt
        ? (defaults.fanart || null)
        : (raw.strFanart || defaults.fanart || null),
    banner: promotion.preferThumb
      ? (raw.strThumb || defaults.fanart || null)
      : promotion.useDefaultArt
        ? (defaults.fanart || null)
        : (raw.strBanner || raw.strFanart || defaults.fanart || null),
    square: raw.strSquare || null,
    leagueBadge: raw.strLeagueBadge || null,
    description,
    shortDescription,
    aliases,
    posterShape: promotion.posterShape || 'regular',
    hasSourceImage: !!(raw.strPoster || raw.strThumb),
    hasSourceDescription: !!description,
    linkTarget: promotion.wikipediaTitle ? promotion.wikipediaTitle(name) : null,
    // Source provenance — used by the refresh prune step to detect events
    // left over from a previous source (Wikipedia, onefc, etc.) when a
    // promotion migrates between sources.
    source: { type: 'thesportsdb', idEvent: raw.idEvent || null },
  };
  ev.genres = promotion.genres(ev);
  return ev;
}

// Convert a raw event from a Wikipedia source to our normalized form.
// Per-event imagery is preferred; falls back to promotion.defaults when
// absent (e.g. ONE Friday Fights, which don't get individual articles).
function fromWiki(raw, promotion) {
  const name = (raw.name || '').trim();
  if (!name || !raw.sourceId) return null;
  const kind = promotion.classify(name);
  const aliases = promotion.buildAliases(name);
  const defaults = promotion.defaults || {};

  const ev = {
    id: promotion.idPrefix + ':' + raw.sourceId,
    sourceId: raw.sourceId,
    promotion: promotion.id,
    name,
    kind,
    date: raw.date || null,
    dateLocal: raw.dateLocal || raw.date || null,
    time: raw.time || null,
    timestamp: raw.timestamp || null,
    venue: raw.venue || null,
    city: raw.city || null,
    country: raw.country || null,
    poster: raw.poster || defaults.poster || null,
    thumb: raw.thumb || raw.poster || defaults.poster || null,
    fanart: raw.fanart || defaults.fanart || null,
    banner: raw.banner || defaults.fanart || null,
    description: raw.description || null,
    shortDescription: raw.description ? raw.description.slice(0, 280).trim() : null,
    aliases,
    posterShape: promotion.posterShape || 'regular',
    hasSourceImage: !!raw.poster,
    hasSourceDescription: !!raw.description,
    linkTarget: raw.linkTarget || (promotion.wikipediaTitle ? promotion.wikipediaTitle(name) : null),
    // Source provenance preserved from the raw record (set by the wikipedia,
    // wikipedia-list, onefc, mlb or espn adapter). Used by the refresh prune step.
    source: raw.source || null,
  };
  // Structured side names when the adapter supplies them (ESPN does; the
  // wiki-derived adapters do not). Team-aware matching and the Sport-Video
  // team filter both prefer these over splitting the fixture title.
  if (raw.teamNames && (raw.teamNames.home || raw.teamNames.away)) {
    ev.teamNames = {
      home: [].concat(raw.teamNames.home || []),
      away: [].concat(raw.teamNames.away || []),
    };
  }
  ev.genres = promotion.genres(ev);
  return ev;
}

// 0.38.0 — Convert a raw football-data.org match to our normalized event form.
//
// football-data shape:
//   { id, utcDate, status, matchday, season: {startDate,...},
//     competition: { id, name, code },
//     homeTeam: { id, name, shortName, tla, crest },
//     awayTeam: { id, name, shortName, tla, crest },
//     score: { fullTime: {home, away}, ... }
//   }
//
// Match name = 'Home vs Away' (matches the convention SSS uses for football
// elsewhere). Date = utcDate.slice(0,10). Round = matchday. TBD fixtures
// (no team set yet — e.g. knockout brackets before draw) skip.
// shortName first: it is the form the event is named with, so it stays the
// primary identity. A three-letter tla ("MCI") is kept last — it is the weakest
// signal and only used once the fuller forms have missed.
function footballDataTeamNames(team) {
  if (!team) return [];
  const out = [];
  const seen = new Set();
  for (const value of [team.shortName, team.name, team.tla]) {
    const text = String(value || '').trim();
    const key = text.toLowerCase();
    if (text && !seen.has(key)) { seen.add(key); out.push(text); }
  }
  return out;
}

function fromFootballData(raw, promotion) {
  if (!raw || !raw.utcDate) return null;
  const home = raw.homeTeam && (raw.homeTeam.shortName || raw.homeTeam.name);
  const away = raw.awayTeam && (raw.awayTeam.shortName || raw.awayTeam.name);
  if (!home || !away) return null;                 // TBD fixture
  const name = home + ' vs ' + away;
  const kind = promotion.classify(name);
  const aliases = promotion.buildAliases(name);
  const defaults = promotion.defaults || {};

  const date = String(raw.utcDate).slice(0, 10);
  const time = String(raw.utcDate).length >= 19 ? String(raw.utcDate).slice(11, 19) : null;
  const round = raw.matchday != null ? String(raw.matchday) : null;
  const competition = raw.competition || {};
  const crest = (raw.homeTeam && raw.homeTeam.crest) || (raw.awayTeam && raw.awayTeam.crest) || null;

  const ev = {
    id: promotion.idPrefix + ':' + raw.id,
    sourceId: String(raw.id),
    promotion: promotion.id,
    name,
    kind,
    date,
    dateLocal: date,
    time,
    timestamp: raw.utcDate || null,
    season: raw.season && raw.season.startDate ? String(raw.season.startDate).slice(0, 4) : null,
    round,
    competition: competition.name || null,
    competitionCode: competition.code || null,
    venue: raw.venue || null,
    city: null,
    country: null,
    // Imagery — football-data doesn't ship per-match art. Use team crest as
    // a poster fallback; otherwise promotion's branded defaults.
    poster: crest || defaults.poster || null,
    thumb: crest || defaults.poster || null,
    fanart: defaults.fanart || null,
    banner: defaults.fanart || null,
    square: null,
    leagueBadge: competition.emblem || null,
    description: null,
    shortDescription: null,
    aliases,
    posterShape: promotion.posterShape || 'regular',
    hasSourceImage: !!crest,
    hasSourceDescription: false,
    linkTarget: promotion.wikipediaTitle ? promotion.wikipediaTitle(name) : null,
    // Every naming form the provider offers, kept structured.
    //
    // The event name above uses shortName, which is what a person would call
    // the club — but release names are inconsistent about which form they use,
    // and matching on the single chosen form fails in both directions:
    // "Man City" never matches a "Manchester City" release, and "Celta Vigo"
    // never matches "Celta de Vigo". football-data supplies name, shortName and
    // tla for every side, so all three are carried and the matcher tries each.
    teamNames: {
      home: footballDataTeamNames(raw.homeTeam),
      away: footballDataTeamNames(raw.awayTeam),
    },
    // Source provenance — used by the prune step in refresh.js to detect
    // events left over from a previous source.
    source: {
      type: 'football-data',
      idEvent: String(raw.id),
      homeTeamId: raw.homeTeam && raw.homeTeam.id != null ? String(raw.homeTeam.id) : null,
      awayTeamId: raw.awayTeam && raw.awayTeam.id != null ? String(raw.awayTeam.id) : null,
    },
  };
  ev.genres = promotion.genres(ev);
  return ev;
}

// API-Football fixture -> normalized SSS event. Use the provider's full team
// names for display and preserve every stable identity field for future alias
// enrichment. This deliberately avoids a provider-specific short display name
// such as "Atleti" becoming the only query identity.
function fromApiFootball(raw, promotion) {
  const fixture = raw && raw.fixture;
  const teams = raw && raw.teams;
  const home = teams && teams.home;
  const away = teams && teams.away;
  if (!fixture || fixture.id == null || !fixture.date || !home || !home.name || !away || !away.name) return null;
  const name = String(home.name).trim() + ' vs ' + String(away.name).trim();
  const dateTime = String(fixture.date);
  const date = dateTime.slice(0, 10);
  const competition = raw.league || {};
  const defaults = promotion.defaults || {};
  const venue = fixture.venue || {};
  const event = {
    id: promotion.idPrefix + ':' + fixture.id,
    sourceId: String(fixture.id),
    promotion: promotion.id,
    name,
    kind: promotion.classify(name),
    date,
    dateLocal: date,
    time: dateTime.length >= 19 ? dateTime.slice(11, 19) : null,
    timestamp: dateTime,
    season: competition.season == null ? null : String(competition.season),
    round: competition.round || null,
    competition: competition.name || null,
    competitionCode: competition.id == null ? null : String(competition.id),
    venue: venue.name || null,
    city: venue.city || null,
    country: competition.country || null,
    poster: home.logo || away.logo || defaults.poster || null,
    thumb: home.logo || away.logo || defaults.poster || null,
    fanart: defaults.fanart || null,
    banner: defaults.fanart || null,
    square: null,
    leagueBadge: competition.logo || null,
    description: competition.round ? String(competition.round) : null,
    shortDescription: competition.round ? String(competition.round) : null,
    aliases: promotion.buildAliases(name),
    posterShape: promotion.posterShape || 'regular',
    hasSourceImage: !!(home.logo || away.logo || competition.logo),
    hasSourceDescription: !!competition.round,
    linkTarget: null,
    source: {
      type: 'api-football',
      idEvent: String(fixture.id),
      leagueId: competition.id == null ? null : String(competition.id),
      homeTeamId: home.id == null ? null : String(home.id),
      awayTeamId: away.id == null ? null : String(away.id),
      homeTeamName: String(home.name),
      awayTeamName: String(away.name),
    },
  };
  event.genres = promotion.genres(event);
  return event;
}

// Official UEFA fixture -> normalized SSS event. Prefer UEFA's full English
// identity over its deliberately abbreviated display label (for example
// "Borussia Dortmund" instead of "B. Dortmund" and "Atlético de Madrid"
// instead of "Atleti"). The promotion alias table then produces the common
// scene/release spellings without losing the authoritative club identity.
function fromUefa(raw, promotion) {
  if (!raw || raw.id == null || !raw.homeTeam || !raw.awayTeam || !raw.kickOffTime) return null;
  const english = (team, field) => team && team.translations && team.translations[field]
    && team.translations[field].EN;
  const teamName = (team) => String(english(team, 'displayOfficialName')
    || english(team, 'displayName') || team.internationalName || '').trim();
  const homeName = teamName(raw.homeTeam);
  const awayName = teamName(raw.awayTeam);
  const timestamp = String(raw.kickOffTime.dateTime || raw.kickOffTime.date || '');
  const date = String(raw.kickOffTime.date || timestamp.slice(0, 10));
  if (!homeName || !awayName || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const name = homeName + ' vs ' + awayName;
  const defaults = promotion.defaults || {};
  const competition = raw.competition || {};
  const round = raw.round || {};
  const stadium = raw.stadium || {};
  const stadiumName = stadium.translations && stadium.translations.name
    && stadium.translations.name.EN;
  const cityName = stadium.city && stadium.city.translations && stadium.city.translations.name
    && stadium.city.translations.name.EN;
  const homeLogo = raw.homeTeam.mediumLogoUrl || raw.homeTeam.logoUrl || raw.homeTeam.bigLogoUrl;
  const awayLogo = raw.awayTeam.mediumLogoUrl || raw.awayTeam.logoUrl || raw.awayTeam.bigLogoUrl;
  const roundName = (round.metaData && round.metaData.name)
    || (round.translations && round.translations.name && round.translations.name.EN)
    || null;
  const legName = raw.leg && raw.leg.translations && raw.leg.translations.name
    && raw.leg.translations.name.EN;
  const leagueLogo = competition.images && (competition.images.FULL_LOGO || competition.images.LOGO);
  const event = {
    id: promotion.idPrefix + ':' + raw.id,
    sourceId: String(raw.id),
    promotion: promotion.id,
    name,
    kind: promotion.classify(name),
    date,
    dateLocal: date,
    time: timestamp.length >= 19 ? timestamp.slice(11, 19) : null,
    timestamp: timestamp || null,
    season: raw.seasonYear == null ? null : String(raw.seasonYear),
    round: roundName,
    leg: legName || null,
    competition: (competition.metaData && competition.metaData.name)
      || (competition.translations && competition.translations.name && competition.translations.name.EN)
      || null,
    competitionCode: competition.code || (competition.id == null ? null : String(competition.id)),
    venue: stadiumName || null,
    city: cityName || null,
    country: stadium.countryCode || null,
    poster: homeLogo || awayLogo || defaults.poster || null,
    thumb: homeLogo || awayLogo || defaults.poster || null,
    fanart: (stadium.images && (stadium.images.LARGE_ULTRA_WIDE || stadium.images.MEDIUM_WIDE))
      || defaults.fanart || null,
    banner: defaults.fanart || null,
    square: null,
    leagueBadge: leagueLogo || null,
    description: roundName,
    shortDescription: roundName,
    aliases: promotion.buildAliases(name),
    teamNames: {
      home: teamIdentities.providerTeamNames(raw.homeTeam),
      away: teamIdentities.providerTeamNames(raw.awayTeam),
    },
    posterShape: promotion.posterShape || 'regular',
    hasSourceImage: !!(homeLogo || awayLogo || leagueLogo),
    hasSourceDescription: !!roundName,
    linkTarget: null,
    source: {
      type: 'uefa',
      idEvent: String(raw.id),
      competitionId: competition.id == null ? null : String(competition.id),
      homeTeamId: raw.homeTeam.id == null ? null : String(raw.homeTeam.id),
      awayTeamId: raw.awayTeam.id == null ? null : String(raw.awayTeam.id),
      homeTeamName: homeName,
      awayTeamName: awayName,
      homeTeamNames: teamIdentities.providerTeamNames(raw.homeTeam),
      awayTeamNames: teamIdentities.providerTeamNames(raw.awayTeam),
    },
  };
  event.genres = promotion.genres(event);
  return event;
}

// 0.42.13 - TMDB TV show episode -> SSS event normalizer.
//
// TMDB gives us episodes with air_date, season/episode numbers, and show
// name. For a sport show like Match of the Day (tvId 224), each episode is
// an event whose date drives DARKSPORT-style search title generation. The
// event name mirrors the show name so promotion.searchTitles({date, name})
// produces things like "Match Of The Day 2026 05 30".
function fromTmdb(raw, promotion) {
  if (!raw || !raw.air_date || !raw.showName) return null;
  // TMDB air_date is YYYY-MM-DD.
  const date = String(raw.air_date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const sourceShowName = String(raw.showName).trim();
  // A merged TV-show catalog can expose multiple source shows under one
  // canonical release name. MOTD folds Match of the Day 2 into the same
  // catalog and names both shows by their air date.
  const showName = (promotion && typeof promotion.formatEventName === 'function')
    ? String(promotion.formatEventName(sourceShowName, raw) || sourceShowName).trim()
    : sourceShowName;
  const season = Number.isFinite(raw.seasonNumber) ? raw.seasonNumber : null;
  const episode = Number.isFinite(raw.episodeNumber) ? raw.episodeNumber : null;
  const kind = promotion.classify ? promotion.classify(showName) : null;
  const aliases = promotion.buildAliases ? promotion.buildAliases(showName) : [];
  const defaults = promotion.defaults || {};
  // Stable id: prefer season/episode when both present, else fall back to
  // date (which is unique within a show).
  const episodeKey = (season != null && episode != null)
    ? ('s' + season + 'e' + episode)
    : date.replace(/-/g, '');
  // Season/episode pairs are unique only within one TV series. Include the
  // tvId for merged promotions so MOTD and MOTD2 episodes cannot collide.
  const isMergedShow = promotion && promotion.source
    && Array.isArray(promotion.source.tvIds)
    && promotion.source.tvIds.length > 1;
  const uniq = isMergedShow ? ('tv' + raw.tvId + '-' + episodeKey) : episodeKey;
  const stillFull = raw.still_path ? 'https://image.tmdb.org/t/p/w780' + raw.still_path : null;

  const ev = {
    id: promotion.idPrefix + ':' + uniq,
    sourceId: uniq,
    promotion: promotion.id,
    name: showName,
    kind,
    date,
    dateLocal: date,
    time: null,
    timestamp: date + 'T00:00:00Z',
    season: season != null ? String(season) : null,
    round: episode != null ? String(episode) : null,
    venue: null,
    city: null,
    country: null,
    poster: stillFull || defaults.poster || null,
    thumb: stillFull || defaults.poster || null,
    fanart: defaults.fanart || null,
    banner: defaults.fanart || null,
    square: null,
    leagueBadge: null,
    description: raw.overview || null,
    shortDescription: raw.overview || null,
    aliases,
    posterShape: promotion.posterShape || 'landscape',
    hasSourceImage: !!stillFull,
    hasSourceDescription: !!raw.overview,
    linkTarget: promotion.wikipediaTitle ? promotion.wikipediaTitle(showName) : null,
    source: { type: 'tmdb', tvId: raw.tvId, uniq },
  };
  ev.genres = promotion.genres ? promotion.genres(ev) : ['Sport'];
  return ev;
}

module.exports = {
  toCatalogMeta,
  toDetailMeta,
  fromTsdb,
  fromWiki,
  fromFootballData,
  fromApiFootball,
  fromUefa,
  fromTmdb,
};
