'use strict';

const config = require('../config');
const promotions = require('./promotions');
const { orderByIds } = require('./catalog-order');
const { effectiveCatalogSelection } = require('./catalog-selection');
const collectionSettings = require('./nuvio-collection-settings');

// Stable IDs let Nuvio recognise a regenerated SSS template as the same
// collection instead of creating fresh duplicates on every import.
const COLLECTION_ID = collectionSettings.COLLECTION_ID;
const FOLDERS = collectionSettings.DEFAULT_FOLDERS;

function fullSource(catalogId) {
  return {
    type: config.addonType,
    genre: null,
    title: null,
    sortBy: null,
    tmdbId: null,
    addonId: config.addonId,
    filters: null,
    sortHow: null,
    provider: 'addon',
    catalogId,
    mediaType: null,
    traktListId: null,
    tmdbSourceType: null,
  };
}

function compactSource(catalogId) {
  return {
    type: config.addonType,
    genre: null,
    addonId: config.addonId,
    catalogId,
  };
}

function publicImageUrl(value, origin) {
  const image = String(value || '').trim();
  if (!image) return null;
  if (image.startsWith('/assets/')) return origin ? origin + image : null;
  return image;
}

function resolveFolderArtwork(folder, promotionById, origin) {
  let artwork = folder.artwork;
  if (artwork === 'promotion') {
    artwork = '';
    for (const promotionId of folder.promotions || []) {
      const promotion = promotionById.get(promotionId);
      const defaults = promotion && promotion.defaults || {};
      artwork = defaults.fanart || defaults.poster || defaults.logo || '';
      if (artwork) break;
    }
    if (!artwork) artwork = '/assets/logo-banner.png';
  }
  return publicImageUrl(artwork, origin);
}

function buildNuvioCollections(opts) {
  opts = opts || {};
  const cfg = (opts.user && opts.user.config) || {};
  const origin = String(opts.origin || '').replace(/\/+$/, '');
  const selected = effectiveCatalogSelection(cfg);
  const orderedPromotions = orderByIds(promotions.enabled, cfg.promotionOrder, (p) => p.id);
  const promotionById = new Map(orderedPromotions.map((p) => [p.id, p]));
  const layout = collectionSettings.load();

  const folders = layout.folders.map((folder) => {
    const catalogIds = [];
    // Respect the user's promotion order within each sports folder.
    for (const p of orderedPromotions) {
      if (!folder.promotions.includes(p.id)) continue;
      const catalogs = orderByIds(p.catalogs, cfg.catalogOrder, (c) => c.id);
      for (const c of catalogs) {
        if (!selected || selected.has(c.id)) catalogIds.push(c.id);
      }
    }
    // Defensive check for registry changes while preserving folder definitions.
    if (!folder.promotions.some((id) => promotionById.has(id))) return null;
    if (catalogIds.length === 0) return null;
    const artworkUrl = resolveFolderArtwork(folder, promotionById, origin);
    return {
      id: folder.id,
      title: folder.title,
      sources: catalogIds.map(fullSource),
      hideTitle: folder.hideTitle === true,
      tileShape: folder.tileShape || 'landscape',
      coverEmoji: null,
      focusGifUrl: null,
      heroVideoUrl: null,
      titleLogoUrl: null,
      coverImageUrl: artworkUrl,
      catalogSources: catalogIds.map(compactSource),
      focusGifEnabled: false,
      heroBackdropUrl: artworkUrl,
    };
  }).filter(Boolean);

  return [{
    id: COLLECTION_ID,
    title: layout.collection.title,
    folders,
    pinToTop: layout.collection.pinToTop === true,
    viewMode: layout.collection.viewMode || 'ROWS',
    showAllTab: layout.collection.showAllTab !== false,
    backdropImageUrl: publicImageUrl(layout.collection.backdropImage, origin),
  }];
}

module.exports = { buildNuvioCollections, COLLECTION_ID, FOLDERS, publicImageUrl, resolveFolderArtwork };
