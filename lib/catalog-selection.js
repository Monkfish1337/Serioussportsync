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
  // 0.95.0 — "none" needs a state of its own.
  //
  // An empty `catalogs` array has always meant "all", which is the right
  // default for a new account and for a user who ticks everything. But it was
  // also what a user got by unticking every row: the save stored [] and the
  // next page load read it back as "all" and switched everything on again.
  // Turning every row off was the one selection the UI could not express.
  //
  // An explicit flag, rather than changing what [] means, because existing
  // installs have [] on disk meaning "all" and reinterpreting it would empty
  // every catalog on upgrade.
  if (cfg.catalogsNone === true) return new Set();
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
