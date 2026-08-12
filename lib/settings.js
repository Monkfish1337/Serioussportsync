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
// 0.30.0: Newsnab-compatible NZB indexer config.
function getNewsnab() {
  const n = loadAll().newsnab || {};
  // Categories can come in as a string from the admin form ("5000,5080") OR
  // an array from settings.json — normalise to an array of trimmed strings.
  let cats = n.categories;
  if (typeof cats === 'string') cats = cats.split(',').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(cats) || cats.length === 0) cats = config.newsnab.categories || ['5000', '5080', '8000'];

  // 0.42.11 — expose multi-endpoint list. If admin overrode URL/apiKey in
  // /admin, that's the single endpoint. Otherwise fall through to the env-
  // driven CSV endpoints from config.newsnab.endpoints (nzbgeek + usenet-
  // crawler + …). Without this, newsnab.js's multi-endpoint fan-out silently
  // fell back to first URL only and later endpoints were never queried.
  const adminUrl = str(n.url);
  const adminKey = str(n.apiKey);
  let endpoints;
  if (adminUrl && adminKey) {
    endpoints = [{ url: adminUrl, apiKey: adminKey }];
  } else {
    endpoints = Array.isArray(config.newsnab.endpoints) ? config.newsnab.endpoints.slice() : [];
  }

  return {
    url: adminUrl || (endpoints[0] && endpoints[0].url) || '',
    apiKey: adminKey || (endpoints[0] && endpoints[0].apiKey) || '',
    endpoints,
    categories: cats.map(String),
  };
}

function setProwlarr({ url, apiKey }) {
  const st = loadAll();
  st.prowlarr = { url: str(url), apiKey: str(apiKey) };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return st;
}

function setSources({ prowlarrUrl, prowlarrApiKey, zileanUrl, newsnabUrl, newsnabApiKey, newsnabCategories }) {
  const st = loadAll();
  st.prowlarr = { url: str(prowlarrUrl), apiKey: str(prowlarrApiKey) };
  st.zilean = { url: str(zileanUrl) };
  // Only overwrite newsnab if any of its fields was provided — preserves the
  // existing stored values when the admin form omits them.
  if (newsnabUrl !== undefined || newsnabApiKey !== undefined || newsnabCategories !== undefined) {
    st.newsnab = {
      url: str(newsnabUrl),
      apiKey: str(newsnabApiKey),
      categories: str(newsnabCategories),
    };
  }
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
  getProwlarr, setProwlarr, getZilean, getNewsnab, setSources,
  getCompanion, setCompanion,
  getFootballData, setFootballData,
};
