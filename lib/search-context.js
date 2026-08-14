const config = require('../config');
const store = require('./store');
const promotions = require('./promotions');

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const title = String(value || '').trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

// Machine-readable event context for trusted aggregator integrations such as
// AIOStreams. The endpoint deliberately accepts only an existing SSS event ID;
// it is not an arbitrary search proxy and contains no user service credentials.
function handleSearchContext({ type, id }) {
  if (type !== config.addonType) return null;

  const event = store.getEvent(id);
  if (!event) return null;

  const promotion = promotions.getByEventId(id);
  if (!promotion || typeof promotion.searchTitles !== 'function') return null;

  const searchTitles = uniqueStrings([
    ...(promotion.searchTitles(event) || []),
    ...(event.searchAliases || []),
    ...(event.aliases || []),
    event.name,
  ]);
  const date = event.dateLocal || event.date || null;
  const year = date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;

  return {
    version: 1,
    id: event.id,
    type: config.addonType,
    title: event.name,
    searchTitles,
    date,
    year,
    promotion: event.promotion || promotion.id,
    sport: event.sport || promotion.sport || null,
    country: event.country || null,
  };
}

module.exports = { handleSearchContext };
