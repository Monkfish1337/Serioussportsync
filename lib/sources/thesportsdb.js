const fetch = require('node-fetch');
const config = require('../../config');

const BASE = (key) => 'https://www.thesportsdb.com/api/v1/json/' + key;

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getJson(url, options) {
  const opts = options || {};
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : 4;
  const log = opts.log || (() => {});
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'serioussportsync/0.4' } });
    } catch (err) {
      if (attempt < maxRetries) {
        const wait = 5000 * (attempt + 1);
        log('    network error, retry in ' + wait + 'ms: ' + err.message);
        await delay(wait); continue;
      }
      throw err;
    }
    if (res.status === 429) {
      if (attempt >= maxRetries) throw new Error('HTTP 429 after ' + maxRetries + ' retries: ' + url);
      const ra = parseInt(res.headers.get('retry-after'), 10);
      const wait = ra && !Number.isNaN(ra) ? ra * 1000 : 65000 + 30000 * attempt;
      log('    429 rate-limited, sleeping ' + Math.round(wait / 1000) + 's');
      await delay(wait); continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText + ' for ' + url);
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch (err) { throw new Error('Bad JSON from ' + url + ': ' + err.message); }
  }
}

// All endpoints take an explicit leagueId so multiple promotions can share
// this client. Falls back to config.tsdb.leagueId for backward compat.
function lid(leagueId) { return leagueId || config.tsdb.leagueId; }

async function fetchUpcoming(leagueId, log) {
  const url = BASE(config.tsdb.apiKey) + '/eventsnextleague.php?id=' + lid(leagueId);
  return (await getJson(url, { log })).events || [];
}
async function fetchRecent(leagueId, log) {
  const url = BASE(config.tsdb.apiKey) + '/eventspastleague.php?id=' + lid(leagueId);
  return (await getJson(url, { log })).events || [];
}
async function fetchSeasonBulk(leagueId, season, log) {
  const url = BASE(config.tsdb.apiKey) + '/eventsseason.php?id=' + lid(leagueId) + '&s=' + season;
  return (await getJson(url, { log })).events || [];
}
async function fetchRound(leagueId, season, round, log) {
  const url = BASE(config.tsdb.apiKey) + '/eventsround.php?id=' + lid(leagueId) + '&r=' + round + '&s=' + season;
  return (await getJson(url, { log })).events || [];
}

async function fetchSeasonAllRounds(leagueId, season, log) {
  log = log || (() => {});
  const collected = new Map();
  let consecutiveEmpty = 0;
  for (let r = 1; r <= config.tsdb.maxRoundsPerSeason; r++) {
    let events = null, errored = false;
    try { events = await fetchRound(leagueId, season, r, log); }
    catch (err) { log('  round ' + r + ': error ' + err.message); errored = true; }
    if (errored) { await delay(config.tsdb.requestDelayMs * 2); continue; }
    if (events.length === 0) {
      consecutiveEmpty++;
      log('  round ' + r + ': empty (' + consecutiveEmpty + '/' + config.tsdb.emptyRoundStopAfter + ')');
      if (consecutiveEmpty >= config.tsdb.emptyRoundStopAfter) {
        log('  stopping season ' + season + ' at round ' + r); break;
      }
    } else {
      consecutiveEmpty = 0;
      for (const ev of events) if (ev.idEvent) collected.set(ev.idEvent, ev);
      const e = events[0];
      log('  round ' + r + ': ' + e.dateEvent + ' | ' + e.strEvent);
    }
    await delay(config.tsdb.requestDelayMs);
  }
  return Array.from(collected.values());
}

// New options-object signature: fetchAll({ leagueId, seasons, log })
async function fetchAll(opts) {
  opts = opts || {};
  const leagueId = opts.leagueId || config.tsdb.leagueId;
  const seasons = opts.seasons || config.tsdb.seasons;
  const log = opts.log || (() => {});
  const dedup = new Map();

  log('-> upcoming (eventsnextleague)');
  try { for (const e of await fetchUpcoming(leagueId, log)) if (e.idEvent) dedup.set(e.idEvent, e); }
  catch (err) { log('  upcoming failed: ' + err.message); }
  await delay(config.tsdb.requestDelayMs);

  log('-> recent (eventspastleague)');
  try { for (const e of await fetchRecent(leagueId, log)) if (e.idEvent) dedup.set(e.idEvent, e); }
  catch (err) { log('  recent failed: ' + err.message); }
  await delay(config.tsdb.requestDelayMs);

  for (const season of seasons) {
    log('-> season ' + season + ' bulk');
    try {
      for (const e of await fetchSeasonBulk(leagueId, season, log)) if (e.idEvent) dedup.set(e.idEvent, e);
    } catch (err) { log('  bulk season ' + season + ' failed: ' + err.message); }
    await delay(config.tsdb.requestDelayMs);

    log('-> season ' + season + ' per-round');
    const rounds = await fetchSeasonAllRounds(leagueId, season, log);
    for (const e of rounds) if (e.idEvent) dedup.set(e.idEvent, e);
  }

  return Array.from(dedup.values());
}

module.exports = {
  fetchUpcoming, fetchRecent, fetchSeasonBulk, fetchRound,
  fetchSeasonAllRounds, fetchAll,
};
