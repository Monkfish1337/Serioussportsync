const config = require('../config');
const promotions = require('./promotions');
const settings = require('./settings');
const APP_VERSION = require('../package.json').version || '0.0.0';

// Stremio addon manifest.
// Catalogs and idPrefixes derive from the enabled promotions registry, so
// adding a new promotion auto-expands the manifest. When called with
// `opts.user`, the user's stored debrid keys + catalog selection filter
// the result (Phase 2 multi-tenant).
function buildManifest(opts) {
  opts = opts || {};
  const userCfg = (opts.user && opts.user.config) || null;

  const envDebrid = !!(config.realDebrid.token || config.torbox.token || config.premiumize.apiKey);
  const userDebrid = !!(userCfg && (userCfg.rd || userCfg.tb || userCfg.pm));
  const anyDebrid = envDebrid || userDebrid;
  // Streams are advertised when there's a debrid AND at least one indexer
  // source (Prowlarr or Zilean) configured — read live from settings.
  const pw = settings.getProwlarr();
  const haveSource = !!((pw.url && pw.apiKey) || settings.getZilean().url);
  const streamEnabled = !!(anyDebrid && haveSource);

  const idPrefixes = promotions.enabled.map((p) => p.idPrefix + ':');

  const resources = [
    { name: 'catalog', types: [config.addonType], idPrefixes },
    { name: 'meta',    types: [config.addonType], idPrefixes },
  ];
  if (streamEnabled) {
    resources.push({ name: 'stream', types: [config.addonType], idPrefixes });
  }

  const allCatalogs = [];
  for (const p of promotions.enabled) {
    for (const c of p.catalogs) {
      allCatalogs.push({
        type: config.addonType,
        id: c.id,
        name: c.name,
        extra: [{ name: 'search' }, { name: 'skip' }],
      });
    }
  }
  const selected = (userCfg && Array.isArray(userCfg.catalogs)) ? userCfg.catalogs : [];
  const catalogs = (selected.length > 0)
    ? allCatalogs.filter((c) => selected.includes(c.id))
    : allCatalogs;

  return {
    id: config.addonId,
    version: APP_VERSION,
    name: config.addonName,
    description: config.addonDescription,
    types: [config.addonType],
    catalogs,
    resources,
    idPrefixes,
    behaviorHints: { configurable: false, configurationRequired: false },
    logo: config.logo,
    background: config.background,
  };
}

module.exports = { buildManifest };
