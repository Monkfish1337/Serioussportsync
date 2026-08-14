// 0.35.0 — User-added promotion store.
//
// Lets the admin add new sports (NFL, NBA, MLB, NHL, soccer leagues, etc.)
// through the /admin/promotions UI without touching code. Stored entries are
// turned into full promotion objects at load time via the generic TSDB
// promotion factory in lib/promotions.js (see createGenericPromotion).
//
// Scope intentionally limited: this only supports TSDB-backed promotions
// with name+year matching. Promotions with bespoke logic (UFC PPV numbers,
// F1 sessions, MotoGP rounds, WWE editions, etc.) stay in code.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = (config && config.customPromotionsFile) || './data/custom-promotions.json';
const VERSION = 1;

const ID_RE = /^[a-z0-9_-]{2,30}$/;
const VALID_POSTER_SHAPES = ['landscape', 'square', 'poster'];

function emptyState() {
  return { version: VERSION, promotions: [], updatedAt: null };
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return emptyState();
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.promotions)) return emptyState();
    return data;
  } catch (err) {
    console.error('[custom-promotions] load failed: ' + err.message);
    return emptyState();
  }
}

function save(state) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const toWrite = {
    version: VERSION,
    promotions: (state && Array.isArray(state.promotions)) ? state.promotions : [],
    updatedAt: new Date().toISOString(),
  };
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function list() {
  return load().promotions.slice();
}

function findById(id) {
  if (!id) return null;
  return load().promotions.find((p) => p.id === id) || null;
}

const VALID_SOURCES = ['tsdb', 'football-data', 'tmdb'];

function validateSpec(spec, existingIds) {
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'spec must be an object' };

  const id = String(spec.id || '').trim();
  if (!ID_RE.test(id)) {
    return { ok: false, error: 'id must be 2-30 chars [a-z0-9_-]' };
  }
  if (existingIds && existingIds.has && existingIds.has(id)) {
    return { ok: false, error: 'id "' + id + '" already used by another promotion' };
  }

  const name = String(spec.name || '').trim();
  if (!name || name.length > 64) {
    return { ok: false, error: 'name required (max 64 chars)' };
  }

  const idPrefix = String(spec.idPrefix || id).trim();
  if (!ID_RE.test(idPrefix)) {
    return { ok: false, error: 'idPrefix must be 2-30 chars [a-z0-9_-]' };
  }

  const source = String(spec.source || 'tsdb').trim();
  if (VALID_SOURCES.indexOf(source) === -1) {
    return { ok: false, error: 'source must be one of: ' + VALID_SOURCES.join(', ') };
  }

  if (source === 'tsdb') {
    const leagueId = String(spec.leagueId || '').trim();
    if (!/^\d+$/.test(leagueId)) {
      return { ok: false, error: 'leagueId must be numeric (TSDB league id)' };
    }
  } else if (source === 'football-data') {
    const competitionId = String(spec.competitionId || '').trim();
    if (!competitionId) {
      return { ok: false, error: 'competitionId required (e.g. 2000 for FIFA WC, "PL" for English Premier League)' };
    }
    if (!/^(\d+|[A-Za-z0-9]{2,4})$/.test(competitionId)) {
      return { ok: false, error: 'competitionId must be numeric or 2-4 char code' };
    }
  } else if (source === 'tmdb') {
    // 0.42.13 — TMDB TV show. Used for episodic sports shows like Match of the
    // Day where each episode has a real air_date that matches DARKSPORT-style
    // "Show Name YYYY MM DD" release filenames.
    const tvId = String(spec.tvId || '').trim();
    if (!/^\d+$/.test(tvId)) {
      return { ok: false, error: 'tvId must be numeric (TMDB TV show id, e.g. 224 for Match of the Day)' };
    }
  }

  const posterShape = String(spec.posterShape || 'landscape').trim();
  if (VALID_POSTER_SHAPES.indexOf(posterShape) === -1) {
    return { ok: false, error: 'posterShape must be one of: ' + VALID_POSTER_SHAPES.join(', ') };
  }

  const templates = Array.isArray(spec.searchTitleTemplates) ? spec.searchTitleTemplates : [];
  const cleanTemplates = templates.map((t) => String(t || '').trim()).filter(Boolean);
  if (cleanTemplates.length === 0) {
    return { ok: false, error: 'searchTitleTemplates: at least one template required' };
  }
  for (const t of cleanTemplates) {
    if (t.length > 200) return { ok: false, error: 'searchTitleTemplate too long (>200): ' + t.slice(0, 40) + '...' };
  }

  const keywords = Array.isArray(spec.relevanceKeywords) ? spec.relevanceKeywords : [];
  const cleanKeywords = keywords.map((k) => String(k || '').toLowerCase().trim()).filter(Boolean);
  if (cleanKeywords.length === 0) {
    return { ok: false, error: 'relevanceKeywords: at least one keyword required' };
  }

  // 0.40.0 — optional football alias fields
  if (spec.teamAliasPreset !== undefined && spec.teamAliasPreset !== '') {
    const presetVal = String(spec.teamAliasPreset || '').toLowerCase().trim();
    let aliasPresets;
    try { aliasPresets = require('./team-alias-presets'); } catch (_) { aliasPresets = null; }
    const known = aliasPresets ? aliasPresets.listPresetNames() : [];
    const accepted = known.concat(['premier-league', 'premier_league', 'premierleague',
                                    'champions-league', 'champions_league', 'championsleague', 'uefa']);
    if (accepted.indexOf(presetVal) === -1) {
      return { ok: false, error: 'teamAliasPreset must be one of: ' + known.join(', ') + ' (or leave blank)' };
    }
  }
  if (spec.teamAliases !== undefined && spec.teamAliases !== null) {
    if (typeof spec.teamAliases !== 'object' || Array.isArray(spec.teamAliases)) {
      return { ok: false, error: 'teamAliases must be a JSON object mapping "Canonical Name": ["alias1","alias2"]' };
    }
    for (const [k, v] of Object.entries(spec.teamAliases)) {
      if (!Array.isArray(v)) {
        return { ok: false, error: 'teamAliases["' + k + '"] must be an array of strings' };
      }
    }
  }
  if (spec.leagueAliases !== undefined && spec.leagueAliases !== null) {
    if (!Array.isArray(spec.leagueAliases)) {
      return { ok: false, error: 'leagueAliases must be an array of strings' };
    }
  }

  // 0.42.0 — pipeline toggles
  if (spec.disabledPipelines !== undefined && spec.disabledPipelines !== null) {
    if (!Array.isArray(spec.disabledPipelines)) {
      return { ok: false, error: 'disabledPipelines must be an array of strings' };
    }
    const validPipelines = ['torbox', 'uu', 'newsnab', 'easynews'];
    for (const v of spec.disabledPipelines) {
      if (validPipelines.indexOf(String(v).toLowerCase().trim()) === -1) {
        return { ok: false, error: 'disabledPipelines entries must be one of: ' + validPipelines.join(', ') };
      }
    }
  }

  // 0.42.5 — date-strict matching for football-style promotions
  if (spec.requireDateInTitle !== undefined && spec.requireDateInTitle !== null) {
    if (typeof spec.requireDateInTitle !== 'boolean') {
      return { ok: false, error: 'requireDateInTitle must be true or false' };
    }
  }

  return { ok: true };
}

function normaliseSpec(spec) {
  const source = String(spec.source || 'tsdb').trim();
  const out = {
    id: String(spec.id || '').trim(),
    name: String(spec.name || '').trim(),
    idPrefix: String(spec.idPrefix || spec.id || '').trim(),
    source,
    poster: String(spec.poster || '').trim(),
    fanart: String(spec.fanart || '').trim(),
    logo:   String(spec.logo   || '').trim(),
    posterShape: String(spec.posterShape || 'landscape').trim(),
    searchTitleTemplates: Array.isArray(spec.searchTitleTemplates)
      ? spec.searchTitleTemplates.map((t) => String(t || '').trim()).filter(Boolean)
      : [],
    relevanceKeywords: dedupeLower(
      Array.isArray(spec.relevanceKeywords) ? spec.relevanceKeywords : []
    ),
    teamAliasPreset: String(spec.teamAliasPreset || '').toLowerCase().trim() || undefined,
    teamAliases: (spec.teamAliases && typeof spec.teamAliases === 'object' && !Array.isArray(spec.teamAliases))
      ? spec.teamAliases : undefined,
    leagueAliases: Array.isArray(spec.leagueAliases)
      ? spec.leagueAliases.map((s) => String(s || '').trim()).filter(Boolean)
      : undefined,
    disabledPipelines: Array.isArray(spec.disabledPipelines)
      ? spec.disabledPipelines.map((s) => String(s || '').toLowerCase().trim()).filter(Boolean)
      : undefined,
    // 0.42.5 — date-strict matching. undefined = source default (football-data → true, tsdb → false).
    requireDateInTitle: (typeof spec.requireDateInTitle === 'boolean')
      ? spec.requireDateInTitle
      : undefined,
    createdAt: spec.createdAt || new Date().toISOString(),
  };
  if (source === 'tsdb') {
    out.leagueId = String(spec.leagueId || '').trim();
  } else if (source === 'football-data') {
    out.competitionId = String(spec.competitionId || '').trim();
  } else if (source === 'tmdb') {
    out.tvId = String(spec.tvId || '').trim();
  }
  return out;
}

function dedupeLower(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const lc = String(v || '').toLowerCase().trim();
    if (lc && !seen.has(lc)) { seen.add(lc); out.push(lc); }
  }
  return out;
}

function add(spec, existingIds) {
  const v = validateSpec(spec, existingIds);
  if (!v.ok) throw new Error(v.error);
  const state = load();
  state.promotions.push(normaliseSpec(spec));
  save(state);
  return findById(spec.id);
}

function update(id, patch, existingIdsExcludingThis) {
  const state = load();
  const idx = state.promotions.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error('custom promotion not found: ' + id);
  const merged = Object.assign({}, state.promotions[idx], patch || {});
  merged.id = id;
  const v = validateSpec(merged, existingIdsExcludingThis);
  if (!v.ok) throw new Error(v.error);
  state.promotions[idx] = normaliseSpec(merged);
  save(state);
  return state.promotions[idx];
}

function remove(id) {
  const state = load();
  const before = state.promotions.length;
  state.promotions = state.promotions.filter((p) => p.id !== id);
  if (state.promotions.length === before) return false;
  save(state);
  return true;
}

module.exports = {
  load,
  save,
  list,
  findById,
  validateSpec,
  normaliseSpec,
  add,
  update,
  remove,
  VALID_POSTER_SHAPES,
};
