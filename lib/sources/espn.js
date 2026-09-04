'use strict';

// ESPN scoreboard adapter, used for leagues with no usable free feed of their
// own.
//
// Why not TheSportsDB: SSS's shared TSDB key caps `eventsseason.php` at about
// fifteen results, so an NFL promotion built on it returns fifteen of a
// 272-game season. The same measurement is what led MLB to its own adapter.
// ESPN's public scoreboard returns the whole slate — 285 NFL games for a full
// season range, 71 NBA games across nine days — with no key and no account.
//
// The endpoint is undocumented and carries no compatibility promise, which is
// the trade being made deliberately: it is the same bet already taken on
// statsapi.mlb.com for MLB. Everything here fails soft — a shape change drops
// records rather than throwing, so a broken upstream degrades the catalog
// instead of failing the whole refresh.

const fetch = require('node-fetch');
const httpAgent = require('../http-agent');
const boundedBody = require('../bounded-body');

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// Path segments ESPN uses, keyed by the identifier a promotion declares.
// Each verified against the live endpoint before being listed: a wrong path
// answers 200 with an empty or stale event list rather than an error, so an
// unverified guess looks like a working league that never returns a fixture.
// CFL is deliberately absent — ESPN still serves that path, but its newest
// fixture is from 2022.
const LEAGUES = Object.freeze({
  nfl: { path: 'football/nfl', label: 'NFL', country: 'United States' },
  nba: { path: 'basketball/nba', label: 'NBA', country: 'United States' },
  wnba: { path: 'basketball/wnba', label: 'WNBA', country: 'United States' },
  ncaaf: { path: 'football/college-football', label: 'NCAA Football', country: 'United States' },
  nhl: { path: 'hockey/nhl', label: 'NHL', country: 'United States' },
  mlb: { path: 'baseball/mlb', label: 'MLB', country: 'United States' },
});

const MAX_GAMES = 5000;
// One 31-day window of the busiest league (MLB, ~450 games) is well under a
// megabyte; four leaves headroom for a shape change without letting a runaway
// response exhaust memory. The earlier 3 MB cap was measured against a probe
// that ESPN answered with a trimmed payload, and a real 120-day NFL window
// exceeded it — hence the chunking below rather than a bigger number alone.
const MAX_BYTES = 4 * 1024 * 1024;
// ESPN answers a `dates=` range in one response with no pagination, so the
// only way to bound it is to bound the range. 31 days keeps every league's
// window small and predictable.
const CHUNK_DAYS = 31;

function compact(value) {
  return String(value || '').replace(/-/g, '');
}

// ESPN dates are ISO with a Z offset, e.g. 2026-09-11T00:35Z. The calendar day
// is taken in UTC deliberately: every other source in SSS keys events by their
// UTC date, and matching compares dates with a one-day tolerance either way,
// which absorbs the evening-kickoff-crosses-midnight case.
function splitTimestamp(value) {
  const iso = String(value || '');
  const match = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) return { date: '', time: null };
  return { date: match[1], time: match[2] + ':00' };
}

function teamOf(competitors, side) {
  const entry = (competitors || []).find((c) => c && c.homeAway === side);
  return (entry && entry.team) || null;
}

// One scoreboard event to the raw record shape scripts/refresh.js expects,
// matching lib/sources/mlb.js so both flow through transform.fromWiki.
function toRaw(event, league) {
  if (!event || !event.id) return null;
  const competition = (event.competitions || [])[0];
  const competitors = (competition && competition.competitors) || [];
  const home = teamOf(competitors, 'home');
  const away = teamOf(competitors, 'away');
  if (!home || !away) return null;
  const homeName = String(home.displayName || '').trim();
  const awayName = String(away.displayName || '').trim();
  if (!homeName || !awayName) return null;

  const { date, time } = splitTimestamp(event.date);
  if (!date) return null;

  const venue = competition && competition.venue;
  const address = (venue && venue.address) || {};
  const status = event.status && event.status.type && event.status.type.name;
  const meta = LEAGUES[league] || {};

  return {
    sourceId: String(event.id),
    // "Away at Home", which is the convention MLB already produces and the
    // promotion matchers already split on.
    name: awayName + ' at ' + homeName,
    date,
    time,
    timestamp: String(event.date || '') || null,
    venue: (venue && venue.fullName) || null,
    city: address.city || null,
    country: address.country || meta.country || null,
    // Team logos are the only artwork ESPN offers and are stable CDN URLs.
    poster: away.logo || home.logo || null,
    thumb: home.logo || away.logo || null,
    fanart: null,
    banner: null,
    description: [meta.label, venue && venue.fullName].filter(Boolean).join(' · '),
    // Retained so a future migration can re-key events without refetching.
    teamNames: {
      home: [homeName, home.location, home.name, home.abbreviation]
        .map((v) => String(v || '').trim()).filter(Boolean)
        .filter((v, i, all) => all.indexOf(v) === i),
      away: [awayName, away.location, away.name, away.abbreviation]
        .map((v) => String(v || '').trim()).filter(Boolean)
        .filter((v, i, all) => all.indexOf(v) === i),
    },
    source: {
      type: 'espn', league, eventId: String(event.id),
      homeTeamId: home.id == null ? null : String(home.id),
      awayTeamId: away.id == null ? null : String(away.id),
      status: status || null,
    },
  };
}

function parseScoreboard(json, league) {
  const out = [];
  for (const event of ((json && json.events) || [])) {
    const raw = toRaw(event, league);
    if (raw) out.push(raw);
    if (out.length >= MAX_GAMES) break;
  }
  return out;
}

// Every team in a league, for the team picker. A separate endpoint from the
// scoreboard, and cheap: one call returns the full roster of clubs with logos.
async function fetchTeams(opts) {
  const options = opts || {};
  const log = options.log || (() => {});
  const league = String(options.league || '').trim().toLowerCase();
  const meta = LEAGUES[league];
  if (!meta) throw new Error('espn: unsupported league "' + league + '"');
  const url = BASE + '/' + meta.path + '/teams?limit=500';
  const response = await fetch(url, httpAgent.fetchOpts({
    headers: { Accept: 'application/json', 'User-Agent': 'SeriousSportSync/0.89' },
    timeout: 20000,
  }, url));
  if (!response.ok) throw new Error('espn HTTP ' + response.status + ' for ' + meta.label + ' teams');
  const body = await boundedBody.readBuffer(response, MAX_BYTES, 'ESPN teams');
  let json;
  try { json = JSON.parse(body.toString('utf8')); }
  catch (error) { throw new Error('espn returned unparsable JSON for ' + meta.label + ' teams'); }
  const leagues = (((json && json.sports) || [])[0] || {}).leagues || [];
  const entries = (leagues[0] || {}).teams || [];
  const out = [];
  for (const entry of entries) {
    const team = entry && entry.team;
    if (!team || team.id == null) continue;
    const name = String(team.displayName || team.name || '').trim();
    if (!name) continue;
    out.push({
      id: String(team.id),
      name,
      fullName: name,
      abbreviation: String(team.abbreviation || '').trim(),
      crest: String((Array.isArray(team.logos) && team.logos[0] && team.logos[0].href) || ''),
      // Kept so a per-team promotion can recognise the fixture by any form.
      names: [name, team.location, team.name, team.abbreviation]
        .map((value) => String(value || '').trim()).filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index),
    });
  }
  log('   espn: ' + out.length + ' ' + meta.label + ' team(s)');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Inclusive [from, to] split into windows of at most CHUNK_DAYS days.
function dateWindows(dateFrom, dateTo) {
  const start = Date.parse(dateFrom + 'T00:00:00Z');
  const end = Date.parse(dateTo + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const day = 86400000;
  const out = [];
  for (let cursor = start; cursor <= end; cursor += CHUNK_DAYS * day) {
    const last = Math.min(cursor + (CHUNK_DAYS - 1) * day, end);
    out.push([new Date(cursor).toISOString().slice(0, 10), new Date(last).toISOString().slice(0, 10)]);
  }
  return out;
}

async function fetchWindow(meta, league, from, to, log) {
  const url = BASE + '/' + meta.path + '/scoreboard?limit=1000&dates='
    + compact(from) + '-' + compact(to);
  const response = await fetch(url, httpAgent.fetchOpts({
    headers: { Accept: 'application/json', 'User-Agent': 'SeriousSportSync/0.85' },
    timeout: 25000,
  }, url));
  if (!response.ok) throw new Error('espn HTTP ' + response.status + ' for ' + meta.label);
  const body = await boundedBody.readBuffer(response, MAX_BYTES, 'ESPN scoreboard');
  let json;
  try { json = JSON.parse(body.toString('utf8')); }
  catch (error) { throw new Error('espn returned unparsable JSON for ' + meta.label); }
  return parseScoreboard(json, league);
}

async function fetchAll(opts) {
  const options = opts || {};
  const log = options.log || (() => {});
  const league = String(options.league || '').trim().toLowerCase();
  const meta = LEAGUES[league];
  if (!meta) throw new Error('espn: unsupported league "' + league + '"');
  const dateFrom = String(options.dateFrom || '').trim();
  const dateTo = String(options.dateTo || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    throw new Error('espn: dateFrom and dateTo must be YYYY-MM-DD');
  }

  const windows = dateWindows(dateFrom, dateTo);
  log('-> espn: ' + meta.label + ' scoreboard ' + dateFrom + ' to ' + dateTo
    + ' (' + windows.length + ' window(s))');
  // De-duplicated by fixture id: a game rescheduled across a window boundary
  // can legitimately appear in two responses.
  const byId = new Map();
  for (const [from, to] of windows) {
    const chunk = await fetchWindow(meta, league, from, to, log);
    for (const raw of chunk) {
      if (!byId.has(raw.sourceId)) byId.set(raw.sourceId, raw);
      if (byId.size >= MAX_GAMES) break;
    }
    if (byId.size >= MAX_GAMES) break;
  }
  const raw = Array.from(byId.values());
  log('   espn: ' + raw.length + ' ' + meta.label + ' fixture(s)');
  return raw;
}

module.exports = { fetchAll, fetchTeams, toRaw, parseScoreboard, dateWindows, LEAGUES, BASE, CHUNK_DAYS };
