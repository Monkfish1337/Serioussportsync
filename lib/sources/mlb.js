'use strict';

// Official MLB schedule adapter. The public statsapi.mlb.com schedule feed
// provides game IDs, dates, teams, venues and status without an API key.
const fetch = require('node-fetch');

const BASE = 'https://statsapi.mlb.com/api/v1/schedule';
const MAX_GAMES = 5000;

function toRaw(game) {
  if (!game || !game.gamePk || !game.officialDate) return null;
  const away = game.teams && game.teams.away && game.teams.away.team;
  const home = game.teams && game.teams.home && game.teams.home.team;
  if (!away || !away.name || !home || !home.name) return null;
  const iso = String(game.gameDate || '');
  const timeMatch = iso.match(/T(\d{2}:\d{2}:\d{2})/);
  const venue = game.venue && game.venue.name;
  const status = game.status && (game.status.detailedState || game.status.abstractGameState);
  return {
    sourceId: String(game.gamePk),
    name: away.name + ' vs ' + home.name,
    date: String(game.officialDate),
    time: timeMatch ? timeMatch[1] : null,
    timestamp: iso || null,
    venue: venue || null,
    city: null,
    country: 'United States',
    poster: null,
    thumb: null,
    fanart: null,
    banner: null,
    description: [status, venue].filter(Boolean).join(' · '),
    source: { type: 'mlb', gamePk: String(game.gamePk) },
  };
}

async function fetchAll(opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const dateFrom = String(opts.dateFrom || '').trim();
  const dateTo = String(opts.dateTo || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    throw new Error('mlb: dateFrom and dateTo must be YYYY-MM-DD');
  }
  const url = BASE + '?sportId=1&hydrate=team,venue&startDate=' + encodeURIComponent(dateFrom)
    + '&endDate=' + encodeURIComponent(dateTo);
  log('-> mlb: schedule ' + dateFrom + ' to ' + dateTo);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SeriousSportSync/0.58', Accept: 'application/json' },
    timeout: 20000,
    size: 8 * 1024 * 1024,
  });
  if (!res.ok) throw new Error('mlb HTTP ' + res.status);
  const json = await res.json();
  const out = [];
  for (const date of (json.dates || [])) {
    for (const game of (date.games || [])) {
      const raw = toRaw(game);
      if (raw) out.push(raw);
      if (out.length >= MAX_GAMES) return out;
    }
  }
  return out;
}

module.exports = { fetchAll, toRaw };
