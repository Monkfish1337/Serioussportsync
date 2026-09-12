'use strict';

// Official MLB schedule adapter. The public statsapi.mlb.com schedule feed
// provides game IDs, dates, teams, venues and status without an API key.
const fetch = require('node-fetch');

const BASE = 'https://statsapi.mlb.com/api/v1/schedule';
const MAX_GAMES = 5000;

// https://midfield.mlbstatic.com/v1/team/110/spots/500 -> 200 image/png.
// 500 is a size the CDN serves rather than an arbitrary number; it is large
// enough not to look soft on a meta page and small enough (~15KB) to be free.
const LOGO_SIZE = 500;
function teamLogo(teamId) {
  const id = teamId == null ? '' : String(teamId).trim();
  if (!/^\d+$/.test(id)) return null;
  return 'https://midfield.mlbstatic.com/v1/team/' + id + '/spots/' + LOGO_SIZE;
}

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
    // Team logos, the same shape ESPN already supplies.
    //
    // This adapter returned null for all four artwork fields, so every MLB
    // event rendered with nothing behind it while the ESPN-backed promotions
    // showed team logos. The schedule feed carries team ids, and MLB serves
    // logos from a stable public CDN keyed by exactly that id, so no extra
    // request and no API key is involved.
    //
    // The PNG spots endpoint rather than /team-logos/<id>.svg: both return
    // 200, but clients that will not render SVG would show nothing at all,
    // which is the bug being fixed.
    poster: teamLogo(away.id) || teamLogo(home.id),
    thumb: teamLogo(home.id) || teamLogo(away.id),
    fanart: null,
    banner: null,
    description: [status, venue].filter(Boolean).join(' · '),
    // Structured sides, as ESPN and football-data already supply. Team-aware
    // matching prefers these over splitting the fixture title, and a per-team
    // promotion needs them to recognise its own club.
    teamNames: {
      home: [home.name, home.teamName, home.abbreviation, home.clubName]
        .map((value) => String(value || '').trim()).filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index),
      away: [away.name, away.teamName, away.abbreviation, away.clubName]
        .map((value) => String(value || '').trim()).filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index),
    },
    source: {
      type: 'mlb', gamePk: String(game.gamePk),
      homeTeamId: home.id == null ? null : String(home.id),
      awayTeamId: away.id == null ? null : String(away.id),
    },
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
