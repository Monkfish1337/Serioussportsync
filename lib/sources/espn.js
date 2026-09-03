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
const LEAGUES = Object.freeze({
  nfl: { path: 'football/nfl', label: 'NFL', country: 'United States' },
  nba: { path: 'basketball/nba', label: 'NBA', country: 'United States' },
  nhl: { path: 'hockey/nhl', label: 'NHL', country: 'United States' },
  mlb: { path: 'baseball/mlb', label: 'MLB', country: 'United States' },
});

const MAX_GAMES = 5000;
// A full NFL season range is ~700 KB. Three megabytes leaves room for a
// busier league without letting a runaway response exhaust memory.
const MAX_BYTES = 3 * 1024 * 1024;

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

  const url = BASE + '/' + meta.path + '/scoreboard?limit=1000&dates='
    + compact(dateFrom) + '-' + compact(dateTo);
  log('-> espn: ' + meta.label + ' scoreboard ' + dateFrom + ' to ' + dateTo);
  const response = await fetch(url, httpAgent.fetchOpts({
    headers: { Accept: 'application/json', 'User-Agent': 'SeriousSportSync/0.84' },
    timeout: 25000,
  }, url));
  if (!response.ok) throw new Error('espn HTTP ' + response.status + ' for ' + meta.label);
  const body = await boundedBody.readBuffer(response, MAX_BYTES, 'ESPN scoreboard');
  let json;
  try { json = JSON.parse(body.toString('utf8')); }
  catch (error) { throw new Error('espn returned unparsable JSON for ' + meta.label); }
  const raw = parseScoreboard(json, league);
  log('   espn: ' + raw.length + ' ' + meta.label + ' fixture(s)');
  return raw;
}

module.exports = { fetchAll, toRaw, parseScoreboard, LEAGUES, BASE };
