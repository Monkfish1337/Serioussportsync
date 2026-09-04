'use strict';

// "Select your team" — the Configure-page wizard.
//
// The stated goal: a user picks their Premier League club, NFL, NBA and MLB
// team, and the catalogs are produced with no further configuration. Nothing
// architectural was missing for this; what was missing was a chooser and the
// glue that turns a pick into a working promotion.
//
// Two shapes, because the providers differ and the difference matters:
//
//   • A football club gets a TEAM-SCOPED FEED. football-data's
//     /teams/{id}/matches returns that club's fixtures from every competition
//     the key covers, which is why the shipped Man United promotion spans the
//     league, both domestic cups and Europe. That is the user's actual goal —
//     "results for matches in all competitions" — so it would be wrong to
//     substitute a league feed filtered to one club.
//
//   • A US-sport team gets a LEAGUE FEED, NARROWED. ESPN and statsapi have no
//     per-team schedule endpoint here, and the league call is a single request
//     either way, so the promotion fetches the league and keeps its own club's
//     fixtures via `teamFilter`.
//
// Team lists are cached: they change once a season, and a chooser that costs a
// provider call per page view would spend an API budget on nothing.

const settings = require('./settings');

let footballData = null;
try { footballData = require('./sources/football-data'); } catch (_) { footballData = null; }
let espn = null;
try { espn = require('./sources/espn'); } catch (_) { espn = null; }

// What the wizard offers. Each entry names the provider that lists its teams
// and the promotion shape a pick produces.
const CHOOSERS = Object.freeze([
  {
    key: 'epl',
    label: 'Premier League club',
    provider: 'football-data',
    competitionId: 'PL',
    // The curated Premier League alias table, which knows the forms a generic
    // deriver misses — Wolves for Wolverhampton Wanderers, Spurs for Tottenham.
    // Without it a wizard-created club matches noticeably worse than the
    // hand-built promotion it replaces.
    teamAliasPreset: 'epl',
    // A club feed spans every competition the key covers, so the promotion is
    // named for the club rather than the league it was picked from.
    describe: (team) => team.name,
    hint: 'Fixtures from every competition your football-data key covers — league, cups and Europe.',
  },
  { key: 'nfl', label: 'NFL team', provider: 'espn', league: 'nfl', describe: (team) => team.name, hint: 'Regular season and playoffs.' },
  { key: 'nba', label: 'NBA team', provider: 'espn', league: 'nba', describe: (team) => team.name, hint: 'Regular season and playoffs.' },
  { key: 'mlb', label: 'MLB team', provider: 'espn', league: 'mlb', describe: (team) => team.name, hint: 'Regular season and postseason.' },
]);

const CACHE_MS = 12 * 60 * 60 * 1000;
const cache = new Map();

function chooser(key) {
  return CHOOSERS.find((entry) => entry.key === String(key || '').trim()) || null;
}

function cached(key) {
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.at) < CACHE_MS) return hit.teams;
  return null;
}

function remember(key, teams) {
  cache.set(key, { at: Date.now(), teams });
  return teams;
}

function clearCache() { cache.clear(); }

// The teams a chooser offers. Returns [] with a reason rather than throwing:
// one unconfigured provider must not take the whole wizard down.
async function teamsFor(key, opts) {
  const options = opts || {};
  const entry = chooser(key);
  if (!entry) return { ok: false, error: 'Unknown chooser: ' + key, teams: [] };
  const hit = options.force ? null : cached(entry.key);
  if (hit) return { ok: true, teams: hit, cached: true };

  try {
    if (entry.provider === 'football-data') {
      const apiKey = options.footballDataApiKey || settings.getFootballData().apiKey;
      if (!apiKey) {
        return { ok: false, teams: [], error: 'Add a football-data.org API key in Admin → Sources to choose a club.' };
      }
      const client = options.footballData || footballData;
      if (!client) return { ok: false, teams: [], error: 'football-data source unavailable' };
      const teams = await client.fetchCompetitionTeams({
        competitionId: entry.competitionId, apiKey, log: options.log,
      });
      return { ok: true, teams: remember(entry.key, teams) };
    }
    const client = options.espn || espn;
    if (!client) return { ok: false, teams: [], error: 'ESPN source unavailable' };
    const teams = await client.fetchTeams({ league: entry.league, log: options.log });
    return { ok: true, teams: remember(entry.key, teams) };
  } catch (error) {
    return { ok: false, teams: [], error: String(error && error.message ? error.message : error) };
  }
}

// Promotion ids are derived from the pick so choosing the same team twice
// updates rather than duplicates.
function promotionIdFor(key, team) {
  const slug = String(team && (team.abbreviation || team.name) || '')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  return (key + '-' + (slug || 'team')).slice(0, 40);
}

// The promotion a pick produces, as a spec for lib/custom-promotions.
function specFor(key, team) {
  const entry = chooser(key);
  if (!entry) throw new Error('Unknown chooser: ' + key);
  if (!team || !team.id || !team.name) throw new Error('A team with an id and a name is required');

  const id = promotionIdFor(entry.key, team);
  const names = Array.isArray(team.names) && team.names.length
    ? team.names
    : [team.name, team.fullName, team.abbreviation].filter(Boolean);
  const base = {
    id,
    idPrefix: id,
    name: entry.describe(team),
    posterShape: 'landscape',
    poster: team.crest || '',
    fanart: team.crest || '',
    promotionAliases: Array.from(new Set(names)).slice(0, 8),
    searchTitleTemplates: [
      '{name} {date_dotted}',
      '{name} {date_spaced}',
      '{name}',
    ],
    // The club's own names are the relevance signal; a league keyword would
    // exclude the cup and European fixtures that are the point of this.
    relevanceKeywords: Array.from(new Set(names.map((value) => value.toLowerCase()))).slice(0, 8),
    exclusionKeywords: ['highlights', 'preview', 'review', 'match of the day'],
    requireDateInTitle: true,
  };

  if (entry.teamAliasPreset) base.teamAliasPreset = entry.teamAliasPreset;

  if (entry.provider === 'football-data') {
    // Already team-scoped upstream — no filter needed, and adding one would
    // only risk excluding a fixture the feed correctly returned.
    return Object.assign(base, { source: 'football-data', teamId: String(team.id) });
  }
  return Object.assign(base, {
    source: 'espn',
    league: entry.league,
    teamFilter: { id: String(team.id), names: Array.from(new Set(names)).slice(0, 12) },
  });
}

module.exports = { CHOOSERS, chooser, teamsFor, specFor, promotionIdFor, clearCache, CACHE_MS };
