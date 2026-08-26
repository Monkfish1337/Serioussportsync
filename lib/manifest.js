const config = require('../config');
const promotions = require('./promotions');
const settings = require('./settings');
const { orderByIds } = require('./catalog-order');
const { effectiveCatalogSelection } = require('./catalog-selection');
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
  // available: torrent discovery, per-user Usenet Ultimate, or per-user Easynews.
  const companion = settings.getCompanion();
  const prowlarr = settings.getProwlarr();
  const haveCompanion = !!(companion && companion.url);
  const haveProwlarr = !!(prowlarr.url && prowlarr.apiKey);
  const haveUU = !!(userCfg && userCfg.uuManifestUrl);
  const haveEasynews = !!(userCfg && userCfg.easynewsUsername && userCfg.easynewsPassword);
  const haveTorrent = !!((!userCfg || userCfg.torboxEnabled !== false) && (haveCompanion || haveProwlarr));
  const haveUuRows = !!(userCfg && userCfg.uuEnabled !== false && haveUU);
  const haveEasynewsRows = !!(userCfg && userCfg.easynewsEnabled !== false && haveEasynews);
  const haveNativeUsenetSearch = !!(userCfg && userCfg.diyNativeSearchEnabled === true
    && userCfg.diySearchUrl && userCfg.diySearchApiKey);
  // DIY playback can use native search, UU search, or both independently of UU rows.
  const haveDiyUsenet = !!(userCfg && userCfg.diyUsenetEnabled === true
    && (haveNativeUsenetSearch || (userCfg.diyUuSearchEnabled !== false && haveUU)));
  const streamEnabled = haveTorrent || haveUuRows || haveEasynewsRows || haveDiyUsenet;

  const orderedPromotions = orderByIds(
    promotions.enabled,
    userCfg && userCfg.promotionOrder,
    (p) => p.id
  );
  const idPrefixes = orderedPromotions.map((p) => p.idPrefix + ':');

  const resources = [
    { name: 'catalog', types: [config.addonType], idPrefixes },
    { name: 'meta',    types: [config.addonType], idPrefixes },
  ];
  if (streamEnabled) {
    resources.push({ name: 'stream', types: [config.addonType], idPrefixes });
  }

  const allCatalogs = [];
  const showInHome = !(userCfg && userCfg.showCatalogsOnHome === false);
  for (const p of orderedPromotions) {
    const orderedCatalogs = orderByIds(p.catalogs, userCfg && userCfg.catalogOrder, (c) => c.id);
    for (const c of orderedCatalogs) {
      allCatalogs.push({
        type: config.addonType,
        id: c.id,
        name: c.name,
        // Nuvio uses this extension to hide a registered catalog from Home
        // without making addon-backed collection folders lose their source.
        showInHome,
        // Nuvio Desktop currently ignores showInHome and builds Home from
        // catalogs whose extras are all optional. Making the existing search
        // extra required hides this descriptor from Desktop Home while its
        // collection resolver can still find it by addon/type/catalog ID.
        extra: [
          { name: 'search', ...(showInHome ? {} : { isRequired: true }) },
          { name: 'skip' },
        ],
      });
    }
  }
  const selected = effectiveCatalogSelection(userCfg);
  const catalogs = selected
    ? allCatalogs.filter((c) => selected.has(c.id))
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
