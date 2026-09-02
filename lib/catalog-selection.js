'use strict';

// Catalogs introduced after users may already have saved an explicit
// allow-list. Apply each addition once as a default, then let the next account
// save persist the user's actual checked/unchecked choice at the new version.
const CURRENT_DEFAULTS_VERSION = 2;
const ADDITIONS = [
  { version: 1, ids: ['manutd-upcoming', 'manutd-recent'] },
  { version: 2, ids: ['mlb-upcoming', 'mlb-recent'] },
];

function effectiveCatalogSelection(userConfig) {
  const cfg = userConfig || {};
  const saved = Array.isArray(cfg.catalogs) ? cfg.catalogs : [];
  // Empty is the existing storage convention for "all catalogs".
  if (saved.length === 0) return null;

  const selected = new Set(saved);
  const savedVersion = Math.max(0, parseInt(cfg.catalogDefaultsVersion, 10) || 0);
  for (const addition of ADDITIONS) {
    if (savedVersion < addition.version) {
      for (const id of addition.ids) selected.add(id);
    }
  }
  return selected;
}

module.exports = { effectiveCatalogSelection, CURRENT_DEFAULTS_VERSION };
