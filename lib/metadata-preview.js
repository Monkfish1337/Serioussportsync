'use strict';

// Read-only validation and sample-event preview for reusable metadata sources.
// This deliberately does not call the refresh/store path: previewing a source
// must never replace catalog data or alter promotion assignments.
const config = require('../config');
const settings = require('./settings');
const transform = require('./transform');

const defaultAdapters = {
  thesportsdb: require('./sources/thesportsdb'),
  mlb: require('./sources/mlb'),
  onefc: require('./sources/onefc'),
  footballData: require('./sources/football-data'),
  tmdb: require('./sources/tmdb'),
};

const MAX_SAMPLE_EVENTS = 8;

function isoDay(date) { return date.toISOString().slice(0, 10); }

function dayOffset(now, days) {
  const value = new Date(now);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + days);
  return isoDay(value);
}

function previewPromotion(definition) {
  return {
    id: 'source-preview',
    idPrefix: 'source-preview',
    name: definition.name,
    source: definition.source,
    defaults: {},
    posterShape: 'landscape',
    classify: () => 'event',
    buildAliases: (name) => [name],
    genres: () => [],
  };
}

function normalize(raw, type, promotion) {
  if (type === 'thesportsdb') return transform.fromTsdb(raw, promotion);
  if (type === 'football-data') return transform.fromFootballData(raw, promotion);
  if (type === 'tmdb') return transform.fromTmdb(raw, promotion);
  if (type === 'onefc' || type === 'mlb') return transform.fromWiki(raw, promotion);
  return null;
}

function safeEvent(event) {
  return {
    name: String(event.name || ''),
    date: event.date || null,
    time: event.time || null,
    venue: event.venue || null,
    sourceId: event.sourceId == null ? null : String(event.sourceId),
    hasArtwork: !!(event.poster || event.thumb || event.fanart),
  };
}

async function fetchRaw(definition, opts) {
  const source = definition.source || {};
  const adapters = opts.adapters || defaultAdapters;
  const now = opts.now || new Date();
  const log = opts.log || (() => {});
  const dateFrom = dayOffset(now, -7);
  const dateTo = dayOffset(now, 21);

  if (source.type === 'mlb') {
    return adapters.mlb.fetchAll({ dateFrom, dateTo, log });
  }
  if (source.type === 'onefc') {
    return adapters.onefc.fetchAll({ log });
  }
  if (source.type === 'thesportsdb') {
    const league = await adapters.thesportsdb.fetchLeague(source.leagueId, log);
    if (!league) throw new Error('TheSportsDB league was not found');
    let events = await adapters.thesportsdb.fetchUpcoming(source.leagueId, log);
    if (!events.length) events = await adapters.thesportsdb.fetchRecent(source.leagueId, log);
    return events;
  }
  if (source.type === 'football-data') {
    const apiKey = (opts.credentials && opts.credentials.footballDataApiKey)
      || settings.getFootballData().apiKey;
    if (!apiKey) throw new Error('football-data.org API key is not configured in Admin');
    if (source.teamId) {
      return adapters.footballData.fetchTeamMatches({
        teamId: source.teamId, dateFrom, dateTo, apiKey, log,
      });
    }
    const competition = await adapters.footballData.lookupCompetition({
      competitionId: source.competitionId, apiKey, log,
    });
    if (!competition) throw new Error('football-data.org competition was not found');
    const season = new Date(now).getUTCFullYear();
    return adapters.footballData.fetchMatches({
      competitionId: source.competitionId, season, apiKey, log,
    });
  }
  if (source.type === 'tmdb') {
    const apiKey = (opts.credentials && opts.credentials.tmdbApiKey)
      || (config.tmdb && config.tmdb.apiKey) || '';
    if (!apiKey) throw new Error('TMDB_API_KEY is not configured');
    const tvIds = Array.isArray(source.tvIds) && source.tvIds.length ? source.tvIds : [source.tvId];
    const out = [];
    for (const tvId of tvIds.slice(0, 3)) {
      const show = await adapters.tmdb.lookupShow({ tvId, apiKey, log });
      if (!show || !show.name) throw new Error('TMDB show ' + tvId + ' was not found');
      const seasons = (show.seasons || []).map((row) => Number(row && row.season_number))
        .filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => b - a);
      if (!seasons.length) continue;
      const result = await adapters.tmdb.fetchSeason({ tvId, seasonNumber: seasons[0], apiKey, log });
      for (const episode of result.episodes || []) out.push(Object.assign({}, episode, {
        showName: show.name,
        tvId: Number(tvId),
        seasonNumber: Number(episode.season_number || seasons[0]),
        episodeNumber: Number(episode.episode_number || 0),
      }));
    }
    return out;
  }
  throw new Error('Unsupported metadata adapter: ' + String(source.type || 'unknown'));
}

async function preview(definition, opts) {
  opts = opts || {};
  if (!definition || !definition.source) throw new Error('Metadata source definition is required');
  const raw = await fetchRaw(definition, opts);
  const promotion = previewPromotion(definition);
  const events = [];
  for (const record of Array.isArray(raw) ? raw : []) {
    const event = normalize(record, definition.source.type, promotion);
    if (!event) continue;
    events.push(safeEvent(event));
  }
  events.sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))
    || a.name.localeCompare(b.name));
  return {
    ok: true,
    source: { id: definition.id, name: definition.name, type: definition.source.type },
    fetched: Array.isArray(raw) ? raw.length : 0,
    normalized: events.length,
    events: events.slice(0, MAX_SAMPLE_EVENTS),
  };
}

module.exports = { preview, fetchRaw, normalize, safeEvent, dayOffset, MAX_SAMPLE_EVENTS };
