'use strict';

// API-Football (API-Sports) schedule adapter.
//
// Authentication: x-apisports-key header
// API docs: https://www.api-football.com/documentation-v3
//
// SSS intentionally consumes only reference/schedule data here. Stream
// discovery remains independent and is handled by the configured pipelines.

const fetch = require('node-fetch');
const httpAgent = require('../http-agent');

const BASE = 'https://v3.football.api-sports.io';
const REQUEST_TIMEOUT_MS = 20000;

function queryString(params) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      out.set(key, String(value).trim());
    }
  }
  return out.toString();
}

function providerError(body) {
  if (!body || !body.errors) return '';
  if (Array.isArray(body.errors)) return body.errors.map(String).filter(Boolean).join('; ');
  if (typeof body.errors === 'object') {
    return Object.entries(body.errors).map(([key, value]) => key + ': ' + value).join('; ');
  }
  return String(body.errors || '');
}

async function get(pathname, params, opts) {
  opts = opts || {};
  const apiKey = String(opts.apiKey || '').trim();
  const log = opts.log || (() => {});
  if (!apiKey) throw new Error('API_FOOTBALL_API_KEY not set');
  const qs = queryString(params);
  const url = BASE + pathname + (qs ? '?' + qs : '');
  log('  api-football: GET ' + BASE + pathname + (qs ? '?[parameters]' : ''));
  let response;
  try {
    response = await fetch(url, httpAgent.fetchOpts({
      headers: {
        'x-apisports-key': apiKey,
        Accept: 'application/json',
        'User-Agent': 'serioussportsync/0.76',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, url));
  } catch (error) {
    throw new Error('api-football network error: ' + error.message);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('api-football authentication failed; check the API key');
  }
  if (response.status === 429) {
    throw new Error('api-football request quota exceeded; try again after the provider resets it');
  }
  if (!response.ok) throw new Error('api-football HTTP ' + response.status + ' ' + response.statusText);
  const body = await response.json();
  const error = providerError(body);
  if (error) throw new Error('api-football: ' + error);
  return body;
}

async function lookupLeague({ leagueId, apiKey, log }) {
  const body = await get('/leagues', { id: leagueId }, { apiKey, log });
  return Array.isArray(body.response) ? (body.response[0] || null) : null;
}

async function fetchFixtures({ leagueId, season, dateFrom, dateTo, apiKey, log }) {
  const body = await get('/fixtures', {
    league: leagueId,
    season,
    from: dateFrom,
    to: dateTo,
    timezone: 'UTC',
  }, { apiKey, log });
  const fixtures = Array.isArray(body.response) ? body.response : [];
  (log || (() => {}))('  api-football: ' + fixtures.length + ' fixtures returned for season ' + season);
  return fixtures;
}

async function fetchAll({ leagueId, seasons, dateFrom, dateTo, apiKey, log }) {
  const out = [];
  const seen = new Set();
  const failures = [];
  for (const season of seasons || []) {
    let fixtures;
    try {
      fixtures = await fetchFixtures({ leagueId, season, dateFrom, dateTo, apiKey, log });
    } catch (error) {
      failures.push(error);
      (log || (() => {}))('  api-football season ' + season + ' failed: ' + error.message);
      continue;
    }
    for (const row of fixtures) {
      const id = row && row.fixture && row.fixture.id;
      const key = id == null ? JSON.stringify(row) : String(id);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(row);
      }
    }
  }
  if (failures.length && failures.length === (seasons || []).length) throw failures[0];
  return out;
}

// API-Football uses the starting year for split European seasons and the
// calendar year for competitions such as MLS. Include both interpretations
// touched by the window; duplicate fixtures are removed after retrieval.
function seasonsForRange(dateFrom, dateTo) {
  const start = new Date(String(dateFrom) + 'T00:00:00Z');
  const end = new Date(String(dateTo) + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const out = new Set();
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  while (cursor <= end) {
    out.add(String(cursor.getUTCFullYear()));
    out.add(String(cursor.getUTCMonth() >= 6 ? cursor.getUTCFullYear() : cursor.getUTCFullYear() - 1));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return Array.from(out).sort();
}

module.exports = {
  BASE,
  lookupLeague,
  fetchFixtures,
  fetchAll,
  seasonsForRange,
  _providerError: providerError,
};
