// Global (server-wide) runtime settings.
//
// Currently holds the indexer/source endpoints, which are far nicer to set in
// the admin GUI than via compose/env. Stored in data/settings.json. The env
// vars (config.prowlarr / config.zilean) act as the DEFAULT / bootstrap value;
// anything saved here OVERRIDES the corresponding env. Read live on each
// request, so changes in the admin panel take effect without a restart.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = process.env.SETTINGS_FILE || './data/settings.json';

function loadAll() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch (err) {
    console.error('[settings] failed to load:', err.message);
    return {};
  }
}

function saveAll(state) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

// Effective values: stored override if present, else env default.
function getProwlarr() {
  const p = loadAll().prowlarr || {};
  return {
    url: str(p.url) || config.prowlarr.url || '',
    apiKey: str(p.apiKey) || config.prowlarr.apiKey || '',
  };
}
function getZilean() {
  const z = loadAll().zilean || {};
  return { url: str(z.url) || config.zilean.url || '' };
}

function setSources({ prowlarrUrl, prowlarrApiKey, zileanUrl }) {
  const st = loadAll();
  st.prowlarr = { url: str(prowlarrUrl), apiKey: str(prowlarrApiKey) };
  st.zilean = { url: str(zileanUrl) };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return st;
}

module.exports = { getProwlarr, getZilean, setSources };
