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
const cryptoKeys = require('./crypto-keys');

const FILE = process.env.SETTINGS_FILE || './data/settings.json';
const SECRET_PATHS = [
  ['prowlarr', 'apiKey'],
  ['companion', 'authToken'],
  ['footballData', 'apiKey'],
];

function transformSecrets(state, transform) {
  const clone = JSON.parse(JSON.stringify(state || {}));
  for (const [section, field] of SECRET_PATHS) {
    if (clone[section] && clone[section][field]) {
      clone[section][field] = transform(String(clone[section][field]));
    }
  }
  return clone;
}

function writeRaw(state) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function loadAll() {
  try {
    if (!fs.existsSync(FILE)) return {};
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!j || typeof j !== 'object') return {};
    // Migrate legacy plaintext admin credentials as soon as settings are read.
    const needsMigration = SECRET_PATHS.some(([section, field]) =>
      j[section] && j[section][field] && !cryptoKeys.isEncrypted(j[section][field]));
    if (needsMigration) writeRaw(transformSecrets(j, cryptoKeys.encrypt));
    return transformSecrets(j, cryptoKeys.decrypt);
  } catch (err) {
    console.error('[settings] failed to load:', err.message);
    return {};
  }
}

function saveAll(state) {
  writeRaw(transformSecrets(state, cryptoKeys.encrypt));
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
function setProwlarr({ url, apiKey }) {
  const st = loadAll();
  st.prowlarr = { url: str(url), apiKey: str(apiKey) };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return st;
}

function setSources({ prowlarrUrl, prowlarrApiKey, zileanUrl }) {
  const st = loadAll();
  st.prowlarr = { url: str(prowlarrUrl), apiKey: str(prowlarrApiKey) };
  st.zilean = { url: str(zileanUrl) };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return st;
}

// 0.33.0: SeriousSportScraper companion service config.
// URL = the operator-deployed companion's base URL (e.g. http://scraper:8080).
// AUTH = optional shared bearer token for stopping random callers if the
// companion is internet-exposed. Both fields set via env or admin GUI.
function getCompanion() {
  const c = loadAll().companion || {};
  return {
    url: str(c.url) || (process.env.COMPANION_URL || ''),
    authToken: str(c.authToken) || (process.env.COMPANION_AUTH_TOKEN || ''),
  };
}

function setCompanion({ url, authToken }) {
  const st = loadAll();
  st.companion = { url: str(url), authToken: str(authToken) };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return st;
}

// 0.38.1: football-data.org API key. Admin override > env var default.
function getFootballData() {
  const f = loadAll().footballData || {};
  return {
    apiKey: str(f.apiKey) || config.footballData.apiKey || '',
  };
}

function setFootballData({ apiKey }) {
  const st = loadAll();
  st.footballData = { apiKey: str(apiKey) };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return st;
}

module.exports = {
  getProwlarr, setProwlarr, getZilean, setSources,
  getCompanion, setCompanion,
  getFootballData, setFootballData,
};
