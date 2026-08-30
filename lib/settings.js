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
const security = require('./security');

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
function endpoint(v, label) {
  const value = str(v);
  if (!value) return '';
  try { return security.cleanHttpUrl(value, { label }); }
  catch (err) {
    console.error('[settings] ignored unsafe ' + label + ': ' + security.safeErrorMessage(err));
    return '';
  }
}

// Effective values: stored override if present, else env default.
function getProwlarr() {
  const p = loadAll().prowlarr || {};
  return {
    url: endpoint(p.url, 'Prowlarr URL') || endpoint(config.prowlarr.url, 'Prowlarr URL'),
    apiKey: str(p.apiKey) || config.prowlarr.apiKey || '',
  };
}
function getZilean() {
  const z = loadAll().zilean || {};
  return { url: endpoint(z.url, 'Zilean URL') || endpoint(config.zilean.url, 'Zilean URL') };
}
function setProwlarr({ url, apiKey }) {
  const st = loadAll();
  st.prowlarr = { url: security.cleanHttpUrl(url, { label: 'Prowlarr URL' }), apiKey: str(apiKey) };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return st;
}

function setSources({ prowlarrUrl, prowlarrApiKey, zileanUrl }) {
  const st = loadAll();
  st.prowlarr = { url: security.cleanHttpUrl(prowlarrUrl, { label: 'Prowlarr URL' }), apiKey: str(prowlarrApiKey) };
  st.zilean = { url: security.cleanHttpUrl(zileanUrl, { label: 'Zilean URL' }) };
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
    url: endpoint(c.url, 'Companion URL') || endpoint(process.env.COMPANION_URL, 'Companion URL'),
    authToken: str(c.authToken) || (process.env.COMPANION_AUTH_TOKEN || ''),
  };
}

function setCompanion({ url, authToken }) {
  const st = loadAll();
  st.companion = { url: security.cleanHttpUrl(url, { label: 'Companion URL' }), authToken: str(authToken) };
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

function boundedNumber(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(label + ' must be between ' + minimum + ' and ' + maximum + '.');
  }
  return parsed;
}
function effectiveNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

// Runtime Smart Availability warmer settings. Stored values override the
// environment defaults and are read for every run, so the Database page can
// tune the scheduler without recreating the container.
function getAvailabilityWarm() {
  const stored = loadAll().availabilityWarm || {};
  const defaults = config.availabilityWarm || {};
  const defaultWindow = effectiveNumber(defaults.windowDays, 7, 1, 90);
  const defaultInterval = effectiveNumber(defaults.intervalHours, 6, 0.25, 168);
  const defaultMaximum = effectiveNumber(defaults.maxEventsPerRun, 25, 1, 500);
  const defaultDelay = effectiveNumber(defaults.startDelaySeconds, 60, 5, 3600);
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : defaults.enabled !== false,
    windowDays: Math.round(effectiveNumber(stored.windowDays, defaultWindow, 1, 90)),
    intervalHours: effectiveNumber(stored.intervalHours, defaultInterval, 0.25, 168),
    maxEventsPerRun: Math.round(effectiveNumber(stored.maxEventsPerRun, defaultMaximum, 1, 500)),
    startDelaySeconds: Math.round(effectiveNumber(stored.startDelaySeconds, defaultDelay, 5, 3600)),
  };
}

function setAvailabilityWarm(input) {
  const st = loadAll();
  st.availabilityWarm = {
    enabled: input && input.enabled === true,
    windowDays: Math.round(boundedNumber(input.windowDays, 'Window days', 1, 90)),
    intervalHours: boundedNumber(input.intervalHours, 'Interval hours', 0.25, 168),
    maxEventsPerRun: Math.round(boundedNumber(input.maxEventsPerRun, 'Events per run', 1, 500)),
    startDelaySeconds: Math.round(boundedNumber(input.startDelaySeconds, 'Start delay seconds', 5, 3600)),
  };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return getAvailabilityWarm();
}

function resetAvailabilityWarm() {
  const st = loadAll();
  delete st.availabilityWarm;
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return getAvailabilityWarm();
}

module.exports = {
  getProwlarr, setProwlarr, getZilean, setSources,
  getCompanion, setCompanion,
  getFootballData, setFootballData,
  getAvailabilityWarm, setAvailabilityWarm, resetAvailabilityWarm,
};
