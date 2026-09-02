'use strict';

// Official UEFA match feed used by uefa.com. It is public and requires no
// account or API key. Keep this adapter deliberately small: SSS only needs
// fixtures and stable team identity, not live statistics or line-ups.

const fetch = require('node-fetch');
const httpAgent = require('../http-agent');

const BASE = 'https://match.uefa.com/v5/matches';
const REQUEST_TIMEOUT_MS = 20000;
const PAGE_SIZE = 500;
const MAX_PAGES = 4;

function seasonsForRange(dateFrom, dateTo) {
  const start = new Date(String(dateFrom) + 'T00:00:00Z');
  const end = new Date(String(dateTo) + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const out = new Set();
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  while (cursor <= end) {
    // UEFA identifies a split season by its final year: July 2026 belongs to
    // the 2026/27 competition and therefore seasonYear=2027.
    out.add(String(cursor.getUTCMonth() >= 6 ? cursor.getUTCFullYear() + 1 : cursor.getUTCFullYear()));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return Array.from(out).sort();
}

async function fetchSeason({ competitionId, seasonYear, log }) {
  const log2 = log || (() => {});
  const output = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      competitionId: String(competitionId),
      seasonYear: String(seasonYear),
      offset: String(page * PAGE_SIZE),
      limit: String(PAGE_SIZE),
      order: 'ASC',
    });
    const url = BASE + '?' + params.toString();
    log2('  uefa: GET official matches competition ' + competitionId + ', season ' + seasonYear
      + ', page ' + (page + 1));
    let response;
    try {
      response = await fetch(url, httpAgent.fetchOpts({
        headers: { Accept: 'application/json', 'User-Agent': 'serioussportsync/0.76.1' },
        timeout: REQUEST_TIMEOUT_MS,
      }, url));
    } catch (error) {
      throw new Error('UEFA network error: ' + error.message);
    }
    if (!response.ok) throw new Error('UEFA HTTP ' + response.status + ' ' + response.statusText);
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error('UEFA returned an unexpected response');
    output.push(...body);
    if (body.length < PAGE_SIZE) break;
  }
  log2('  uefa: ' + output.length + ' official fixtures returned for season ' + seasonYear);
  return output;
}

async function fetchAll({ competitionId, seasons, dateFrom, dateTo, log }) {
  const output = [];
  const seen = new Set();
  const failures = [];
  for (const seasonYear of seasons || []) {
    let rows;
    try {
      rows = await fetchSeason({ competitionId, seasonYear, log });
    } catch (error) {
      failures.push(error);
      (log || (() => {}))('  uefa season ' + seasonYear + ' failed: ' + error.message);
      continue;
    }
    for (const row of rows) {
      const date = row && row.kickOffTime && row.kickOffTime.date;
      if (dateFrom && date && date < dateFrom) continue;
      if (dateTo && date && date > dateTo) continue;
      const key = row && row.id != null ? String(row.id) : JSON.stringify(row);
      if (!seen.has(key)) { seen.add(key); output.push(row); }
    }
  }
  if (failures.length && failures.length === (seasons || []).length) throw failures[0];
  return output;
}

module.exports = { BASE, seasonsForRange, fetchSeason, fetchAll };
