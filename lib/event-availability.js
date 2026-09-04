'use strict';

// "Is there known content for this event?" — the question the catalog
// availability gate asks.
//
// Why this exists as its own module: the answer lives in two unrelated places.
// The SQLite availability index knows every event a release has ever been
// stored against (TorBox, Prowlarr, Usenet Ultimate, Easynews, the DIY lane).
// Sport-Video keeps its own JSON state, where each discovered release carries
// the event ids it matched. Neither knows about the other, and a catalog
// request cannot afford to consult both per event.
//
// So this builds one merged Set and caches it. The gate is deliberately
// scope-blind: availability in the index is per provider and per credential
// scope, but "this fixture has content somewhere" is a property of the event,
// not of one viewer's account. Answering it per-user would mean a SQLite query
// on every catalog request for a distinction the catalog does not draw.

const REFRESH_MS = 60000;

let cached = null;
let cachedAt = 0;
let cachedError = null;

function fromIndex(indexModule) {
  try {
    const index = indexModule.getDefault();
    if (!index || typeof index.eventIdsWithReleases !== 'function') return new Set();
    return index.eventIdsWithReleases();
  } catch (error) {
    // A missing or unreadable database must not empty every catalog. The gate
    // fails open: callers treat a null snapshot as "gate unavailable".
    cachedError = error;
    return null;
  }
}

function fromSportVideo(sportVideoModule) {
  const out = new Set();
  try {
    const state = sportVideoModule.load();
    for (const record of (state && Array.isArray(state.releases) ? state.releases : [])) {
      for (const match of (record && Array.isArray(record.matches) ? record.matches : [])) {
        if (match && match.eventId) out.add(String(match.eventId));
      }
    }
  } catch (error) {
    cachedError = error;
  }
  return out;
}

function build(opts) {
  const options = opts || {};
  cachedError = null;
  const indexModule = options.availabilityIndex || require('./availability-index');
  const sportVideoModule = options.sportVideo || require('./sources/sport-video');

  const indexed = fromIndex(indexModule);
  const scraped = fromSportVideo(sportVideoModule);
  // A null from the index means it could not be read at all. With nothing but
  // Sport-Video's view, a gate would hide almost everything, so report no
  // snapshot rather than a misleadingly small one.
  if (indexed === null && scraped.size === 0) return null;
  const merged = new Set(indexed || []);
  for (const id of scraped) merged.add(id);
  return merged;
}

// A Set of every event id with known content, or null when it could not be
// determined. Cached for REFRESH_MS: the underlying data changes on a scan or
// a warm, not per request.
function snapshot(opts) {
  const options = opts || {};
  const now = typeof options.now === 'number' ? options.now : Date.now();
  if (!options.force && cached && (now - cachedAt) < REFRESH_MS) return cached;
  cached = build(options);
  cachedAt = now;
  return cached;
}

function has(eventId) {
  const set = snapshot();
  // No snapshot means the gate cannot answer, and a gate that cannot answer
  // must not hide anything.
  if (!set) return true;
  return set.has(String(eventId || ''));
}

function invalidate() { cached = null; cachedAt = 0; }

function lastError() { return cachedError; }

function stats() {
  const set = snapshot();
  return { available: set ? set.size : null, error: cachedError ? cachedError.message : null };
}

// What enabling the gate would actually do, per promotion. Turning a gate on
// blind is how an operator ends up with empty catalogs and no idea why, so the
// admin page shows this before the switch rather than after.
function coverage(opts) {
  const options = opts || {};
  const store = options.store || require('./store');
  const available = options.available !== undefined ? options.available : snapshot();
  const today = (options.today || new Date().toISOString().slice(0, 10));
  const byPromotion = new Map();
  let total = 0;
  let covered = 0;
  for (const event of (store.getEvents() || [])) {
    if (!event || !event.id) continue;
    const promotion = String(event.promotion || '');
    if (!byPromotion.has(promotion)) {
      byPromotion.set(promotion, { promotion, total: 0, covered: 0, upcoming: 0 });
    }
    const row = byPromotion.get(promotion);
    row.total += 1;
    total += 1;
    const hit = available ? available.has(event.id) : false;
    if (hit) { row.covered += 1; covered += 1; }
    else if (event.date && event.date > today) row.upcoming += 1;
  }
  return {
    available: available ? available.size : null,
    total,
    covered,
    promotions: Array.from(byPromotion.values()).sort((a, b) => b.total - a.total),
  };
}

module.exports = { snapshot, has, invalidate, stats, coverage, lastError, build, REFRESH_MS };
