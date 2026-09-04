// 0.38.0 — football-data.org API client.
//
// Talks to api.football-data.org/v4. Used by custom promotions whose
// source.type === 'football-data' to pull match fixtures + results for
// any of football-data.org's competitions (FIFA WC, EPL, Champions
// League, Bundesliga, La Liga, Serie A, etc.).
//
// Free tier:
//   - 10 requests per minute (hard cap)
//   - Covers competition codes: WC, PL, CL, BL1, SA, FL1, PD, EC, ELC
//   - Free signup at https://www.football-data.org/client/register
//
// Auth: header `X-Auth-Token: <api-key>`
// Endpoints used:
//   GET /v4/competitions/{id}              -> competition metadata
//   GET /v4/competitions/{id}/matches      -> matches (filterable by season/date/status)
//
// Rate limiter: in-process token bucket. With only one SSS instance per
// deploy this is enough; multi-instance deployments would need a shared
// rate-limit store, which we don't have today.

const fetch = require('node-fetch');
const httpAgent = require('../http-agent');

const BASE = 'https://api.football-data.org/v4';

// 10/min free-tier ceiling. Honour it strictly + leave a small buffer so the
// 11th request doesn't immediately 429.
const RATE_PER_MIN = 9;
const RATE_WINDOW_MS = 60 * 1000;
const recentRequests = [];

function rateLimitWait() {
  const now = Date.now();
  // Drop entries older than the window.
  while (recentRequests.length && recentRequests[0] < now - RATE_WINDOW_MS) {
    recentRequests.shift();
  }
  if (recentRequests.length < RATE_PER_MIN) {
    recentRequests.push(now);
    return 0;
  }
  // We're at the cap. Wait until the oldest entry slides out of the window.
  const wait = RATE_WINDOW_MS - (now - recentRequests[0]) + 50;
  return Math.max(wait, 0);
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getJson(url, apiKey, opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const headers = {
    'X-Auth-Token': apiKey,
    'Accept': 'application/json',
    'User-Agent': 'serioussportsync/0.38',
  };
  for (let attempt = 0; attempt <= 3; attempt++) {
    const wait = rateLimitWait();
    if (wait > 0) {
      log('  football-data: rate-limit pacing — sleeping ' + Math.round(wait / 1000) + 's');
      await delay(wait);
    }
    let res;
    try {
      res = await fetch(url, httpAgent.fetchOpts({ headers, timeout: 20000 }, url));
    } catch (err) {
      if (attempt < 3) {
        const w = 2000 * (attempt + 1);
        log('  football-data: network error, retry in ' + w + 'ms: ' + err.message);
        await delay(w); continue;
      }
      throw err;
    }
    if (res.status === 429) {
      // Server-enforced rate limit. football-data sometimes returns retry-after
      // as a number-of-seconds in the body; honour Retry-After header too.
      const ra = parseInt(res.headers.get('retry-after'), 10);
      const wait = ra && !Number.isNaN(ra) ? ra * 1000 : 65000;
      log('  football-data: HTTP 429 — sleeping ' + Math.round(wait / 1000) + 's');
      await delay(wait);
      continue;
    }
    if (res.status === 403) {
      throw new Error('football-data 403 (auth) — check FOOTBALL_DATA_API_KEY env var');
    }
    if (res.status === 404) {
      // Caller decides whether 404 is fatal (competition lookup) or empty
      // (matches endpoint).
      return null;
    }
    if (!res.ok) {
      throw new Error('football-data HTTP ' + res.status + ' ' + res.statusText + ' for ' + url);
    }
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch (err) { throw new Error('Bad JSON from ' + url + ': ' + err.message); }
  }
  throw new Error('football-data: exhausted retries for ' + url);
}

// Fetch a competition's metadata. Used by the /admin validator.
// competitionId can be either numeric (2000) or alphanumeric code ('WC', 'PL').
async function lookupCompetition({ competitionId, apiKey, log }) {
  if (!apiKey) throw new Error('FOOTBALL_DATA_API_KEY not set');
  const url = BASE + '/competitions/' + encodeURIComponent(competitionId);
  return getJson(url, apiKey, { log });
}

// Every club in a competition, for the team picker. This is what turns the
// wizard's raw numeric teamId into a chooser: football-data returns the club's
// id, both naming forms, its tla and a crest URL in one call.
async function fetchCompetitionTeams({ competitionId, apiKey, log }) {
  if (!apiKey) throw new Error('FOOTBALL_DATA_API_KEY not set');
  const url = BASE + '/competitions/' + encodeURIComponent(competitionId) + '/teams';
  const json = await getJson(url, apiKey, { log });
  const teams = (json && Array.isArray(json.teams)) ? json.teams : [];
  return teams.map((team) => ({
    id: team && team.id != null ? String(team.id) : '',
    name: String((team && (team.shortName || team.name)) || '').trim(),
    fullName: String((team && team.name) || '').trim(),
    abbreviation: String((team && team.tla) || '').trim(),
    crest: String((team && team.crest) || '').trim(),
  })).filter((team) => team.id && team.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Fetch all matches for a competition + season. season is the YEAR that the
// competition's season STARTS (per football-data convention — e.g. 2025/26
// EPL season would be season=2025). For one-year tournaments like FIFA WC
// the season is just the tournament year (2026).
async function fetchMatches({ competitionId, season, apiKey, log }) {
  if (!apiKey) throw new Error('FOOTBALL_DATA_API_KEY not set');
  const log2 = log || (() => {});
  const params = new URLSearchParams();
  if (season) params.set('season', String(season));
  const qs = params.toString();
  const url = BASE + '/competitions/' + encodeURIComponent(competitionId) + '/matches'
    + (qs ? ('?' + qs) : '');
  log2('  football-data: GET ' + url);
  const json = await getJson(url, apiKey, { log: log2 });
  if (!json) return [];
  const matches = Array.isArray(json.matches) ? json.matches : [];
  log2('  football-data: ' + matches.length + ' matches returned');
  return matches;
}

// Fetch one club's fixtures across every competition visible to the API key.
// The team subresource is the important distinction from fetchMatches above:
// a Manchester United catalog must include league, domestic cup, European,
// and friendly fixtures rather than being tied to one competition ID.
function buildTeamMatchesUrl({ teamId, dateFrom, dateTo, limit }) {
  const params = new URLSearchParams();
  if (dateFrom) params.set('dateFrom', String(dateFrom));
  if (dateTo) params.set('dateTo', String(dateTo));
  params.set('limit', String(limit || 500));
  return BASE + '/teams/' + encodeURIComponent(teamId) + '/matches?' + params.toString();
}

async function fetchTeamMatches({ teamId, dateFrom, dateTo, apiKey, log }) {
  if (!apiKey) throw new Error('FOOTBALL_DATA_API_KEY not set');
  if (!teamId) throw new Error('football-data teamId not set');
  const log2 = log || (() => {});
  const url = buildTeamMatchesUrl({ teamId, dateFrom, dateTo, limit: 500 });
  log2('  football-data: GET ' + url);
  const json = await getJson(url, apiKey, { log: log2 });
  if (!json) return [];
  const matches = Array.isArray(json.matches) ? json.matches : [];
  log2('  football-data: ' + matches.length + ' team matches returned');
  return matches;
}

// Wrapper used by scripts/refresh.js. Mirrors the contract of tsdb.fetchAll:
// pulls events for each season the addon's eventWindow cares about.
async function fetchAll({ competitionId, seasons, apiKey, log }) {
  const out = [];
  for (const s of seasons) {
    try {
      const m = await fetchMatches({ competitionId, season: s, apiKey, log });
      out.push(...m);
    } catch (err) {
      (log || console.error)('  football-data season ' + s + ' failed: ' + err.message);
    }
  }
  return out;
}

module.exports = {
  lookupCompetition,
  fetchCompetitionTeams,
  fetchMatches,
  fetchTeamMatches,
  buildTeamMatchesUrl,
  fetchAll,
};
