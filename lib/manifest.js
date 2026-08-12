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

  // Advertise streams only when one of the current playback pipelines is
  // available: companion scraper, direct Prowlarr, direct Newznab, or per-user Easynews.
  const companion = settings.getCompanion();
  const prowlarr = settings.getProwlarr();
  const newsnab = settings.getNewsnab();
  const haveCompanion = !!(companion && companion.url);
  const haveProwlarr = !!(prowlarr.url && prowlarr.apiKey);
  const haveNewsnab = !!(newsnab.url && newsnab.apiKey);
  const haveEasynews = !!(userCfg && userCfg.easynewsUsername && userCfg.easynewsPassword);
  const streamEnabled = haveCompanion || haveProwlarr || haveNewsnab || haveEasynews;

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

  const baseOrigin = (opts.origin || config.publicUrl || '').replace(/\/+$/, '');
  const logo       = baseOrigin ? (baseOrigin + '/assets/logo.png')        : config.logo;
  const background = baseOrigin ? (baseOrigin + '/assets/logo-banner.png') : config.background;

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
    logo,
    background,
  };
}

module.exports = { buildManifest };
