'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const VERSION = 1;
const ID_RE = /^[a-z0-9_-]{2,50}$/;
const SYSTEM_SOURCES = Object.freeze([
  { id: 'tsdb-ufc', name: 'TheSportsDB · UFC', system: true, source: { type: 'thesportsdb', leagueId: '4443' } },
  { id: 'one-official', name: 'Official ONE Championship', system: true, source: { type: 'onefc' } },
  { id: 'tsdb-wwe', name: 'TheSportsDB · WWE', system: true, source: { type: 'thesportsdb', leagueId: '4444' } },
  { id: 'tsdb-aew', name: 'TheSportsDB · AEW', system: true, source: { type: 'thesportsdb', leagueId: '4563' } },
  { id: 'tsdb-f1', name: 'TheSportsDB · Formula 1', system: true, source: { type: 'thesportsdb', leagueId: '4370' } },
  { id: 'tsdb-boxing', name: 'TheSportsDB · Boxing', system: true, source: { type: 'thesportsdb', leagueId: '4445' } },
  { id: 'tsdb-motogp', name: 'TheSportsDB · MotoGP', system: true, source: { type: 'thesportsdb', leagueId: '4407' } },
  { id: 'tmdb-motd', name: 'TMDB · Match of the Day', system: true, source: { type: 'tmdb', tvIds: ['224', '3231'] } },
  { id: 'football-data-manutd', name: 'football-data.org · Man United', system: true, source: { type: 'football-data', teamId: '66' } },
]);
const SYSTEM_ASSIGNMENTS = Object.freeze({
  ufc: 'tsdb-ufc', one: 'one-official', wwe: 'tsdb-wwe', aew: 'tsdb-aew',
  f1: 'tsdb-f1', boxing: 'tsdb-boxing', motogp: 'tsdb-motogp',
  motd: 'tmdb-motd', manutd: 'football-data-manutd',
});

function filePath() {
  return config.metadataSourcesFile || './data/metadata-sources.json';
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function emptyState() { return { version: VERSION, sources: [], assignments: {}, updatedAt: null }; }

function load() {
  try {
    const file = filePath();
    if (!fs.existsSync(file)) return emptyState();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') return emptyState();
    return {
      version: VERSION,
      sources: Array.isArray(data.sources) ? data.sources : [],
      assignments: data.assignments && typeof data.assignments === 'object' ? data.assignments : {},
      updatedAt: data.updatedAt || null,
    };
  } catch (err) {
    console.error('[metadata-sources] load failed: ' + err.message);
    return emptyState();
  }
}

function save(state) {
  const file = filePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const value = {
    version: VERSION,
    sources: Array.isArray(state.sources) ? state.sources : [],
    assignments: state.assignments && typeof state.assignments === 'object' ? state.assignments : {},
    updatedAt: new Date().toISOString(),
  };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function list() {
  const state = load();
  const customIds = new Set(state.sources.map((item) => item && item.id));
  return SYSTEM_SOURCES.filter((item) => !customIds.has(item.id)).concat(state.sources).map(clone);
}

function find(id) { return list().find((item) => item.id === id) || null; }

function assignmentFor(promotionId) {
  const state = load();
  return state.assignments[promotionId] || SYSTEM_ASSIGNMENTS[promotionId] || null;
}

function resolve(promotionId, fallbackSource) {
  const sourceRef = assignmentFor(promotionId);
  const definition = sourceRef ? find(sourceRef) : null;
  return {
    sourceRef: definition ? sourceRef : null,
    source: clone(definition ? definition.source : fallbackSource),
  };
}

function assign(promotionId, sourceRef) {
  const promotion = String(promotionId || '').trim();
  const ref = String(sourceRef || '').trim();
  if (!ID_RE.test(promotion)) throw new Error('invalid promotion id');
  if (ref && !find(ref)) throw new Error('metadata source not found: ' + ref);
  const state = load();
  if (ref) state.assignments[promotion] = ref;
  else delete state.assignments[promotion];
  save(state);
  return assignmentFor(promotion);
}

function validateDefinition(input, opts) {
  opts = opts || {};
  const id = String(input.id || '').toLowerCase().trim();
  const name = String(input.name || '').trim();
  const type = String(input.type || '').trim();
  if (!ID_RE.test(id)) return { ok: false, error: 'Source ID must be 2-50 lowercase characters [a-z0-9_-]' };
  if (!name || name.length > 80) return { ok: false, error: 'Source name is required (max 80 characters)' };
  if (!opts.allowExistingId && find(id)) return { ok: false, error: 'Metadata source ID already exists: ' + id };
  let source;
  if (type === 'thesportsdb') {
    const leagueId = String(input.leagueId || '').trim();
    if (!/^\d+$/.test(leagueId)) return { ok: false, error: 'TheSportsDB league ID must be numeric' };
    source = { type, leagueId };
  } else if (type === 'football-data') {
    const teamId = String(input.teamId || '').trim();
    const competitionId = String(input.competitionId || '').trim();
    if (!teamId && !competitionId) return { ok: false, error: 'Enter a football-data team or competition ID' };
    if (teamId && !/^\d+$/.test(teamId)) return { ok: false, error: 'football-data team ID must be numeric' };
    if (competitionId && !/^(\d+|[A-Za-z0-9]{2,4})$/.test(competitionId)) return { ok: false, error: 'Invalid football-data competition ID/code' };
    source = teamId ? { type, teamId } : { type, competitionId };
  } else if (type === 'tmdb') {
    const tvIds = String(input.tvIds || '').split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
    if (!tvIds.length || tvIds.some((v) => !/^\d+$/.test(v))) return { ok: false, error: 'TMDB TV IDs must be numeric and comma-separated' };
    source = tvIds.length === 1 ? { type, tvId: tvIds[0] } : { type, tvIds };
  } else if (type === 'onefc') {
    source = { type };
  } else if (type === 'mlb') {
    source = { type };
  } else {
    return { ok: false, error: 'Unsupported metadata adapter: ' + type };
  }
  return { ok: true, definition: { id, name, system: false, source } };
}

function add(input) {
  const verdict = validateDefinition(input || {});
  if (!verdict.ok) throw new Error(verdict.error);
  const state = load();
  state.sources.push(verdict.definition);
  save(state);
  return clone(verdict.definition);
}

// Used to roll back a wizard-created source when promotion validation fails.
// System definitions are immutable, and assignments referencing a removed
// custom source are cleared so the state cannot retain a dangling reference.
function removeCustom(id) {
  const sourceId = String(id || '').trim();
  if (!sourceId || SYSTEM_SOURCES.some((item) => item.id === sourceId)) return false;
  const state = load();
  const before = state.sources.length;
  state.sources = state.sources.filter((item) => item && item.id !== sourceId);
  if (state.sources.length === before) return false;
  for (const [promotionId, sourceRef] of Object.entries(state.assignments)) {
    if (sourceRef === sourceId) delete state.assignments[promotionId];
  }
  save(state);
  return true;
}

module.exports = {
  SYSTEM_SOURCES,
  SYSTEM_ASSIGNMENTS,
  load,
  list,
  find,
  assignmentFor,
  resolve,
  assign,
  validateDefinition,
  add,
  removeCustom,
};
