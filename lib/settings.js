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
  ['apiFootball', 'apiKey'],
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

// Effective values: an omitted stored field inherits the deployment default;
// an explicitly saved empty field intentionally disables it.  This distinction
// matters for optional discovery sources: operators must be able to turn off a
// compose-provided Companion or Prowlarr endpoint from the Server page.
// Form checkboxes submit "1"/"on" when ticked and nothing at all when not, so
// an absent value has to be distinguishable from an explicit false. Callers
// pass undefined to mean "leave as-is".
function flag(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (value === '0' || value === 'false' || value === false) return false;
  return value === true || value === '1' || value === 'on' || value === 'true';
}

function getProwlarr() {
  const p = loadAll().prowlarr || {};
  return {
    url: Object.prototype.hasOwnProperty.call(p, 'url')
      ? endpoint(p.url, 'Prowlarr URL') : endpoint(config.prowlarr.url, 'Prowlarr URL'),
    apiKey: Object.prototype.hasOwnProperty.call(p, 'apiKey')
      ? str(p.apiKey) : (config.prowlarr.apiKey || ''),
    // Absent means enabled: settings saved before the toggle existed must keep
    // working exactly as they did.
    enabled: p.enabled !== false,
  };
}
function getZilean() {
  const z = loadAll().zilean || {};
  return { url: endpoint(z.url, 'Zilean URL') || endpoint(config.zilean.url, 'Zilean URL') };
}
// 0.95.0: direct Bitmagnet integration. One URL, same shape as the Prowlarr
// and Zilean settings — the operator points at their own Bitmagnet instance
// and no database credentials are involved.
function getBitmagnet() {
  const b = loadAll().bitmagnet || {};
  const num = (value, fallback) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    url: Object.prototype.hasOwnProperty.call(b, 'url')
      ? endpoint(b.url, 'Bitmagnet URL') : endpoint(process.env.BITMAGNET_URL, 'Bitmagnet URL'),
    limit: num(b.limit, num(process.env.BITMAGNET_LIMIT, 300)),
    concurrency: num(b.concurrency, 4),
    timeoutMs: num(b.timeoutMs, 15000),
    videoOnly: b.videoOnly === true,
    enabled: b.enabled !== false,
  };
}

function setBitmagnet({ url, limit, concurrency, timeoutMs, videoOnly, enabled }) {
  const st = loadAll();
  const previous = st.bitmagnet || {};
  const num = (value) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  st.bitmagnet = {
    url: security.cleanHttpUrl(url, { label: 'Bitmagnet URL' }),
    limit: num(limit),
    concurrency: num(concurrency),
    timeoutMs: num(timeoutMs),
    videoOnly: flag(videoOnly, false),
    enabled: flag(enabled, previous.enabled !== false),
  };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return st;
}

function setProwlarr({ url, apiKey, enabled }) {
  const st = loadAll();
  const previous = st.prowlarr || {};
  st.prowlarr = {
    url: security.cleanHttpUrl(url, { label: 'Prowlarr URL' }),
    apiKey: str(apiKey),
    enabled: flag(enabled, previous.enabled !== false),
  };
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
    url: Object.prototype.hasOwnProperty.call(c, 'url')
      ? endpoint(c.url, 'Companion URL') : endpoint(process.env.COMPANION_URL, 'Companion URL'),
    authToken: Object.prototype.hasOwnProperty.call(c, 'authToken')
      ? str(c.authToken) : (process.env.COMPANION_AUTH_TOKEN || ''),
    enabled: c.enabled !== false,
  };
}

function setCompanion({ url, authToken, enabled }) {
  const st = loadAll();
  const previous = st.companion || {};
  st.companion = {
    url: security.cleanHttpUrl(url, { label: 'Companion URL' }),
    authToken: str(authToken),
    enabled: flag(enabled, previous.enabled !== false),
  };
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

function getApiFootball() {
  const value = loadAll().apiFootball || {};
  return { apiKey: str(value.apiKey) || config.apiFootball.apiKey || '' };
}

function setApiFootball({ apiKey }) {
  const st = loadAll();
  st.apiFootball = { apiKey: str(apiKey) };
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
  const defaultWindow = effectiveNumber(defaults.windowDays, 3, 1, 90);
  const defaultInterval = effectiveNumber(defaults.intervalHours, 6, 0.25, 168);
  const defaultMaximum = effectiveNumber(defaults.maxEventsPerRun, 25, 1, 500);
  const defaultDelay = effectiveNumber(defaults.startDelaySeconds, 60, 5, 3600);
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : defaults.enabled !== false,
    serveConfirmed: typeof stored.serveConfirmed === 'boolean'
      ? stored.serveConfirmed : defaults.serveConfirmed !== false,
    prepareTorrent: typeof stored.prepareTorrent === 'boolean'
      ? stored.prepareTorrent : defaults.prepareTorrent !== false,
    prepareUsenet: typeof stored.prepareUsenet === 'boolean'
      ? stored.prepareUsenet : defaults.prepareUsenet === true,
    prepareEasynews: typeof stored.prepareEasynews === 'boolean'
      ? stored.prepareEasynews : defaults.prepareEasynews === true,
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
    serveConfirmed: !input || input.serveConfirmed !== false,
    prepareTorrent: !input || input.prepareTorrent !== false,
    prepareUsenet: Boolean(input && input.prepareUsenet === true),
    prepareEasynews: Boolean(input && input.prepareEasynews === true),
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

// Team names come from the catalog, so they are provider text rather than a
// closed vocabulary. Bound the size and drop empties; an empty list for a
// promotion is stored as absent so "no filter" has exactly one representation.
function normaliseTeamFilters(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [promotionId, value] of Object.entries(input)) {
    const key = String(promotionId || '').trim().slice(0, 64);
    if (!key) continue;
    const teams = [].concat(value || [])
      .map((name) => String(name || '').trim().slice(0, 120))
      .filter((name, index, all) => name && all.indexOf(name) === index)
      .slice(0, 200);
    if (teams.length) out[key] = teams;
  }
  return out;
}

const SPORT_VIDEO_CATEGORIES = Object.freeze([
  'americanfootball', 'basketball', 'baseball', 'football', 'hockey', 'rugby', 'other',
]);

// Sport-Video is opt-in because enabling it introduces a third-party direct
// torrent catalogue. Discovery remains read-only; warming is always a
// deliberate per-release action performed with the current user's TorBox key.
function getSportVideo() {
  const stored = loadAll().sportVideo || {};
  const categories = Array.isArray(stored.categories)
    ? stored.categories.filter((value) => SPORT_VIDEO_CATEGORIES.includes(value)) : [];
  return {
    enabled: stored.enabled === true,
    autoScan: stored.autoScan !== false,
    intervalHours: effectiveNumber(stored.intervalHours, 6, 1, 168),
    startDelaySeconds: Math.round(effectiveNumber(stored.startDelaySeconds, 90, 10, 3600)),
    maxDetailsPerScan: Math.round(effectiveNumber(stored.maxDetailsPerScan, 50, 1, 200)),
    // 0.81.1: the per-sport catalogue pages only expose a short recent window
    // (roughly 300 releases in total). The dated archive index carries the
    // rest, so a bounded number of its newest pages is walked on every scan.
    archivePages: Math.round(effectiveNumber(stored.archivePages, 12, 0, 60)),
    // Opt-in automatic TorBox warming, named per promotion. Empty means every
    // warm stays a deliberate click, which is the default.
    autoWarmPromotions: Array.isArray(stored.autoWarmPromotions)
      ? stored.autoWarmPromotions.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 40)
      : [],
    autoWarmPerScan: Math.round(effectiveNumber(stored.autoWarmPerScan, 5, 1, 50)),
    // TorBox keeps a cached copy for at least 30 days, so re-preparing and
    // re-warming fixtures older than this buys nothing: either the release is
    // still cached and needs no warming, or it has aged out and nobody is
    // watching it. Automatic work stops at this age; manual buttons do not.
    autoWarmWindowDays: Math.round(effectiveNumber(stored.autoWarmWindowDays, 14, 1, 90)),
    // Narrow the expensive half of the pipeline to named sides, per promotion.
    // MLB alone is ~2,400 fixtures a season and Champions League is a whole
    // competition; preparing every one of them spends detail fetches and TorBox
    // quota on games nobody asked for. Shape: { promotionId: [team, ...] }.
    // A promotion absent from this map, or present with an empty list, is not
    // filtered at all — which is how boxing, UFC and anything else without a
    // recurring line-up keeps working untouched.
    teamFilters: normaliseTeamFilters(stored.teamFilters),
    categories: categories.length ? categories : SPORT_VIDEO_CATEGORIES.slice(),
  };
}

// 0.95.0 — save some of the Sport-Video settings without submitting all of them.
//
// setSportVideo replaces the whole object and rejects a save with no
// categories — quite rightly, since a scan with nothing to scan is a mis-filled
// form. But that made every Sport-Video field unreachable from anywhere except
// that one page's full form, which is why the Server page carried enable
// toggles for three discovery sources and silently omitted the fourth.
//
// This merges a patch over what is stored and validates the result, so the
// Server page can own the pipeline settings (does it run, how often, which
// sports) while the Sport-Video page keeps the per-promotion operational ones
// (team filters, auto-warm) that are drawn from the promotion list.
function updateSportVideo(patch) {
  const current = getSportVideo();
  const merged = Object.assign({}, current, patch || {});
  return setSportVideo(merged);
}

function setSportVideoEnabled(enabled) {
  // A switch is the one field that must never be blocked by the validity of
  // some other field: "turn this off" has to work even if what is stored is
  // half-configured.
  const st = loadAll();
  st.sportVideo = Object.assign({}, st.sportVideo || {}, { enabled: Boolean(enabled) });
  saveAll(st);
  return getSportVideo();
}

function setSportVideo(input) {
  const categories = [].concat(input && input.categories || [])
    .map((value) => String(value || '').trim())
    .filter((value, index, values) => SPORT_VIDEO_CATEGORIES.includes(value) && values.indexOf(value) === index);
  if (!categories.length) throw new Error('Select at least one Sport-Video category.');
  const st = loadAll();
  st.sportVideo = {
    enabled: Boolean(input && input.enabled === true),
    autoScan: Boolean(input && input.autoScan === true),
    intervalHours: boundedNumber(input.intervalHours, 'Scan interval', 1, 168),
    startDelaySeconds: Math.round(boundedNumber(input.startDelaySeconds, 'Startup delay', 10, 3600)),
    maxDetailsPerScan: Math.round(boundedNumber(input.maxDetailsPerScan, 'Prepared releases per scan', 1, 200)),
    archivePages: Math.round(boundedNumber(
      input.archivePages === undefined || input.archivePages === '' ? 12 : input.archivePages,
      'Archive pages per scan', 0, 60)),
    autoWarmPromotions: [].concat(input && input.autoWarmPromotions || [])
      .map((value) => String(value || '').trim())
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .slice(0, 40),
    autoWarmPerScan: Math.round(boundedNumber(
      input.autoWarmPerScan === undefined || input.autoWarmPerScan === '' ? 5 : input.autoWarmPerScan,
      'Auto-warm releases per scan', 1, 50)),
    autoWarmWindowDays: Math.round(boundedNumber(
      input.autoWarmWindowDays === undefined || input.autoWarmWindowDays === '' ? 14 : input.autoWarmWindowDays,
      'Automatic window', 1, 90)),
    teamFilters: normaliseTeamFilters(input && input.teamFilters),
    categories,
  };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return getSportVideo();
}

// Log-console preferences are deliberately server-wide: the admin log is a
// view of one shared process, so per-account verbosity would be misleading.
// Rejection detail is sampled by default and can be temporarily expanded from
// the Logs page without rebuilding the container or editing an env file.
function getLogPreferences() {
  const stored = loadAll().logs || {};
  return {
    detailedRejections: typeof stored.detailedRejections === 'boolean'
      ? stored.detailedRejections
      : /^(1|true|yes|on)$/i.test(String(process.env.LOG_EXCLUDED_TITLES || '')),
  };
}

function setLogPreferences(input) {
  const st = loadAll();
  st.logs = { detailedRejections: Boolean(input && input.detailedRejections) };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return getLogPreferences();
}

// Catalog availability gate. Off by default: turning it on visibly changes
// what every client sees, and a deployment whose availability data is thin
// would find its catalogs mostly empty with no obvious cause. The operator
// enables it once they can see the numbers.
function getCatalogGate() {
  const stored = loadAll().catalogGate || {};
  return {
    enabled: stored.enabled === true,
    // Upcoming fixtures are a schedule as much as a library. Keeping them is
    // the middle ground for an operator who wants Recent cleaned up without
    // losing the view of what is coming.
    keepUpcoming: stored.keepUpcoming === true,
  };
}

function setCatalogGate(input) {
  const st = loadAll();
  st.catalogGate = {
    enabled: Boolean(input && input.enabled),
    keepUpcoming: Boolean(input && input.keepUpcoming),
  };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return getCatalogGate();
}

// Admin appearance. A skin is a small set of CSS variables layered over the
// vendored Tabler stylesheet — see lib/skins.js for what it can and cannot
// change, and why a font picker is not on the list.
function getAppearance() {
  const skins = require('./skins');
  const stored = loadAll().appearance || {};
  return { skin: skins.isKnown(stored.skin) ? String(stored.skin) : skins.DEFAULT_SKIN };
}

function setAppearance(input) {
  const skins = require('./skins');
  const requested = String((input && input.skin) || '').trim().toLowerCase();
  if (!skins.isKnown(requested)) throw new Error('Unknown skin: ' + (requested || '(none)'));
  const st = loadAll();
  st.appearance = { skin: requested };
  st.updatedAt = new Date().toISOString();
  saveAll(st);
  return getAppearance();
}

module.exports = {
  getAppearance, setAppearance,
  getCatalogGate, setCatalogGate,
  getProwlarr, setProwlarr, getZilean, setSources,
  getBitmagnet, setBitmagnet,
  getCompanion, setCompanion,
  getFootballData, setFootballData,
  getApiFootball, setApiFootball,
  getAvailabilityWarm, setAvailabilityWarm, resetAvailabilityWarm,
  getSportVideo, setSportVideo, setSportVideoEnabled, updateSportVideo, SPORT_VIDEO_CATEGORIES,
  getLogPreferences, setLogPreferences,
};
