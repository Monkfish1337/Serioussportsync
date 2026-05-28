const config = require('../config');
const store = require('./store');
const transform = require('./transform');
const promotions = require('./promotions');

const PAGE_SIZE = 50;

// Build a fast lookup: catalog id -> { promotion, def }
const catalogIndex = (() => {
  const idx = new Map();
  for (const p of promotions.enabled) {
    for (const c of p.catalogs) {
      idx.set(c.id, { promotion: p, def: c });
    }
  }
  return idx;
})();

// Per-promotion event visibility: lets each promotion drop events it never
// wants to surface (e.g. UFC's Contender Series).
function eventVisible(ev) {
  const p = promotions.byPrefix[ev.promotion] || promotions.getByEventId(ev.id);
  if (!p) return true;
  return p.includeEvent ? p.includeEvent(ev, config) : true;
}

function applySearch(events, query) {
  if (!query) return events;
  const q = query.trim().toLowerCase();
  if (!q) return events;
  return events.filter((ev) => {
    if (ev.name && ev.name.toLowerCase().includes(q)) return true;
    if (ev.aliases && ev.aliases.some((a) => a.toLowerCase().includes(q))) return true;
    if (ev.venue && ev.venue.toLowerCase().includes(q)) return true;
    if (ev.city && ev.city.toLowerCase().includes(q)) return true;
    return false;
  });
}

function handleCatalog({ type, id, extra = {} }) {
  if (type !== config.addonType) return { metas: [] };
  const entry = catalogIndex.get(id);
  if (!entry) return { metas: [] };

  const { promotion, def } = entry;

  // Restrict to events that belong to this promotion AND pass its visibility filter.
  // Backward compat: legacy events on disk may lack ev.promotion. Fall
  // back to id-prefix matching so existing UFC events keep working.
  function evBelongs(ev) {
    if (ev.promotion) return ev.promotion === promotion.id;
    return typeof ev.id === 'string' && ev.id.startsWith(promotion.idPrefix + ':');
  }
  let pool = store.getEvents().filter((ev) => evBelongs(ev) && eventVisible(ev));

  // Apply the catalog's own filter + sort.
  if (def.filter) pool = pool.filter(def.filter);
  if (def.sort) pool.sort(def.sort);

  pool = applySearch(pool, extra.search);

  const skip = parseInt(extra.skip, 10) || 0;
  const page = pool.slice(skip, skip + PAGE_SIZE);
  return { metas: page.map(transform.toCatalogMeta) };
}

module.exports = { handleCatalog };
